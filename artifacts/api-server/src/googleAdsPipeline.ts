/**
 * Google Ads Transparency Center job pipeline.
 *
 * Parallel path to affplusPipeline.ts / appgoblinPipeline.ts. For a google_ads job:
 *
 *   1. Build a keyword set from the multilingual exemplar bank
 *      (googleAdsKeywords.keywordsForJob), filtered by the job's chosen
 *      verticals/languages and capped at maxKeywords — or the operator's own
 *      custom keyword list if supplied.
 *   2. discoverAdvertisers(): SearchSuggestions per keyword → deduped advertisers
 *      (name, verified domain, region hint). This is the "enter keywords and
 *      search" mechanic the Transparency Center forces on us.
 *   3. For each advertiser, resolveAdvertiserDestination(): pull a representative
 *      creative's click destination (app-store URL for mobile, website for web),
 *      falling back to the verified domain.
 *   4. Classify the destination WITHOUT the LLM — a store URL ⇒ mobile, any other
 *      real destination ⇒ web CPS. (A keyword does NOT guarantee mobile-vs-web;
 *      the destination decides, exactly as the operator noted.)
 *   5. buildCsv filters to the job's product type (mobile OR cps → one CSV).
 *   6. HQ split: mobile → runHqSplit (store-page HQ); cps → runHqSplitWeb
 *      (domain/ccTLD/script/LLM HQ). Both bucket leads by HQ country into a .zip.
 *
 * Cost profile: the classifier is regex-only here (no LLM). The only LLM spend is
 * HQ resolution, which is cache-aware and, for web, ccTLD/script-short-circuited.
 * All spend flows through the shared daily cap → a hit defers, never fails.
 */

import {
  appendLog,
  insertResult,
  getResults,
  clearJobResults,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  setJobPhase,
  setJobHqZipPath,
  getJob,
  deferJob,
  type JobRow,
} from './db.js';
import { BudgetExceededError, nextJerusalemMidnightMs, DAILY_CAP_USD } from './llmBudget.js';
import {
  discoverAdvertisers,
  resolveAdvertiserDestination,
  makeLookupBudget,
  resetGoogleAdsSession,
  type GoogleAdsAdvertiser,
} from './googleAdsScraper.js';
import { keywordsForJob, keywordStats } from './googleAdsKeywords.js';
import { sanitizeStoreUrl } from './classifier.js';
import { buildCsv } from './csv.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { runHqSplit } from './hqSplit.js';
import { runHqSplitWeb } from './hqSplitWeb.js';
import { log } from './logger.js';

/** Per-job cap on GetCreativeById lookups (each is one extra RPC round-trip). */
const MAX_CREATIVE_LOOKUPS = Number(process.env.GOOGLE_ADS_MAX_LOOKUPS) || 60;
/** Hard cap on advertisers processed per job (defensive; a wide keyword set can
 *  surface thousands). */
const MAX_ADVERTISERS = Number(process.env.GOOGLE_ADS_MAX_ADVERTISERS) || 1000;
/** Default keyword sample size when the job doesn't specify one. */
const DEFAULT_MAX_KEYWORDS = Number(process.env.GOOGLE_ADS_DEFAULT_MAX_KEYWORDS) || 40;

export interface GoogleAdsSourceParams {
  verticals?: string[] | null;
  languages?: string[] | null;
  maxKeywords?: number | null;
  customKeywords?: string[] | null;
  region?: string | null;
}

type Classification = 'mobile_google_play' | 'mobile_app_store' | 'cps_web' | 'unknown';

/**
 * Classify a Google Ads click destination — regex only, no LLM. A canonical
 * app-store (or allowlisted MMP-tracker) URL is mobile; any other real http(s)
 * destination is a web CPS lead.
 */
