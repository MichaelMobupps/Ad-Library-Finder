import {
  listRunnableJobs,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  markJobCancelled,
  setJobPhase,
  setJobHqZipPath,
  setJobLeadsFound,
  setJobProgress,
  appendLog,
  insertResult,
  getResults,
  getJob,
  deferJob,
  JobRow,
} from './db.js';
import { JobCancelledError, throwIfCancelled, clearCancelState, beginJobRun, endJobRun } from './jobControl.js';
import {
  BudgetExceededError,
  nextJerusalemMidnightMs,
  spentTodayUsd,
  DAILY_CAP_USD,
} from './llmBudget.js';
import { scrapeQuery, RawAd, closeBrowser } from './scraper.js';
import { classify } from './classifier.js';
import { buildCsv, selectExportRows, normalizeMaxLeads } from './csv.js';
import { keywordsFor } from './keywords.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { runAffplusJob } from './affplusPipeline.js';
import { runAppgoblinJob } from './appgoblinPipeline.js';
import { runGoogleAdsJob } from './googleAdsPipeline.js';
import { runStoreDiscoveryJob } from './storeDiscoveryPipeline.js';
import { runHqSplit } from './hqSplit.js';
import { log } from './logger.js';

const POLL_INTERVAL_MS = 2000;
/**
 * Global ceiling on jobs in flight at once — bounds browsers, proxy traffic and
 * LLM spend bursts, NOT fairness (fairness is the per-user rule below).
 */
const MAX_CONCURRENT_JOBS = Math.max(1, Math.min(8, Number(process.env.QUEUE_MAX_CONCURRENT_JOBS) || 3));
let running = false;

/**
 * CONCURRENT dispatcher — parallel ACROSS users, serial WITHIN a user.
 *
 * The old loop ran ONE job at a time globally, so another user's first job sat
 * behind whatever was already running. Policy now:
 *   • A user's FIRST pending job starts immediately (up to MAX_CONCURRENT_JOBS
 *     in flight overall) — never queued behind another person's job.
 *   • A user's SECOND job waits for their own first (per-user serialization),
 *     which is what keeps one person from monopolizing the worker pool.
 * Shared-state safety under concurrency: the store rate limiters are global (so
 * politeness holds across any number of jobs), meta uses an isolated browser
 * context per query, and the GATC session reset is guarded by the active-run
 * registry (googleAdsPipeline skips the reset while another GATC job runs).
 */
const inFlightJobs = new Set<string>();
const inFlightByUser = new Map<string, string>(); // user key → job id

export function startQueue() {
  if (running) return;
  running = true;
  log.info(`queue processor started (parallel per user, max ${MAX_CONCURRENT_JOBS} concurrent)`);
  void tick();
}

