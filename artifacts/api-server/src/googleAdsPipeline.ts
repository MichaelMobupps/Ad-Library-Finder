/**
 * Google Ads Transparency Center job pipeline.
 *
 * DEMOTED (store-first migration, spec step 14): GATC is no longer the discovery
 * engine — the `store_first` pipeline discovers publishers from app-store data and
 * GATC/Meta only CONFIRM ad activity (see storeConfirm.ts, which reuses this
 * module's SearchSuggestions/SearchCreatives RPCs). This keyword-driven discovery
 * pipeline is kept intact as a SECONDARY/legacy advertiser view: domain-token
 * matches structurally resolve domain OWNERS only and cannot enumerate app
 * advertisers, which is exactly why discovery moved to the stores. No rows are
 * deleted; the source stays available but is surfaced as secondary in the UI.
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
  markJobCancelled,
  setJobPhase,
  setJobHqZipPath,
  setJobCsvPath,
  setJobLeadsFound,
  setResultCategory,
  getJob,
  deferJob,
  type JobRow,
} from './db.js';
import { JobCancelledError, throwIfCancelled, isCancelRequested } from './jobControl.js';
import { enrichStoreUrls } from './appCategory.js';
import { BudgetExceededError, nextJerusalemMidnightMs, DAILY_CAP_USD } from './llmBudget.js';
import {
  discoverAdvertisers,
  resolveAdvertiserDestination,
  makeLookupBudget,
  resetGoogleAdsSession,
  assertProxyUrlUsable,
  type GoogleAdsAdvertiser,
} from './googleAdsScraper.js';
import { keywordsForJob, keywordStats, GOOGLE_ADS_VERTICALS } from './googleAdsKeywords.js';
import { sanitizeStoreUrl } from './classifier.js';
import { makeSearchBudget, searchAdvertiserWebsite } from './webResolver.js';
import { buildCsv, selectExportRows, normalizeMaxLeads } from './csv.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { runHqSplit } from './hqSplit.js';
import { runHqSplitWeb } from './hqSplitWeb.js';
import { checkProxyTrafficBeforeJob, logProxyTrafficAfterJob, type ProxyTrafficSnapshot } from './proxyTraffic.js';
import { log } from './logger.js';

/** Per-job cap on GetCreativeById lookups (each is one extra RPC round-trip).
 *  Only MOBILE jobs spend these (CPS skips creatives), and each lookup is now
 *  far more productive since the preview store-URL truncation was fixed — so the
 *  budget is the main lever on how many advertisers get a shot at a store URL.
 *  Raised from 60 → 100 so resolution doesn't stall a quarter of the way through
 *  a wide discovery. Env-tunable via GOOGLE_ADS_MAX_LOOKUPS. */
const MAX_CREATIVE_LOOKUPS = Number(process.env.GOOGLE_ADS_MAX_LOOKUPS) || 100;
/** Hard cap on advertisers processed per job (defensive; a wide keyword set can
 *  surface thousands). */
const MAX_ADVERTISERS = Number(process.env.GOOGLE_ADS_MAX_ADVERTISERS) || 1000;
/** Default keyword sample size when the job doesn't specify one. */
const DEFAULT_MAX_KEYWORDS = Number(process.env.GOOGLE_ADS_DEFAULT_MAX_KEYWORDS) || 40;
/** Vertical ids demoted by the store-first migration (spec step 14): the
 *  legal-entity NAME-TOKEN batteries ('game studio', 'games ltd', 'pte ltd',
 *  'fintech', …). Kept in the bank, excluded from the DEFAULT draw. */
const DEMOTED_VERTICAL_IDS = ['apps', 'apps_nongame'];
/** CPS jobs skip SearchCreatives/GetCreativeById entirely by default: the lead
 *  is the advertiser's own site (verified domain, else name→web-search), and the
 *  creative endpoint is what gets a proxy/host IP flagged. Set
 *  GOOGLE_ADS_CPS_USE_CREATIVES=1 to restore per-creative landing-page lookups. */
const CPS_USE_CREATIVES = process.env.GOOGLE_ADS_CPS_USE_CREATIVES === '1';
/** Per-job cap on Affplus-style name→web-searches for advertisers that have no
 *  verified domain (each search is a small LLM spend under the daily cap). */