export function classifyGoogleAdsUrl(url: string | null): { classification: Classification; store_url: string | null } {
  if (!url) return { classification: 'unknown', store_url: null };
  const store = sanitizeStoreUrl(url);
  if (store) {
    if (/play\.google\.com/i.test(store)) return { classification: 'mobile_google_play', store_url: store };
    if (/apple\.com/i.test(store)) return { classification: 'mobile_app_store', store_url: store };
    // Allowlisted MMP tracker — mobile, but the concrete store URL is unknown.
    return { classification: 'mobile_google_play', store_url: store };
  }
  if (/^https?:\/\//i.test(url)) return { classification: 'cps_web', store_url: null };
  return { classification: 'unknown', store_url: null };
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function advertiserUrl(adv: GoogleAdsAdvertiser): string {
  if (adv.advertiser_id) {
    return `https://adstransparency.google.com/advertiser/${encodeURIComponent(adv.advertiser_id)}?region=anywhere`;
  }
  return 'https://adstransparency.google.com/';
}

function buildAdText(adv: GoogleAdsAdvertiser, destNote: string, format: string | null): string {
  const parts: string[] = [`Google Ads Transparency · matched "${adv.matchedKeyword}"`];
  if (adv.domain) parts.push(`domain: ${adv.domain}`);
  if (adv.region) parts.push(`advertiser region: ${adv.region}`);
  if (format) parts.push(`format: ${format}`);
  if (destNote) parts.push(`dest: ${destNote}`);
  if (adv.advertiser_id) parts.push(`advertiser_id: ${adv.advertiser_id}`);
  return parts.join(' · ');
}

function parseParams(job: JobRow): GoogleAdsSourceParams {
  if (!job.source_params) return {};
  try {
    return JSON.parse(job.source_params) as GoogleAdsSourceParams;
  } catch {
    return {};
  }
}

export async function runGoogleAdsJob(job: JobRow): Promise<void> {
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };

  onLog('info', `google-ads job started: product=${job.product_type}, countries=${job.countries}`);

  try {
    // Resume-safety: a job deferred for the daily cap replays from the top.
    clearJobResults(job.id);

    // Start each job with a clean scraper session: fresh cookies (re-warmed at
    // discovery) and throttle baseline, so a long-lived server doesn't carry one
    // job's stale cookies / ratcheted-up throttle into the next.
    resetGoogleAdsSession();

    const params = parseParams(job);
    const countries: string[] = JSON.parse(job.countries);
    const informationalCountry = countries[0] || '';
    const region = params.region?.trim() || informationalCountry || null;

    // ── 1. Keyword set ──
    let keywords: string[];
    const custom = (params.customKeywords || [])
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean);
    if (custom.length > 0) {
      // Dedupe case-insensitively, cap at maxKeywords if given.
      const seen = new Set<string>();
      keywords = [];
      for (const k of custom) {
        const key = k.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        keywords.push(k);
      }
      const cap = params.maxKeywords && params.maxKeywords > 0 ? params.maxKeywords : keywords.length;
      keywords = keywords.slice(0, cap);
      onLog('info', `google-ads: using ${keywords.length} custom keywords`);
    } else {
      const limit = params.maxKeywords && params.maxKeywords > 0 ? params.maxKeywords : DEFAULT_MAX_KEYWORDS;
      keywords = keywordsForJob({
        verticals: params.verticals || null,
        languages: params.languages || null,
        limit,
      });
      const stats = keywordStats();
      onLog(
        'info',
        `google-ads: drew ${keywords.length} keywords from the exemplar bank (${stats.total} total, ${stats.languages} languages, ${stats.verticals} verticals)` +
          `${params.verticals?.length ? `; verticals=${params.verticals.join(',')}` : ''}` +
          `${params.languages?.length ? `; languages=${params.languages.join(',')}` : ''}`,
      );
    }

    if (keywords.length === 0) {
      onLog('warn', 'google-ads: keyword set is empty — nothing to search');
    }

    // ── 2. Discover advertisers ──
    setJobPhase(job.id, 'scraping', `searching ${keywords.length} keywords`);
    const discovery = await discoverAdvertisers(keywords, {
      region,
      onLog,
      onProgress: (done, total, found) => {
        if (done % 5 === 0 || done === total) {
          setJobPhase(job.id, 'scraping', `keyword ${done}/${total} · ${found} advertisers`);
        }
      },
    });

    onLog(
      'info',
      `google-ads: discovery done — ${discovery.advertisers.length} unique advertisers from ${discovery.keywordsSearched} keywords (${discovery.requestsMade} requests)`,
    );
    for (const note of discovery.notes) onLog('warn', `google-ads: ${note}`);
    if (discovery.blocked) {
      onLog(
        'warn',
        'google-ads: some/all requests were blocked (HTTP 403/429 or a challenge page). Google fingerprints non-browser clients — results may be partial. Re-run from a residential/less-flagged IP or lower the keyword count if this persists.',
      );
    }
    if (discovery.advertisers.length === 0) {
      onLog(
        'warn',
        'google-ads: 0 advertisers discovered. Either the keywords matched nothing or the endpoint is blocking this host. The CSV will be empty.',
      );
    }

    // ── 3+4. Resolve destinations + classify (regex, no LLM) ──
    const advertisers = discovery.advertisers.slice(0, MAX_ADVERTISERS);
    if (discovery.advertisers.length > MAX_ADVERTISERS) {
      onLog('warn', `google-ads: capping ${discovery.advertisers.length} advertisers to ${MAX_ADVERTISERS} (GOOGLE_ADS_MAX_ADVERTISERS)`);
    }
    setJobPhase(job.id, 'classifying', `resolving ${advertisers.length} advertisers`);
    const lookupBudget = makeLookupBudget(MAX_CREATIVE_LOOKUPS);

    let inserted = 0;
    let mobileCount = 0;
    let webCount = 0;
    let unresolved = 0;
    let dupSkipped = 0;
    const insertedKeys = new Set<string>();

    // Circuit breaker: when the creative endpoint hard-blocks (each blocked
    // lookup costs the full retry/backoff ladder), stop probing it after a few
    // consecutive blocks and resolve the REMAINING advertisers from their
    // verified domains only — instant, no network, and the job finishes in
    // minutes instead of grinding for hours writing nothing.
    let consecutiveBlockedLookups = 0;
    let skipCreativeLookups = false;
    const CIRCUIT_BREAKER_AFTER = 3;

    // Incremental CSV flush: rebuild the CSV every N inserts so a partial file
    // exists (and grows) from the first lead onward — even if the job is later
    // interrupted, "Download CSV" already has everything found so far.
    const FLUSH_EVERY = 25;
    let lastFlushMark = 0;
    let lastFlushedCount = 0;
    const flushCsv = () => {
      try {
        const { rowsWritten } = buildCsv({ jobId: job.id, productType: job.product_type, results: getResults(job.id) });
        if (lastFlushedCount === 0 && rowsWritten > 0) {
          onLog('info', `google-ads: partial CSV flushed (${rowsWritten} rows so far) — leads are saved incrementally from here on`);
        }
        lastFlushedCount = rowsWritten;
      } catch (err) {
        onLog('warn', `google-ads: incremental CSV flush failed (non-fatal): ${(err as Error).message}`);
      }
    };

    for (let i = 0; i < advertisers.length; i++) {
      const adv = advertisers[i];
      const dest = await resolveAdvertiserDestination(adv, { region, lookupBudget, onLog, skipCreativeLookups });
      if (!skipCreativeLookups && adv.advertiser_id) {
        if (dest.blocked) {
          consecutiveBlockedLookups++;
          if (consecutiveBlockedLookups >= CIRCUIT_BREAKER_AFTER) {
            skipCreativeLookups = true;
            onLog(
              'warn',
              `google-ads: creative endpoint blocked ${consecutiveBlockedLookups}× in a row — circuit breaker ON: ` +
                `resolving the remaining ${advertisers.length - i - 1} advertisers from verified domains only ` +
                `(no more lookups this job; mobile store detection degraded)`,
            );
            flushCsv();
          }
        } else {
          consecutiveBlockedLookups = 0;
        }
      }
      const cls = classifyGoogleAdsUrl(dest.landingUrl);

      if (cls.classification === 'unknown' || !dest.landingUrl) {
        unresolved++;
      } else {
        // Dedupe: one row per (store_url) for mobile, one per (host) for web.
        const dedupeKey =
          cls.store_url ? `s:${cls.store_url}` : `w:${hostOf(dest.landingUrl)}`;
        if (insertedKeys.has(dedupeKey)) {
          dupSkipped++;
        } else {
          insertedKeys.add(dedupeKey);
          insertResult({
            job_id: job.id,
            advertiser_name: adv.name || adv.domain || adv.advertiser_id || '(unknown advertiser)',
            page_url: advertiserUrl(adv),
            landing_url: dest.landingUrl,
            classification: cls.classification,
            store_url: cls.store_url,
            ad_text: buildAdText(adv, dest.note, dest.format),
            country: adv.region || informationalCountry,
          });
          inserted++;
          if (cls.classification === 'cps_web') webCount++;
          else mobileCount++;
        }
      }

      if ((i + 1) % 10 === 0 || i === advertisers.length - 1) {
        setJobPhase(
          job.id,
          'classifying',
          `resolved ${i + 1}/${advertisers.length} · ${mobileCount} mobile · ${webCount} web`,
        );
      }
      if (inserted >= lastFlushMark + FLUSH_EVERY) {
        lastFlushMark = inserted;
        flushCsv();
      }
      if ((i + 1) % 25 === 0) {
        onLog(
          'info',
          `google-ads: processed ${i + 1}/${advertisers.length} — mobile ${mobileCount}, web ${webCount}, unresolved ${unresolved} (creative-lookups left ${lookupBudget.remaining()})`,
        );
      }
    }

    onLog(
      'info',
      `google-ads: classification done — inserted ${inserted} rows (mobile ${mobileCount}, web ${webCount}), unresolved ${unresolved}, dup-skipped ${dupSkipped}`,
    );

    // ── 5. CSV (filters by product type) ──
    setJobPhase(job.id, 'building_csv', `writing ${job.product_type} CSV`);
    const allResults = getResults(job.id);
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
    });
    onLog('info', `google-ads: CSV written: ${csvPath} (${rowsWritten} ${job.product_type} rows)`);
    if (rowsWritten === 0) {
      onLog(
        'warn',
        `google-ads: CSV is empty for product_type=${job.product_type}. ${
          job.product_type === 'mobile'
            ? 'No advertiser destinations resolved to an app store.'
            : 'No advertiser destinations resolved to a website.'
        } Check the discovery/block warnings above.`,
      );
      if (job.product_type === 'mobile' && webCount > 0) {
        onLog(
          'warn',
          `google-ads: NOTE — ${webCount} WEB (cps_web) leads WERE found but are excluded from a mobile CSV. ` +
            `Store URLs require creative lookups, which were blocked/degraded this run. ` +
            `Re-run this job with product type CPS to export those ${webCount} website leads.`,
        );
      }
    }

    // ── 6. HQ split (mobile → store-page HQ; cps → web/domain HQ) ──
    setJobPhase(job.id, 'hq_splitting', `resolving HQ for ${rowsWritten} leads`);
    try {
      if (job.product_type === 'mobile') {
        const outcome = await runHqSplit({ jobId: job.id, results: allResults, onLog });
        if (outcome.zipPath) {
          setJobHqZipPath(job.id, outcome.zipPath);
          const summary = Object.entries(outcome.perCountryCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([c, n]) => `${c}=${n}`)
            .join(', ');
          onLog('info', `google-ads hq-split: zip ready (${summary})`);
        }
        if (outcome.playBlocked) {
          onLog('warn', 'google-ads hq-split: Play page-fetch was blocked/rate-limited — Android HQ resolution may be degraded');
        }
      } else {
        const outcome = await runHqSplitWeb({ jobId: job.id, results: allResults, onLog });
        if (outcome.zipPath) {
          setJobHqZipPath(job.id, outcome.zipPath);
          const summary = Object.entries(outcome.perCountryCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([c, n]) => `${c}=${n}`)
            .join(', ');
          onLog('info', `google-ads web-hq-split: zip ready (${summary})`);
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      onLog('warn', `google-ads hq-split failed (non-fatal): ${(err as Error).message}`);
    }

    markJobCompleted(job.id, csvPath, { ads: discovery.advertisers.length, advertisers: rowsWritten });
    onLog('info', 'google-ads job completed');

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh)
        .then(() => onLog('info', 'notification dispatched'))
        .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const runAfter = nextJerusalemMidnightMs();
      const when = new Date(runAfter).toISOString();
      deferJob(job.id, runAfter, `LLM daily cap ($${DAILY_CAP_USD}) reached; resumes after ${when}`);
      onLog('warn', `google-ads job deferred: LLM daily cap reached; resumes after ${when} (Jerusalem midnight)`);
      return;
    }
    const msg = (err as Error).message || 'unknown error';
    log.error(`google-ads job ${job.id} failed`, err);
    onLog('error', `google-ads job failed: ${msg}`);
    markJobFailed(job.id, msg);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobFailed(fresh).catch((e) => onLog('warn', `failure notification error: ${(e as Error).message}`));
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Offline unit tests for the pure classifier mapping (no network, no LLM).
// ───────────────────────────────────────────────────────────────────────────

export function runGoogleAdsPipelineTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  const play = classifyGoogleAdsUrl('https://play.google.com/store/apps/details?id=com.foo&hl=en');
  check(play.classification === 'mobile_google_play' && play.store_url === 'https://play.google.com/store/apps/details?id=com.foo', 'play URL → mobile_google_play + canonical');

  const ios = classifyGoogleAdsUrl('https://apps.apple.com/us/app/foo/id123456789');
  check(ios.classification === 'mobile_app_store' && !!ios.store_url, 'app store URL → mobile_app_store');

  const web = classifyGoogleAdsUrl('https://shop.example.com/promo?utm=1');
  check(web.classification === 'cps_web' && web.store_url === null, 'website URL → cps_web (no LLM, no store)');

  const none = classifyGoogleAdsUrl(null);
  check(none.classification === 'unknown', 'null → unknown');

  const notUrl = classifyGoogleAdsUrl('ftp://weird');
  check(notUrl.classification === 'unknown', 'non-http scheme → unknown');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('googleAdsPipeline.js') || process.argv[1].endsWith('googleAdsPipeline.ts'));
if (isMain) {
  const { passed, failed, failures } = runGoogleAdsPipelineTests();
  console.log(`googleAdsPipeline tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