async function tick() {
  while (running) {
    try {
      dispatchRunnable();
    } catch (err) {
      log.error('queue tick error', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function dispatchRunnable() {
  if (inFlightJobs.size >= MAX_CONCURRENT_JOBS) return;
  // Daily LLM cap: do not START a non-exempt job — it would scrape (non-LLM)
  // and then defer at the first LLM call, churning the queue. store_first is
  // EXEMPT: its pipeline is plain HTTP and its one LLM step (the trailing HQ
  // split) checks the cap itself and skips, so the exemption cannot overspend.
  const capReached = spentTodayUsd() >= DAILY_CAP_USD;
  for (const job of listRunnableJobs(50)) {
    if (inFlightJobs.size >= MAX_CONCURRENT_JOBS) break;
    if (inFlightJobs.has(job.id)) continue; // launched a tick ago, still 'pending' in DB
    const userKey = job.created_by_user_id || '(no-user)';
    if (inFlightByUser.has(userKey)) continue; // per-user serial: their next job waits for their current one
    if (capReached && job.source !== 'store_first') continue; // cap-parked until the Jerusalem-day reset
    launchJob(job, userKey);
  }
}

function launchJob(job: JobRow, userKey: string) {
  inFlightJobs.add(job.id);
  inFlightByUser.set(userKey, job.id);
  beginJobRun(job.source);
  // Fresh cancellation state for this run: a job id can re-enter the worker
  // (deferred/resumed jobs replay), and the control cache's "cancelled" answer
  // is deliberately sticky within a run.
  clearCancelState(job.id);
  void runJob(job)
    .catch((err) => {
      // Runners settle their own job rows; this only guards the dispatcher.
      log.error(`job ${job.id} escaped its pipeline's error handling`, err);
    })
    .finally(() => {
      endJobRun(job.source);
      inFlightJobs.delete(job.id);
      if (inFlightByUser.get(userKey) === job.id) inFlightByUser.delete(userKey);
    });
}

async function runJob(job: JobRow): Promise<void> {
  if (job.source === 'affplus') {
    await runAffplusJob(job);
  } else if (job.source === 'appgoblin') {
    await runAppgoblinJob(job);
  } else if (job.source === 'google_ads') {
    await runGoogleAdsJob(job);
  } else if (job.source === 'store_first') {
    await runStoreDiscoveryJob(job);
  } else {
    await runMetaJob(job);
  }
}

async function runMetaJob(job: JobRow) {
  // markJobRunning sets phase='starting' / detail='launching browser'.
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };
  onLog('info', `job started: ${job.product_type}, countries=${job.countries}`);

  try {
    const countries: string[] = JSON.parse(job.countries);
    const keywords = keywordsFor(job.product_type);

    onLog('info', `using ${keywords.length} keywords × ${countries.length} countries`);

    const seenAdvertisers = new Set<string>();
    const collected: RawAd[] = [];

    const totalQueries = countries.length * keywords.length;
    let queryIdx = 0;

    for (const country of countries) {
      for (const keyword of keywords) {
        throwIfCancelled(job.id);
        queryIdx++;
        setJobPhase(
          job.id,
          'scraping',
          `${country} / "${keyword}" (${queryIdx}/${totalQueries})`
        );
        // Overall progress: scrape sweep is 0..50 of the run.
        setJobProgress(job.id, 50 * (queryIdx / Math.max(1, totalQueries)));
        onLog('info', `scrape ${country} / "${keyword}"`);
        const ads = await scrapeQuery(country, keyword, (m) => onLog('debug', m));
        let newCount = 0;
        for (const ad of ads) {
          const key = `${ad.advertiser_name.toLowerCase().trim()}|${country}`;
          if (seenAdvertisers.has(key)) continue;
          seenAdvertisers.add(key);
          collected.push(ad);
          newCount++;
        }
        onLog('info', `  +${newCount} new advertisers (${ads.length} ads on page)`);
      }
    }

    onLog('info', `scraping done: ${collected.length} unique advertisers`);
    onLog('info', `classifying landing URLs...`);
    setJobPhase(job.id, 'classifying', `0/${collected.length} advertisers`);

    let classified = 0;
    let matched = 0;
    // Resume guard: if this job was deferred earlier today for the cap and is
    // now replaying, skip landing URLs already classified on the prior run so
    // their LLM calls are not paid for twice (and no duplicate rows are written).
    // Empty on a fresh job, so first runs are unaffected.
    const alreadyDone = new Set(
      getResults(job.id)
        .map((r) => r.landing_url)
        .filter((u): u is string => !!u),
    );
    for (const ad of collected) {
      throwIfCancelled(job.id);
      if (ad.landing_url && alreadyDone.has(ad.landing_url)) {
        classified++;
        continue;
      }
      const cls = await classify(ad.landing_url, ad.ad_text);
      const isMatch =
        (job.product_type === 'mobile' &&
          (cls.classification === 'mobile_google_play' || cls.classification === 'mobile_app_store')) ||
        (job.product_type === 'cps' && cls.classification === 'cps_web');

      insertResult({
        job_id: job.id,
        advertiser_name: ad.advertiser_name,
        page_url: ad.page_url,
        landing_url: ad.landing_url,
        classification: cls.classification,
        store_url: cls.store_url,
        ad_text: ad.ad_text,
        country: ad.country,
      });

      classified++;
      if (isMatch) {
        matched++;
        setJobLeadsFound(job.id, matched); // live counter for the UI
      }
      if (classified % 10 === 0 || classified === collected.length) {
        setJobPhase(
          job.id,
          'classifying',
          `${classified}/${collected.length} advertisers (${matched} matched)`
        );
        // Overall progress: classification is 50..90 of the run.
        setJobProgress(job.id, 50 + 40 * (classified / Math.max(1, collected.length)));
      }
      if (classified % 25 === 0) {
        onLog('info', `  classified ${classified}/${collected.length} (matched product type: ${matched})`);
      }
    }

    onLog('info', `classification done: ${matched} matched ${job.product_type}`);
    setJobProgress(job.id, 90); // CSV + HQ split close out; completion pins 100
    setJobPhase(job.id, 'building_csv', `writing CSV (${matched} matched rows)`);

    const allResults = getResults(job.id);
    // Operator-chosen lead cap (20/50/100/all) — caps the CSV and, below, the
    // HQ-split rows, so the Excel never disagrees with the CSV.
    const metaMaxLeads = normalizeMaxLeads(
      job.source_params ? (JSON.parse(job.source_params) as Record<string, unknown>).maxLeads : null,
    );
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
      maxRows: metaMaxLeads,
    });
    onLog('info', `CSV written: ${csvPath} (${rowsWritten} rows)`);

    // HQ split (mobile only). Fire-and-forget for failures inside the split:
    // we don't want a downstream HQ-resolution issue to fail the whole job.
    if (job.product_type === 'mobile') {
      throwIfCancelled(job.id);
      setJobPhase(job.id, 'hq_splitting', `resolving HQ for ${rowsWritten} apps`);
      try {
        const outcome = await runHqSplit({
          jobId: job.id,
          results: selectExportRows(allResults, job.product_type, metaMaxLeads),
          onLog,
        });
        if (outcome.zipPath) {
          setJobHqZipPath(job.id, outcome.zipPath);
          const summary = Object.entries(outcome.perCountryCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([c, n]) => `${c}=${n}`)
            .join(', ');
          onLog('info', `hq-split: zip ready (${summary})`);
        }
        if (outcome.playBlocked) {
          onLog('warn', `hq-split: Play page-fetch was blocked/rate-limited — Android resolution may be degraded`);
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        onLog('warn', `hq-split failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // markJobCompleted sets phase='done'.
    markJobCompleted(job.id, csvPath, { ads: collected.length, advertisers: rowsWritten });
    onLog('info', `job completed`);

    // Notify (fire-and-forget; we don't fail the job if the email fails)
    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh).then(() => onLog('info', 'notification dispatched')).catch((e) => {
        onLog('warn', `notification error: ${(e as Error).message}`);
      });
    }
  } catch (err) {
    if (err instanceof JobCancelledError) {
      // Stop button: keep everything classified so far and export it, so a
      // stopped job still delivers its partial leads.
      let csvPath: string | null = null;
      let kept = 0;
      try {
        const cap = normalizeMaxLeads(
          job.source_params ? (JSON.parse(job.source_params) as Record<string, unknown>).maxLeads : null,
        );
        const partial = buildCsv({ jobId: job.id, productType: job.product_type, results: getResults(job.id), maxRows: cap });
        csvPath = partial.path;
        kept = partial.rowsWritten;
      } catch {
        /* partial CSV is best-effort */
      }
      markJobCancelled(job.id, `stopped by user — ${kept} lead(s) kept`, csvPath);
      onLog('warn', `job stopped by user — ${kept} partial lead(s) exported`);
      return;
    }
    if (err instanceof BudgetExceededError) {
      const runAfter = nextJerusalemMidnightMs();
      const when = new Date(runAfter).toISOString();
      deferJob(job.id, runAfter, `LLM daily cap ($${DAILY_CAP_USD}) reached; resumes after ${when}`);
      onLog('warn', `job deferred: LLM daily cap reached; resumes after ${when} (Jerusalem midnight)`);
      return;
    }
    const msg = (err as Error).message || 'unknown error';
    log.error(`job ${job.id} failed`, err);
    onLog('error', `job failed: ${msg}`);
    markJobFailed(job.id, msg);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobFailed(fresh).catch((e) => {
        onLog('warn', `failure notification error: ${(e as Error).message}`);
      });
    }
  }
}

process.on('SIGTERM', async () => {
  running = false;
  await closeBrowser();
});
process.on('SIGINT', async () => {
  running = false;
  await closeBrowser();
});