/**
 * AppGoblin job pipeline.
 *
 * Parallel path to affplusPipeline.ts. For an AppGoblin job:
 *
 *   1. Read the discovery axis from job.source_params:
 *        { category, adNetworkDomain }
 *      The UI guarantees at least one is set. Both modes are documented
 *      in appgoblinScraper.ts.
 *   2. Call scrapeAppgoblin() — plain fetch against /__data.json endpoints,
 *      no browser. Returns AppgoblinApp records (name, store_link, store_id,
 *      developer_name, company_domain, etc.).
 *   3. Emit ONE job_results row per app, in the mobile CSV shape:
 *        - store_url       ← app.store_link  (already a valid Play/iTunes URL)
 *        - classification  ← derived from app.store ("Apple App Store" / "Google Play")
 *        - advertiser_name ← app.name
 *        - landing_url     ← app.store_link
 *        - ad_text         ← context: developer_name, company_domain, installs
 *        - country         ← first country in job.countries (informational)
 *   4. buildCsv produces the standard mobile CSV (header=store_url).
 *   5. runHqSplit runs the full HQ resolver cascade (LLM + ccTLD + script)
 *      to produce the per-country .xlsx zip. AppGoblin's company_domain is
 *      not currently fed to the resolver as a separate signal (the store
 *      page fetch will surface a developer website which feeds ccTLD); this
 *      preserves consistency with the Meta/Affplus paths.
 */

import {
  appendLog,
  insertResult,
  getResults,
  clearJobResults,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  markJobCancelled,
  setJobPhase,
  setJobHqZipPath,
  setJobLeadsFound,
  setJobProgress,
  getJob,
  deferJob,
  type JobRow,
} from './db.js';
import { JobCancelledError, throwIfCancelled } from './jobControl.js';
import { BudgetExceededError, nextJerusalemMidnightMs, DAILY_CAP_USD } from './llmBudget.js';
import { scrapeAppgoblin, type AppgoblinApp } from './appgoblinScraper.js';
import { buildCsv } from './csv.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { runHqSplit } from './hqSplit.js';
import { log } from './logger.js';

export interface AppgoblinSourceParams {
  category?: string | null;
  adNetworkDomain?: string | null;
}

function classifyApp(app: AppgoblinApp): 'mobile_google_play' | 'mobile_app_store' | null {
  // app.store comes from AppGoblin as "Google Play" or "Apple App Store"; also
  // double-check via the URL because that's the ground truth.
  const link = (app.store_link || '').toLowerCase();
  if (link.includes('play.google.com')) return 'mobile_google_play';
  if (link.includes('apps.apple.com') || link.includes('itunes.apple.com')) return 'mobile_app_store';
  // Fallback: store label.
  if (app.store === 'Google Play') return 'mobile_google_play';
  if (app.store === 'Apple App Store') return 'mobile_app_store';
  return null;
}

function buildAdText(app: AppgoblinApp): string {
  const parts: string[] = [];
  if (app.developer_name) parts.push(`Developer: ${app.developer_name}`);
  if (app.company_domain) parts.push(`Company: ${app.company_domain}`);
  if (typeof app.installs_d30 === 'number' && app.installs_d30 > 0) {
    parts.push(`Installs(30d): ${app.installs_d30.toLocaleString()}`);
  }
  if (typeof app.rank === 'number') parts.push(`Rank: ${app.rank}`);
  if (app.sdk) parts.push('SDK: yes');
  return parts.join(' · ');
}

function pageUrlFor(app: AppgoblinApp): string {
  if (app.company_domain) return `https://appgoblin.info/companies/${app.company_domain}`;
  return 'https://appgoblin.info/';
}