const WEB_NAME_SEARCHES = Number(process.env.GOOGLE_ADS_WEB_MAX_SEARCHES) || 40;

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

/**
 * The vertical set a job actually searches (spec step 14 — name-token batteries
 * INACTIVE BY DEFAULT).
 *
 * An explicit pin wins untouched: demotion is a default, not a prohibition, so an
 * operator who asks for 'apps'/'apps_nongame' still gets them.
 *
 * With nothing pinned we must NAME every surviving vertical instead of passing
 * null. `keywordsForJob` reads null as "ALL verticals" and applies no filter at
 * all, so the demoted batteries were round-robined into the very first interleave
 * pass — they ran on every unpinned job while the job log told the operator they
 * were inactive. Naming the survivors is the only way to express "everything
 * except these" with the selection shape the keyword bank accepts; its one cost
 * is that a filtered selection also drops the cross-vertical 'cta' intent words,
 * which are the weakest advertiser-name tokens in the bank.
 */
export function verticalsForJob(pinned: string[] | null | undefined): string[] {
  if (pinned && pinned.length > 0) return pinned;
  return GOOGLE_ADS_VERTICALS.map((v) => v.id).filter((id) => !DEMOTED_VERTICAL_IDS.includes(id));
}

export async function runGoogleAdsJob(job: JobRow): Promise<void> {
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };

  onLog('info', `google-ads job started: product=${job.product_type}, countries=${job.countries}`);

  // Hoisted above the try so the catch can still report the job's traffic burn.
  let trafficBefore: ProxyTrafficSnapshot | null = null;

  try {
    // Config gate first: a set-but-unusable GOOGLE_ADS_PROXY_URL (unfilled
    // HOST:PORT placeholder, unparsable URL) must fail the job loudly here
    // instead of silently egressing direct into Google's penalty box. Local
    // and free; before clearJobResults so a deferred job's partials survive.
    assertProxyUrlUsable();

    // Refuse to start against an exhausted residential proxy package — a clear
    // error now beats burning the whole retry ladder against a dead egress.
    // Also snapshots usage so the job can report its own traffic cost at the
    // end. No-op unless PROXY_SELLER_API_KEY is set; fail-open on API errors.
    // MUST run before clearJobResults: a deferred job that resumes into an
    // exhausted package should fail with its partial results still intact.
    trafficBefore = await checkProxyTrafficBeforeJob(onLog);

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
      // DEMOTED (store-first migration, spec step 14): NAME-TOKEN batteries are
      // now INACTIVE BY DEFAULT.
      //
      // The 'apps' and 'apps_nongame' verticals are legal-entity name tokens
      // ('game studio', 'games ltd', 'pte ltd', 'apps inc'). They used to be the
      // automatic default for every mobile job, on the theory that a mobile lead
      // needs a store destination and only app publishers have one. That theory
      // is structurally unsound: a name-token search enumerates whoever happens to
      // put a studio token in their advertiser NAME, which is not the same set as
      // "app advertisers" and cannot be made into it — GATC caps at 100
      // advertisers per query and hides unverified advertisers outside the EU.
      // Store-first discovery owns app-publisher discovery now.
      //
      // The batteries are KEPT, not deleted: an explicit vertical selection still
      // activates them (verticalsForJob). A job simply no longer opts into them
      // silently — which is why the unpinned case names every OTHER vertical
      // rather than passing null, the "all verticals" shorthand that kept the
      // demoted batteries in the draw.
      const pinnedVerticals = !!(params.verticals && params.verticals.length > 0);
      const effectiveVerticals = verticalsForJob(params.verticals);
      keywords = keywordsForJob({
        verticals: effectiveVerticals,
        languages: params.languages || null,
        limit,
      });
      if (!pinnedVerticals) {
        onLog(
          'info',
          "google-ads: name-token app batteries ('apps','apps_nongame') are inactive by default since the store-first migration " +
            '— structural: name search resolves advertiser-name matches only. Pin those verticals explicitly to re-enable them, ' +
            'or use Store-First Discovery, which is the supported path for app publishers.',
        );
      }
      const stats = keywordStats();
      onLog(
        'info',
        `google-ads: drew ${keywords.length} keywords from the exemplar bank (${stats.total} total, ${stats.languages} languages, ${stats.verticals} verticals)` +
          // Only echo the verticals the OPERATOR chose: unpinned jobs now carry the
          // full survivor list (every vertical bar the demoted ones), and printing
          // 20-odd ids would read as a selection nobody made.
          `${pinnedVerticals ? `; verticals=${effectiveVerticals.join(',')}` : ''}` +
          `${params.languages?.length ? `; languages=${params.languages.join(',')}` : ''}`,
      );
    }

    if (keywords.length === 0) {
      onLog('warn', 'google-ads: keyword set is empty — nothing to search');
    }

    // ── 2+3+4. Discover, resolve, classify & persist — STREAMING, real time ──
    // Discovery streams each newly-found advertiser to processAdvertiser the
    // instant it is discovered; that resolves its destination, classifies it
    // (regex, no LLM), inserts it, and re-flushes the CSV. So the file grows
    // continuously from the first lead and a mid-scrape block/kill loses
    // nothing — discovery and writing are effectively concurrent.
    setJobPhase(job.id, 'scraping', `searching ${keywords.length} keywords`);
    const lookupBudget = makeLookupBudget(MAX_CREATIVE_LOOKUPS);
    const nameSearchBudget = makeSearchBudget(WEB_NAME_SEARCHES);

    // CPS = web leads. The advertiser's own site is the lead, so creative
    // lookups add nothing except load on the endpoint that flags the IP —
    // skip them from the start (env-restorable). Mobile still needs them
    // (store URLs only appear in creatives).
    const cpsMode = job.product_type !== 'mobile';
    const skipCreativesFromStart = cpsMode && !CPS_USE_CREATIVES;
    if (skipCreativesFromStart) {
      onLog('info', 'google-ads: CPS mode — creative lookups OFF (domain-first + name-search); minimal endpoint footprint');
    }

    let processed = 0;
    let inserted = 0;
    let mobileCount = 0;
    let webCount = 0;
    let unresolved = 0;
    let dupSkipped = 0;
    const insertedKeys = new Set<string>();

    // Circuit breaker over the CREATIVE endpoint only. Each blocked creative
    // lookup costs the full retry/backoff ladder, so once it starts hard-blocking
    // we PAUSE creative scraping and resolve the rest from verified domains only
    // (instant, no network). Two independent trip signals:
    //   • CONSECUTIVE: N blocked-in-a-row (fast reaction to a hard block).
    //   • RATE: ≥ threshold of the sampled attempts blocked (catches an
    //     intermittent storm that never quite lines up N in a row).
    // Only advertisers that actually PROBED the creative endpoint
    // (attemptedCreativeLookup) count — a domain-only resolution is neutral and
    // must not reset the breaker (that was the old under-trip bug).
    let consecutiveBlockedLookups = 0;
    let creativeAttempts = 0;
    let creativeBlocks = 0;
    let skipCreativeLookups = skipCreativesFromStart;
    // Default 1: a "blocked" outcome already survived the full retry/backoff
    // ladder (4 attempts), so one hard-blocked advertiser means the endpoint is
    // truly refusing this IP — stop immediately, keep the leads flowing from
    // domains. Raise via env to tolerate more before pausing.
    const CIRCUIT_BREAKER_AFTER = Number(process.env.GOOGLE_ADS_BREAKER_AFTER) || 1;
    const BREAKER_RATE_MIN_SAMPLE = Number(process.env.GOOGLE_ADS_BREAKER_MIN_SAMPLE) || 6;
    const BREAKER_RATE = Number(process.env.GOOGLE_ADS_BREAKER_RATE) || 0.6;

    // Real-time CSV flush: rebuild the file after EVERY insert and publish
    // job.csv_path on the first write, so "Download CSV" serves the growing file
    // and a blocked/interrupted/failed job still exposes everything found so far.
    let csvPathPublished = false;
    let announcedLive = false;
    const flushCsv = () => {
      try {
        const { path: p, rowsWritten } = buildCsv({ jobId: job.id, productType: job.product_type, results: getResults(job.id) });
        if (!csvPathPublished) {
          setJobCsvPath(job.id, p);
          csvPathPublished = true;
        }
        if (rowsWritten > 0 && !announcedLive) {
          announcedLive = true;
          onLog('info', `google-ads: CSV is live (${rowsWritten} ${job.product_type} row(s)) — saved from here on, survives a block/kill`);
        }
      } catch (err) {
        onLog('warn', `google-ads: incremental CSV flush failed (non-fatal): ${(err as Error).message}`);
      }
    };

    let nameSearched = 0;
    let nameSearchDisabled = false;

    const processAdvertiser = async (adv: GoogleAdsAdvertiser): Promise<void> => {
      // Stop button: don't start work on further advertisers — the CSV already
      // holds everything inserted so far; discovery's shouldStop ends the run.
      if (isCancelRequested(job.id)) return;
      if (processed >= MAX_ADVERTISERS) return;
      processed++;
      if (processed === 1) setJobPhase(job.id, 'classifying', 'resolving as discovered…');

      const dest = await resolveAdvertiserDestination(adv, { region, lookupBudget, onLog, skipCreativeLookups, mobileFocus: !cpsMode });

      // Circuit-breaker accounting — creative-endpoint outcomes only.
      if (!skipCreativeLookups && dest.attemptedCreativeLookup) {
        creativeAttempts++;
        if (dest.blocked) {
          creativeBlocks++;
          consecutiveBlockedLookups++;
        } else {
          consecutiveBlockedLookups = 0;
        }
        const consecutiveTrip = consecutiveBlockedLookups >= CIRCUIT_BREAKER_AFTER;
        const rateTrip =
          creativeAttempts >= BREAKER_RATE_MIN_SAMPLE && creativeBlocks / creativeAttempts >= BREAKER_RATE;
        if (consecutiveTrip || rateTrip) {
          skipCreativeLookups = true;
          const reason = consecutiveTrip
            ? `${consecutiveBlockedLookups} blocked in a row`
            : `${creativeBlocks}/${creativeAttempts} creative lookups blocked`;
          onLog(
            'warn',
            `google-ads: creative endpoint is blocking (${reason}) — PAUSING creative scraping (circuit breaker ON). ` +
              `Remaining advertisers resolve from their verified domain only (instant, no network). ` +
              `Everything found so far is already saved in the CSV.`,
          );
          flushCsv();
        }
      }

      // Affplus-style fallback (CPS only): advertiser has NO verified domain and
      // no creative destination → find its official site by NAME via LLM web
      // search ("use the name and search it online OR the domain, whichever
      // works"). Budgeted per job; a daily-cap hit disables further searches but
      // the job still completes with the domain-resolved leads.
      let landingUrl = dest.landingUrl;
      let destNote = dest.note;
      if (!landingUrl && cpsMode && adv.name && !nameSearchDisabled && nameSearchBudget.tryConsume()) {
        try {
          const hit = await searchAdvertiserWebsite(
            adv.name,
            `Advertiser found on Google Ads Transparency Center via keyword "${adv.matchedKeyword}"`,
            onLog,
          );
          if (hit) {
            landingUrl = hit.url;
            destNote = `name-search:${hit.confidence}`;
            nameSearched++;
          }
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            nameSearchDisabled = true;
            onLog(
              'warn',
              'google-ads: LLM daily cap reached during name-search — name-search OFF for the rest of this job (domain leads continue; already-saved leads unaffected)',
            );
          } else {
            onLog('warn', `google-ads: name-search failed for "${adv.name}" (non-fatal): ${(err as Error).message}`);
          }
        }
      }

      const cls = classifyGoogleAdsUrl(landingUrl);
      if (cls.classification === 'unknown' || !landingUrl) {
        unresolved++;
      } else {
        // Dedupe: one row per (store_url) for mobile, one per (host) for web.
        const dedupeKey = cls.store_url ? `s:${cls.store_url}` : `w:${hostOf(landingUrl)}`;
        if (insertedKeys.has(dedupeKey)) {
          dupSkipped++;
        } else {
          insertedKeys.add(dedupeKey);
          insertResult({
            job_id: job.id,
            advertiser_name: adv.name || adv.domain || adv.advertiser_id || '(unknown advertiser)',
            page_url: advertiserUrl(adv),
            landing_url: landingUrl,
            classification: cls.classification,
            store_url: cls.store_url,
            ad_text: buildAdText(adv, destNote, dest.format),
            country: adv.region || informationalCountry,
          });
          inserted++;
          setJobLeadsFound(job.id, inserted); // live counter for the UI
          if (cls.classification === 'cps_web') webCount++;
          else mobileCount++;
          flushCsv(); // real-time: the file reflects every lead the moment it lands
        }
      }

      if (processed % 10 === 0) {
        setJobPhase(job.id, 'classifying', `resolved ${processed} · ${mobileCount} mobile · ${webCount} web`);
      }
      if (processed % 25 === 0) {
        onLog(
          'info',
          `google-ads: processed ${processed} — mobile ${mobileCount}, web ${webCount}, unresolved ${unresolved} (creative-lookups left ${lookupBudget.remaining()})`,
        );
      }
    };

    const discovery = await discoverAdvertisers(keywords, {
      region,
      onLog,
      onProgress: (done, total, found) => {
        if (done % 5 === 0 || done === total) {
          setJobPhase(
            job.id,
            processed > 0 ? 'classifying' : 'scraping',
            `keyword ${done}/${total} · ${found} found · ${inserted} saved`,
          );
        }
      },
      onAdvertiser: processAdvertiser,
      shouldStop: () => processed >= MAX_ADVERTISERS || isCancelRequested(job.id),
    });
    // Stop button pressed mid-discovery: unwind now. The catch below finalizes
    // with everything already inserted (the CSV is flushed on every insert).
    throwIfCancelled(job.id);

    onLog(
      'info',
      `google-ads: discovery done — ${discovery.advertisers.length} unique advertisers from ${discovery.keywordsSearched} keywords (${discovery.requestsMade} requests); resolved ${processed}`,
    );
    for (const note of discovery.notes) onLog('warn', `google-ads: ${note}`);
    if (discovery.blocked) {
      onLog(
        'warn',
        'google-ads: some/all requests were blocked (HTTP 403/429 or a challenge page). Google fingerprints non-browser clients — results may be partial. Re-run from a residential/less-flagged IP (set GOOGLE_ADS_PROXY_URL) or lower the keyword count if this persists.',
      );
    }
    if (processed >= MAX_ADVERTISERS) {
      onLog('warn', `google-ads: hit the ${MAX_ADVERTISERS}-advertiser cap (GOOGLE_ADS_MAX_ADVERTISERS); discovery may have found more.`);
    }
    if (discovery.advertisers.length === 0) {
      onLog(
        'warn',
        'google-ads: 0 advertisers discovered. Either the keywords matched nothing or the endpoint is blocking this host. The CSV will be empty.',
      );
    }

    onLog(
      'info',
      `google-ads: classification done — inserted ${inserted} rows (mobile ${mobileCount}, web ${webCount}), unresolved ${unresolved}, dup-skipped ${dupSkipped}` +
        (nameSearched > 0 ? `, name-searches ${nameSearched}/${WEB_NAME_SEARCHES}` : ''),
    );

    // ── 4b. App-category enrichment (mobile only) — game vs non-game per app ──
    // Keyed on the app_id in each store URL; asks the store listing itself
    // (Apple genre 6014 / Play applicationCategory GAME*), permanently cached so
    // re-runs make zero store requests. Best-effort: a failure never fails the
    // job (leads still ship, just Unclassified). Runs BEFORE the CSV so the
    // app_category / is_game columns are populated in the exported file.
    throwIfCancelled(job.id);
    if (job.product_type === 'mobile') {
      try {
        const mobileRows = getResults(job.id).filter(
          (r) => (r.classification === 'mobile_google_play' || r.classification === 'mobile_app_store') && r.store_url,
        );
        if (mobileRows.length > 0) {
          setJobPhase(job.id, 'enriching', `categorizing ${mobileRows.length} app(s)`);
          const { byStoreUrl, summary } = await enrichStoreUrls(
            mobileRows.map((r) => r.store_url as string),
            onLog,
          );
          for (const r of mobileRows) {
            const rec = r.store_url ? byStoreUrl.get(r.store_url) : undefined;
            if (rec) setResultCategory(r.id, rec.category_raw, rec.is_game);
          }
          onLog(
            'info',
            `google-ads: category enrichment — ${summary.games} game, ${summary.nonGames} non-game, ${summary.unclassified} unclassified across ${summary.apps} app(s) ` +
              `(${summary.cached} cached, ${summary.requests} store request(s))`,
          );
        }
      } catch (err) {
        onLog('warn', `google-ads: category enrichment failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // ── 5. CSV (filters by product type) ──
    setJobPhase(job.id, 'building_csv', `writing ${job.product_type} CSV`);
    const allResults = getResults(job.id);
    // Operator-chosen lead cap (20/50/100/all). Resolved once and used for BOTH
    // the CSV and the HQ split below, so the Excel bundle never disagrees with the
    // CSV about how many leads this job delivered.
    const maxLeads = normalizeMaxLeads(
      job.source_params ? (JSON.parse(job.source_params) as Record<string, unknown>).maxLeads : null,
    );
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
      maxRows: maxLeads,
    });
    const exportRows = selectExportRows(allResults, job.product_type, maxLeads);
    if (maxLeads != null && rowsWritten >= maxLeads) {
      onLog('info', `google-ads: lead cap applied — exported ${rowsWritten} of ${selectExportRows(allResults, job.product_type).length} eligible leads`);
    }
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
          `google-ads: NOTE — ${webCount} WEB (cps_web) leads WERE found and ARE saved. They are excluded from a mobile CSV ` +
            `(store URLs need creative lookups, which were blocked/degraded this run). ` +
            `Download them NOW without re-scraping: /api/jobs/${job.id}/csv?product=cps`,
        );
      }
    }

    // ── 6. HQ split (mobile → store-page HQ; cps → web/domain HQ) ──
    throwIfCancelled(job.id);
    setJobPhase(job.id, 'hq_splitting', `resolving HQ for ${rowsWritten} leads`);
    try {
      if (job.product_type === 'mobile') {
        const outcome = await runHqSplit({ jobId: job.id, results: exportRows, onLog });
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
        const outcome = await runHqSplitWeb({ jobId: job.id, results: exportRows, onLog });
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

    // Burn report: what this job actually cost in proxy traffic (best-effort).
    await logProxyTrafficAfterJob(trafficBefore, onLog);

    markJobCompleted(job.id, csvPath, { ads: discovery.advertisers.length, advertisers: rowsWritten });
    onLog('info', 'google-ads job completed');

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh)
        .then(() => onLog('info', 'notification dispatched'))
        .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
    }
  } catch (err) {
    // Burn report even on failure/defer — a job that died mid-scrape is exactly
    // the one whose traffic cost you want on record. Best-effort and fail-open;
    // instant no-op when the monitor is off or the before-snapshot never landed.
    await logProxyTrafficAfterJob(trafficBefore, onLog);
    if (err instanceof JobCancelledError) {
      // Stop button: the CSV was flushed on every insert, so everything found up
      // to the stop is already on disk. Rebuild once for a clean final file and
      // finalize as cancelled — NOT failed.
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
        /* best-effort — the incrementally-flushed file (if any) remains */
      }
      markJobCancelled(job.id, `stopped by user — ${kept} lead(s) kept`, csvPath);
      onLog('warn', `google-ads job stopped by user — ${kept} partial lead(s) exported`);
      return;
    }
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

  // Spec step 14: the demoted name-token batteries must be INACTIVE BY DEFAULT.
  // Passing null (the old "all verticals" shorthand) applied no filter at all, so
  // interleave round-robined 'apps'/'apps_nongame' into the first pass and their
  // keywords were actually searched — the exact opposite of what the job log said.
  const defaultVerticals = verticalsForJob(null);
  check(
    !defaultVerticals.includes('apps') && !defaultVerticals.includes('apps_nongame'),
    'verticals: unpinned job excludes the demoted name-token batteries',
  );
  check(defaultVerticals.includes('igaming'), 'verticals: unpinned job still draws the live verticals');
  // 'games' and 'fintech' are owned by 'apps' / 'apps_nongame' (the bank dedupes
  // case-insensitively in VERTICAL_DEFS order, and those two batteries are last),
  // so their absence proves the batteries contributed nothing to the draw.
  const defaultKeywords = keywordsForJob({ verticals: defaultVerticals, limit: DEFAULT_MAX_KEYWORDS });
  check(
    !defaultKeywords.includes('games') && !defaultKeywords.includes('fintech'),
    'verticals: default keyword draw issues no name-token battery queries',
  );
  // Demotion is a default, not a prohibition — an explicit pin still activates them.
  check(
    verticalsForJob(['apps']).join(',') === 'apps' &&
      keywordsForJob({ verticals: verticalsForJob(['apps']) }).includes('games'),
    'verticals: an explicitly pinned battery still runs',
  );

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