export async function runAppgoblinJob(job: JobRow): Promise<void> {
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };

  onLog('info', `appgoblin job started: countries=${job.countries}`);

  try {
    // Resume-safety: a job deferred for the daily cap replays from the top.
    // Drop any rows it inserted on the prior run so the deliverable is not
    // duplicated. No-op on a fresh job.
    clearJobResults(job.id);

    // Read discovery params from the job's source_params JSON column.
    let params: AppgoblinSourceParams = {};
    if (job.source_params) {
      try {
        params = JSON.parse(job.source_params) as AppgoblinSourceParams;
      } catch (err) {
        throw new Error(`appgoblin: invalid source_params JSON: ${(err as Error).message}`);
      }
    }
    const category = params.category?.trim() || null;
    const adNetworkDomain = params.adNetworkDomain?.trim() || null;
    if (!category && !adNetworkDomain) {
      throw new Error('appgoblin: job missing source_params (category or adNetworkDomain required)');
    }
    onLog(
      'info',
      `appgoblin: discovery axis — category=${category || '(none)'} adNetwork=${adNetworkDomain || '(none)'}`,
    );

    setJobPhase(job.id, 'scraping', adNetworkDomain ? `ad-network: ${adNetworkDomain}` : `category: ${category}`);

    const countries: string[] = JSON.parse(job.countries);
    const informationalCountry = countries[0] || '';

    // Stop pressed while this job sat in the queue: bail before the scrape —
    // the next check is only AFTER scrapeAppgoblin returns, which can be long.
    throwIfCancelled(job.id);
    setJobProgress(job.id, 5); // scrape is the long haul: 5..55 of the run
    const scrape = await scrapeAppgoblin({
      category,
      adNetworkDomain,
      onLog,
    });

    onLog(
      'info',
      `appgoblin: scrape complete — ${scrape.apps.length} unique apps from ${scrape.companiesFetched} companies` +
        (scrape.blocked ? ' (some fetches were blocked/failed)' : ''),
    );
    if (scrape.notes.length > 0) {
      for (const note of scrape.notes) onLog('warn', `appgoblin: ${note}`);
    }
    if (scrape.apps.length === 0) {
      onLog('warn', 'appgoblin: 0 apps discovered; check the category slug or ad-network domain');
    }

    throwIfCancelled(job.id);
    setJobProgress(job.id, 55);
    setJobPhase(job.id, 'classifying', `${scrape.apps.length} apps to classify`);

    let inserted = 0;
    let skippedNoStore = 0;
    let clsIdx = 0;
    for (const app of scrape.apps) {
      clsIdx++;
      // Overall progress: classification is 55..85 of the run.
      if (clsIdx % 10 === 0) setJobProgress(job.id, 55 + 30 * (clsIdx / Math.max(1, scrape.apps.length)));
      const cls = classifyApp(app);
      if (!cls) {
        skippedNoStore++;
        continue;
      }
      insertResult({
        job_id: job.id,
        advertiser_name: app.name,
        page_url: pageUrlFor(app),
        landing_url: app.store_link,
        classification: cls,
        store_url: app.store_link,
        ad_text: buildAdText(app),
        country: informationalCountry,
      });
      inserted++;
      if (inserted % 10 === 0) setJobLeadsFound(job.id, inserted); // live counter
    }
    setJobLeadsFound(job.id, inserted);
    onLog('info', `appgoblin: inserted ${inserted} rows (skipped ${skippedNoStore} with unknown store)`);

    setJobProgress(job.id, 85); // CSV + HQ split close out; completion pins 100
    setJobPhase(job.id, 'building_csv', `writing CSV (${inserted} rows)`);

    const allResults = getResults(job.id);
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
    });
    onLog('info', `appgoblin: CSV written: ${csvPath} (${rowsWritten} rows)`);

    if (job.product_type === 'mobile') {
      setJobPhase(job.id, 'hq_splitting', `resolving HQ for ${rowsWritten} apps`);
      try {
        const outcome = await runHqSplit({ jobId: job.id, results: allResults, onLog });
        if (outcome.zipPath) {
          setJobHqZipPath(job.id, outcome.zipPath);
          const summary = Object.entries(outcome.perCountryCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([c, n]) => `${c}=${n}`)
            .join(', ');
          onLog('info', `appgoblin hq-split: zip ready (${summary})`);
        }
        if (outcome.playBlocked) {
          onLog('warn', `appgoblin hq-split: Play page-fetch was blocked/rate-limited — Android resolution may be degraded`);
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        onLog('warn', `appgoblin hq-split failed (non-fatal): ${(err as Error).message}`);
      }
    }

    markJobCompleted(job.id, csvPath, { ads: scrape.apps.length, advertisers: rowsWritten });
    onLog('info', `appgoblin job completed`);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh)
        .then(() => onLog('info', 'notification dispatched'))
        .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
    }
  } catch (err) {
    if (err instanceof JobCancelledError) {
      let csvPath: string | null = null;
      let kept = 0;
      try {
        const partial = buildCsv({ jobId: job.id, productType: job.product_type, results: getResults(job.id) });
        csvPath = partial.path;
        kept = partial.rowsWritten;
      } catch { /* best-effort */ }
      markJobCancelled(job.id, `stopped by user — ${kept} lead(s) kept`, csvPath);
      onLog('warn', `appgoblin job stopped by user — ${kept} partial lead(s) exported`);
      return;
    }
    if (err instanceof BudgetExceededError) {
      const runAfter = nextJerusalemMidnightMs();
      const when = new Date(runAfter).toISOString();
      deferJob(job.id, runAfter, `LLM daily cap ($${DAILY_CAP_USD}) reached; resumes after ${when}`);
      onLog('warn', `appgoblin job deferred: LLM daily cap reached; resumes after ${when} (Jerusalem midnight)`);
      return;
    }
    const msg = (err as Error).message || 'unknown error';
    log.error(`appgoblin job ${job.id} failed`, err);
    onLog('error', `appgoblin job failed: ${msg}`);
    markJobFailed(job.id, msg);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobFailed(fresh).catch((e) => onLog('warn', `failure notification error: ${(e as Error).message}`));
    }
  }
}