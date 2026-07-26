/**
 * Store-first discovery pipeline (spec IMPLEMENTATION steps 3–13, orchestration).
 *
 * The `store_first` job source. DISCOVERY is app-store data; GATC/Meta only
 * CONFIRM.
 *
 * LEAD-FIRST ORDERING. A lead is a CONFIRMED advertiser, so confirmation is the
 * only phase that produces one. It used to run once, as phase 7 of 10, behind
 * every discovery and enrichment phase — which meant a run stopped (or merely
 * slow) at any earlier point exported NOTHING, however large the corpus it had
 * already built. Measured on a real 2h34m run: 4,117 publishers rolled up,
 * 0 leads delivered, because the job never reached confirmation.
 *
 * Confirmation is now a CHECKPOINT the pipeline reaches repeatedly — the first
 * one right after the chart harvest, seconds in. Each checkpoint does rollup →
 * confirm a slice of the budget → score → write the CSV. So leads accumulate
 * from the opening minutes, a Stop at any moment exports what is on the table,
 * and a job with a lead target STOPS AS SOON AS IT IS MET instead of grinding
 * through phases whose output it no longer needs.
 *
 * HOW MUCH the first checkpoints yield depends on the corpus, and the honest
 * statement is worth having in writing: rollupPublishers builds from
 * allDoneAppDetails(), i.e. ENRICHED apps only. Against an established corpus
 * (the normal case — production carries thousands of enriched apps and
 * publishers) checkpoint 1 has a full corpus to roll up and confirm, so a small
 * order can be filled within seconds of the job starting. Against a COLD corpus
 * there is nothing enriched yet, so checkpoints 1 and 2 legitimately find
 * nothing and the first leads appear at checkpoint 3, after enrichment. Both
 * cases still beat the old pipeline, which produced nothing until 80%.
 *
 * Phases, in order:
 *   1. Chart harvest        — Play TOP_FREE/TOP_GROSSING + Apple top-free per
 *                             active vertical × market (source=chart, depth 0).
 *   2. Similar crawl (Play) — BFS from chart apps to SIMILAR_MAX_DEPTH, bounded by
 *                             similarMaxAppsPerRun NEW apps; never crawls FROM a
 *                             max-depth app (source=similar).
 *   3. Search battery       — every tail term × vertical × market against Play and
 *                             iTunes search (source=search).
 *   4. Enrichment           — cache-first detail + install-band gate (storeEnrich).
 *   5. Dev-catalog expand    — full Play/Apple portfolios for publishers with a
 *                             contact, then a second enrichment pass.
 *  5b. Liveness sweep       — re-checks least-recently-verified known apps and
 *                             tombstones the ones the stores no longer list, so a
 *                             permanent never-re-fetched catalog cannot drift.
 *   6. Liveness sweep       — see 5b.
 *   -- LEAD CHECKPOINT --   — rollup + confirmation (GATC RPC + optional Meta,
 *                             budgeted) + scoring + CSV. Runs after the charts,
 *                             after discovery, after enrichment and at the end;
 *                             any of them may finish the job early once the
 *                             requested lead count is on the table.
 *   7. HQ split             — the per-HQ-country .xlsx bundle every other source
 *                             emits, so one run yields one Excel with no second
 *                             search and no separate confirmation step.
 *
 * Store calls are free and internally throttled; the only paid surface is GATC
 * confirmation (residential proxy). Everything degrades gracefully — a blocked
 * store/RPC call is skipped, never thrown, so a run always produces its CSV.
 */

import {
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  markJobCancelled,
  setJobPhase,
  setJobLeadsFound,
  setJobProgress,
  appendLog,
  getJob,
  getDb,
  getResults,
  clearJobResults,
  setJobHqZipPath,
  setJobCsvPath,
  type JobRow,
} from './db.js';
import { JobCancelledError, throwIfCancelled, isCancelRequested } from './jobControl.js';
import { runHqSplit } from './hqSplit.js';
import { BudgetExceededError, spentTodayUsd, DAILY_CAP_USD } from './llmBudget.js';
import {
  resolveStoreParams,
  verticalById,
  tailSearchTerms,
  SIMILAR_MAX_DEPTH,
  SIMILAR_MAX_REQUESTS_PER_RUN,
  SEARCH_MAX_REQUESTS_PER_RUN,
  EXPORT_CONFIRMED_ONLY,
  LIVENESS_MAX_PLAY_PER_RUN,
  LIVENESS_MAX_APPLE_PER_RUN,
  LIVENESS_RECHECK_AFTER_DAYS,
  DEV_CATALOG_MAX_PER_RUN,
  DEV_CATALOG_MAX_APPS_PER_RUN,
  ENRICH_MAX_APPS_PER_RUN,
  WINNER_ENRICH_MAX_PUBLISHERS,
  WINNER_ENRICH_APPS_PER_PUBLISHER,
} from './storeDiscoveryConfig.js';
import {
  upsertDiscoveredApp,
  distinctAppsForStore,
  similarSeedApps,
  sightedCountrySql,
  discoveredCountsBySource,
  countDiscoveredApps,
  countPublishers,
  countConfirmedPublishers,
  countPublishersWithEmail,
  playDevelopersWithContact,
  appleArtistsWithContact,
  listPublishersByScore,
  listPublishersForConfirmation,
  countDoneAppDetails,
  unenrichedAppsForPlayDevelopers,
  listLivenessCandidates,
  markAppLiveness,
  countDelistedApps,
  type StoreKind,
} from './storeDiscoveryDb.js';
import { expandPlayCategories, playChart, playSimilar, playDeveloper, playSearch, playAppLiveness } from './playSource.js';
import { appleChart, appleDeveloper, appleSearch, appleLiveness } from './appleSource.js';
import { enrichApps, type EnrichWorkItem, type EnrichSummary } from './storeEnrich.js';
import { rollupPublishers, rollupProvisionalPlayPublishers, resetFastLaneCache } from './publisherRollup.js';
import { confirmPublishers, filterUncheckedSince, type ConfirmSummary } from './storeConfirm.js';
import { scoreAllPublishers } from './publisherScore.js';
import {
  buildPublisherCsv,
  leadHistorySeed,
  persistPublisherLeads,
  dedupePublishers,
  type DedupeSeed,
} from './storeLeads.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { log } from './logger.js';

type OnLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

export async function runStoreDiscoveryJob(job: JobRow): Promise<void> {
  markJobRunning(job.id);
  const onLog: OnLog = (level, msg) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };
  onLog('info', `store-first discovery job started`);

  // Handle for the catch blocks: the background lead pump is created inside the
  // try (it needs the parsed params), but a thrown JobCancelledError or any
  // failure must still be able to land it before finalizing.
  let shutdownPump: (() => Promise<void>) | null = null;

  try {
    const params = resolveStoreParams(job.source_params ? JSON.parse(job.source_params) : null);
    onLog(
      'info',
      `active: verticals=[${params.verticals.join(',')}] markets=[${params.markets.join(',')}] ` +
        `charts=play:${params.playCharts.join('+')}/apple:${params.appleCharts.join('+')} ` +
        `similarCap=${params.similarMaxAppsPerRun} searchTerms/vert=${params.searchTermsLimit ?? 'all'} confirmBudget=${params.confirmationMaxApiCalls}`,
    );

    purgeUsEraGeoStamps(onLog);
    // The fast lane's change detector is module state; clear it so THIS run
    // never inherits the previous job's "nothing new" verdict.
    resetFastLaneCache();

    // Resume-safety: a STOPPED run may have exported partial leads under this
    // job id (finalizeCancelledStoreJob persists them so the partial CSV is
    // real). Those rows also feed leadHistorySeed's cross-job dedupe, so on a
    // RESUME they would mark the job's own partial export as "already
    // delivered" and silently drop it from the final CSV. Clearing this job's
    // own rows re-opens exactly those leads to this run — no-op on a fresh job.
    clearJobResults(job.id);

    // Overall progress across EVERY phase, as weighted spans of 0..100 (rough
    // wall-clock shares). Each phase reports fraction-done inside its span;
    // setJobProgress is monotonic, so concurrent streams can't move it backwards
    // and an early-finishing phase just jumps to its span end at the barrier.
    //
    // Lead checkpoints are interleaved, so the discovery phases were compressed
    // to make room for them:
    //   charts 0-6 · CHECKPOINT 6-18 · similar+search 18-32 · CHECKPOINT 32-40 ·
    //   enrich 40-58 · CHECKPOINT 58-66 · catalogs 66-74 · liveness 74-78 ·
    //   FINAL CHECKPOINT 78-95 · HQ split 95-100 (completion pins 100).
    // A checkpoint that meets the lead target jumps straight to the HQ split.
    const span = (base: number, width: number, frac: number) =>
      setJobProgress(job.id, base + width * Math.max(0, Math.min(1, frac)));

    // ── Lead harvesting (see the LEAD-FIRST ORDERING note at the top) ────────
    //
    // State shared by every checkpoint. The confirmation budget is a single
    // per-run pool spent across all of them, so repeated checkpoints cost the
    // operator no more paid calls than the old single terminal pass did —
    // listPublishersForConfirmation orders never-confirmed first, so each
    // checkpoint advances through the backlog rather than re-checking the head.
    // Run counters. Declared UP HERE, not at the phase that computes them,
    // because finishRun() reads all of them and any checkpoint may call it —
    // a `const` declared at its phase would still be in the temporal dead zone
    // when an early exit runs, crashing the very fast path this restructure adds.
    let chartRows = 0;
    let newSimilar = 0;
    let searchRows = 0;
    let catalogApps = 0;
    let enrichSummary: EnrichSummary = {
      apps: 0, enriched: 0, cached: 0, failed: 0, games: 0, nonGames: 0, unclassified: 0,
      inBand: 0, outOfBand: 0, requests: 0, cappedOut: 0, budgetLeft: ENRICH_MAX_APPS_PER_RUN,
    };

    // Everything below is shared by the BACKGROUND LEAD PUMP and the phase
    // barriers. runStartTs scopes the confirmation dedupe: a publisher checked
    // at/after this instant is never re-charged by a later pass of this run.
    const runStartTs = Date.now();
    let confirmSpent = 0;
    // Run-wide confirmation totals. There are several confirmation passes now, so
    // the summary must aggregate them; `queued` is a snapshot of the eligible
    // backlog, so it takes the LAST pass's value rather than a meaningless sum.
    const confirmTotals: ConfirmSummary = {
      queued: 0, processed: 0, apiCalls: 0, confirmed: 0, gatcHits: 0, metaHits: 0,
      skipped: false, reachedTarget: false, note: '',
    };
    let confirmPasses = 0;
    let leadsOnTable = 0;
    let csvPath: string | null = null;
    let leadTargetMet = false;

    /**
     * Publishers that would actually land in the CSV right now: confirmed, minus
     * the ones earlier jobs already delivered.
     *
     * This is deliberately the DEDUPED count. The live counter used to report
     * countConfirmedPublishers() — corpus-wide, including leads long since
     * exported by other jobs — so the UI could sit at "20 leads" while the CSV
     * held three. `seed` is passed in and computed once per checkpoint: nothing
     * persists into job_results mid-checkpoint, so it cannot go stale inside one.
     */
    const exportableNow = (seed: DedupeSeed): number => dedupePublishers(leadEligiblePublishers(), seed).length;

    /**
     * Turn the corpus as it stands into leads, then report whether the job can
     * stop. rollup + scoring are pure local DB work (measured at ~1s on a
     * 4,000-publisher corpus), so running them per checkpoint is free next to a
     * single confirmation RPC.
     *
     * Returns true when the requested lead count is on the table — the caller
     * skips straight to the finish.
     */
    // Serializes every lead-harvest pass (background pump ticks AND phase
    // barriers) — two concurrent confirmPublishers loops would race the shared
    // budget and double-check the queue head. A plain promise chain is enough:
    // callers append, everyone runs strictly in order.
    let pumpChain: Promise<void> = Promise.resolve();
    const queueHarvest = (
      label: string,
      phase: 'scraping' | 'enriching' | 'classifying',
      base: number,
      width: number,
      quiet = false,
    ): Promise<boolean> => {
      let met = false;
      pumpChain = pumpChain
        .then(async () => {
          met = await harvestLeads(label, phase, base, width, quiet);
        })
        .catch((e) => {
          // A pump failure must never kill the job — harvest is best-effort on
          // top of a pipeline that must always deliver its CSV.
          onLog('warn', `lead pump pass "${label}" failed (non-fatal): ${(e as Error).message}`);
        });
      return pumpChain.then(() => met);
    };

    const harvestLeads = async (
      label: string,
      /**
       * The COARSE phase to report while this checkpoint runs.
       *
       * The UI stepper is an ordered list (scraping → classifying → enriching →
       * building_csv), so a checkpoint that always reported 'classifying' would
       * drive it BACKWARDS every time the run returned to discovery or
       * enrichment. Each checkpoint therefore reports the stage it sits in and
       * the checkpoint activity rides in phase_detail, which keeps the stepper
       * monotonic while still naming what is actually happening.
       */
      phase: 'scraping' | 'enriching' | 'classifying',
      progressBase: number,
      progressWidth: number,
      /**
       * Background pump pass: touch NEITHER the coarse phase NOR the progress
       * bar. The pump runs continuously alongside whatever phase is active, so
       * reporting its own phase would drag the ordered UI stepper BACKWARDS
       * (a tick during 'enriching' would rewind it to 'scraping') and its
       * zero-width span would be meaningless on the bar. The live signal a
       * pump tick produces is the LEAD COUNTER and the growing CSV, which are
       * updated regardless.
       */
      quiet = false,
    ): Promise<boolean> => {
      if (!quiet) setJobPhase(job.id, phase, `finding advertisers — ${label}`);
      // rollup/scoring log at INFO unconditionally. On a 15-second pump that is
      // two lines a tick forever ("rollup: 0 publishers" x hundreds), which
      // buries the run's real story. Background passes therefore pass a silent
      // logger; barrier passes keep the full output.
      const passLog: OnLog = quiet ? () => {} : onLog;
      // FAST LANE FIRST. rollupPublishers() only sees ENRICHED apps, so on a cold
      // corpus it returns 0 publishers however much has been discovered — which
      // is exactly why a production run sat at "rollup: 0 publishers" for minutes
      // after harvesting 8,105 apps. This turns Play list-payload identity
      // (developer + developerId, already in hand) into confirmable publishers
      // immediately. It merges into the same rows the full rollup produces.
      rollupProvisionalPlayPublishers(passLog);
      rollupPublishers(passLog);

      const budgetLeft = Math.max(0, params.confirmationMaxApiCalls - confirmSpent);
      const seed = leadHistorySeed();
      const target = params.maxLeads;

      // CORPUS FAST PATH: the shared corpus is permanent, so an order small
      // enough to be filled from publishers ALREADY confirmed by earlier runs
      // needs no confirmation at all. Checked before the budget is touched, so
      // such a job costs zero paid API calls (and zero residential proxy
      // traffic) and finishes in the time it takes to roll up and write a CSV.
      const alreadyDeliverable = exportableNow(seed);
      const orderAlreadyFilled = target != null && alreadyDeliverable >= target;
      if (orderAlreadyFilled) {
        onLog(
          'info',
          `checkpoint "${label}": corpus already holds ${alreadyDeliverable} deliverable lead(s) ` +
            `(target ${target}) — skipping confirmation entirely, no API calls spent`,
        );
      }

      // Nothing new to check ⇒ no pass. Keeps background ticks free when the
      // discovery streams have not produced a new publisher since last time.
      const uncheckedNow = filterUncheckedSince(listPublishersForConfirmation(), runStartTs).length;

      if (budgetLeft > 0 && !orderAlreadyFilled && uncheckedNow > 0) {
        // Recomputed in onProgress and READ by `enough`. storeConfirm calls
        // onProgress before enough, so this is always current; evaluating
        // exportableNow() in both would scan the publisher table twice per
        // confirmation for the same answer.
        //
        // Only recomputed when the confirmed count actually MOVED: exportableNow
        // is a full publisher scan plus a dedupe pass, and a publisher that came
        // back "not advertising" cannot have changed the exportable total. On a
        // large corpus this is the difference between one scan per API call and
        // one scan per actual lead.
        let liveExportable = alreadyDeliverable;
        let lastConfirmedSeen = -1;
        const confirm = await confirmPublishers({
          maxApiCalls: budgetLeft,
          onLog,
          // One warm-up per RUN (module-global cookie jar) and never re-check a
          // publisher this run already answered for — both matter now that
          // passes run continuously instead of once.
          skipWarmUp: confirmPasses > 0,
          skipConfirmedSince: runStartTs,
          shouldStop: () => isCancelRequested(job.id),
          // Stop the moment the order is filled. Without this a 20-lead job
          // spent its entire budget (and the proxy spend behind it) long after
          // the 20th lead had landed.
          enough: target == null ? undefined : () => liveExportable >= target,
          onProgress: (st) => {
            if (st.confirmed !== lastConfirmedSeen) {
              lastConfirmedSeen = st.confirmed;
              liveExportable = exportableNow(seed);
              setJobLeadsFound(job.id, liveExportable);
            }
            if (!quiet) {
              span(progressBase, progressWidth, st.processed / Math.max(1, st.queued));
              if (st.processed % 10 === 0) {
                setJobPhase(
                  job.id,
                  phase,
                  `finding advertisers — ${label} · ${st.processed}/${st.queued} checked, ${st.confirmed} advertising`,
                );
              }
            }
          },
        });
        confirmSpent += confirm.apiCalls;
        confirmPasses++;
        confirmTotals.queued = confirm.queued;
        confirmTotals.processed += confirm.processed;
        confirmTotals.apiCalls += confirm.apiCalls;
        confirmTotals.confirmed += confirm.confirmed;
        confirmTotals.gatcHits += confirm.gatcHits;
        confirmTotals.metaHits += confirm.metaHits;
        // "skipped" only stands if EVERY pass was skipped (cooldown / no provider).
        confirmTotals.skipped = confirm.skipped && (confirmPasses === 1 || confirmTotals.skipped);
        confirmTotals.reachedTarget = confirmTotals.reachedTarget || confirm.reachedTarget;
        confirmTotals.note = confirm.note;
      }

      // ── ENRICH ONLY THE WINNERS ──────────────────────────────────────────
      // The funnel inversion. A confirmed publisher is a LEAD, and a lead needs
      // contact details (email/website) that only a detail page carries — but
      // that is now a handful of fetches for the publishers that actually made
      // it, instead of ~8,000 for a corpus of which ~20 ever become leads.
      await enrichConfirmedWinners(passLog);
      // Re-roll so the freshly fetched emails/websites land on the rows before
      // they are scored and exported.
      rollupPublishers(passLog);

      // Export EVERY time, so a stop (or a crash) at any later point still has a
      // complete, downloadable CSV sitting on disk for this job.
      scoreAllPublishers(passLog);
      leadsOnTable = exportLeadsSoFar();
      setJobLeadsFound(job.id, leadsOnTable);
      if (!quiet) setJobProgress(job.id, progressBase + progressWidth);

      if (params.maxLeads != null && leadsOnTable >= params.maxLeads) {
        leadTargetMet = true;
        onLog(
          'info',
          `lead target met: ${leadsOnTable}/${params.maxLeads} leads after "${label}" ` +
            `(${confirmSpent}/${params.confirmationMaxApiCalls} confirmation calls spent) — skipping the remaining discovery phases`,
        );
        return true;
      }
      if (!quiet) onLog('info', `checkpoint "${label}": ${leadsOnTable} lead(s) exportable so far`);
      return false;
    };

    /**
     * (Re)write this job's CSV from the confirmed corpus and persist the rows
     * into the shared lead store. Rebuilt from scratch each checkpoint rather
     * than appended: clearJobResults first means the job's OWN earlier rows
     * never dedupe its later export away (the same trap the resume path fixed),
     * and the result is idempotent, so the file on disk is always the complete
     * current answer instead of a partial that a later crash would freeze.
     */
    /**
     * Fetch detail pages for CONFIRMED publishers that still have none.
     *
     * This is the payoff of the fast lane: confirmation can now happen on
     * list-payload identity alone, so the expensive 1.2 MB-per-app detail fetch
     * is spent only on publishers that already proved they advertise. A lead
     * still needs its email/website, so those apps are enriched here, on demand,
     * capped per pass so one checkpoint cannot turn into a full enrichment run.
     *
     * Draws on the run's SHARED enrichment budget, so this never increases a
     * run's total fetch count — it re-prioritises it toward leads.
     */
    async function enrichConfirmedWinners(passLog: OnLog): Promise<void> {
      if (enrichSummary.budgetLeft <= 0) return;
      // A confirmed publisher with no contact details is a lead we cannot ship.
      // Provisional (fast-lane) rows are exactly these: identity + chart facts
      // from the list payload, no detail page yet.
      const needy = leadEligiblePublishers()
        .filter((p) => p.name && !p.email && !p.website)
        .slice(0, WINNER_ENRICH_MAX_PUBLISHERS);
      if (needy.length === 0) return;

      const work: EnrichWorkItem[] = [];
      const seen = new Set<string>();
      for (const p of needy) {
        // Match on the publisher's own name — the same string the list payload
        // stored in discovered_apps.list_developer.
        for (const a of unenrichedAppsForPlayDevelopers([p.name], WINNER_ENRICH_APPS_PER_PUBLISHER)) {
          const k = `${a.app_id}|${a.country}`;
          if (seen.has(k)) continue;
          seen.add(k);
          work.push({ store: 'google_play', app_id: a.app_id, is_chart: false, country: a.country });
        }
      }
      if (work.length === 0) return;

      const budget = Math.min(work.length, enrichSummary.budgetLeft);
      passLog('info', `winners: enriching ${budget} app(s) across ${needy.length} confirmed publisher(s) for contact details`);
      const res = await enrichApps(work, passLog, {
        shouldStop: () => isCancelRequested(job.id),
        fetchBudget: budget,
      });
      // Spend comes out of the run's single pool.
      enrichSummary.budgetLeft = Math.max(0, enrichSummary.budgetLeft - (budget - res.budgetLeft));
      enrichSummary.enriched += res.enriched;
      enrichSummary.requests += res.requests;
    }

    function exportLeadsSoFar(): number {
      const out = rebuildJobLeadExport(job.id, params.maxLeads);
      const firstExport = csvPath == null;
      csvPath = out.path;
      // REAL-TIME deliverable: point job.csv_path at the file the moment it
      // first exists, exactly like the CPS pipeline's incremental flush. The
      // download route serves it from then on, so the user watches the Excel
      // GROW during the run instead of discovering it after the fact.
      if (firstExport) setJobCsvPath(job.id, out.path);
      return out.rowsWritten;
    }

    // ── THE BACKGROUND LEAD PUMP ─────────────────────────────────────────────
    // The user's actual mental model, made literal: scrape an app → look its
    // publisher up on Ads Transparency → if it advertises, it is IN THE EXCEL —
    // continuously, while discovery keeps running. The pump ticks every
    // PUMP_INTERVAL_MS, and each tick is a no-op unless the discovery streams
    // rolled up NEW unchecked publishers since the last tick, so idle ticks
    // cost zero network and zero budget. Ticks serialize with the phase
    // barriers through queueHarvest, and every pass draws on the run's single
    // confirmation budget with skipConfirmedSince dedupe — total spend is
    // IDENTICAL to the old single terminal pass, only the timing moves.
    const PUMP_INTERVAL_MS = 15_000;
    let pumpShutdown = false;
    let lastEnrichedSeen = -1;
    const pumpDone = (async () => {
      while (!pumpShutdown) {
        // Sleep in 1s slices so cancel/target/shutdown react promptly.
        for (let waited = 0; waited < PUMP_INTERVAL_MS && !pumpShutdown; waited += 1_000) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
        if (pumpShutdown || leadTargetMet || isCancelRequested(job.id)) break;
        if (confirmSpent >= params.confirmationMaxApiCalls) break; // budget dry — barriers handle the rest
        // Nothing new enriched AND nothing new to confirm ⇒ a rollup would
        // reach the identical answer, so skip the tick entirely. One indexed
        // COUNT instead of loading the whole corpus every 15 seconds.
        const enrichedNow = countDoneAppDetails();
        const uncheckedNow = filterUncheckedSince(listPublishersForConfirmation(), runStartTs).length;
        if (enrichedNow === lastEnrichedSeen && uncheckedNow === 0) continue;
        lastEnrichedSeen = enrichedNow;

        const before = leadsOnTable;
        await queueHarvest('live', 'scraping', 0, 0, true); // quiet: no phase/progress writes
        if (leadsOnTable > before) {
          onLog('info', `lead pump: ${leadsOnTable} lead(s) now in the export (+${leadsOnTable - before} since last check)`);
        }
      }
    })();
    /** Stop the pump and wait for any in-flight pass to land. Every exit path
     *  (finish, cancel, failure) MUST call this before finalizing. */
    const stopPump = async (): Promise<void> => {
      pumpShutdown = true;
      await pumpDone.catch(() => {});
      await pumpChain.catch(() => {});
    };
    shutdownPump = stopPump;

    // ── Phase 1: chart harvest — Play and Apple streams CONCURRENTLY ─────────
    // The two stores have independent rate limiters (Play ~5 req/s spread over
    // PLAY_CONCURRENCY streams, iTunes 1 req/3s), so running them serially paid
    // Play-time PLUS Apple-time for no
    // reason. Two streams over the same (vertical x market) grid, each behind
    // its own limiter, finish in max() instead of sum() — the same requests,
    // the same politeness, roughly half the wall-clock.
    setJobPhase(job.id, 'scraping', 'charts');
    const chartCells: Array<{ v: NonNullable<ReturnType<typeof verticalById>>; market: string }> = [];
    for (const vId of params.verticals) {
      const v = verticalById(vId);
      if (!v) continue;
      for (const market of params.markets) chartCells.push({ v, market });
    }
    let playCellsDone = 0;
    let appleCellsDone = 0;
    const chartProgress = () => {
      setJobPhase(
        job.id,
        'scraping',
        `charts — Play ${playCellsDone}/${chartCells.length} · Apple ${appleCellsDone}/${chartCells.length}`,
      );
      span(0, 6, (playCellsDone + appleCellsDone) / Math.max(1, chartCells.length * 2));
    };
    const playChartsTask = async () => {
      for (const { v, market } of chartCells) {
        if (isCancelRequested(job.id) || leadTargetMet) return; // stop/target: unwound after the barrier
        const playCats = expandPlayCategories(v.play, !!v.expandGames);
        for (const chart of params.playCharts) {
          for (const cat of playCats) {
            const apps = await playChart(cat, chart, market, onLog);
            apps.forEach((a, i) => {
              upsertDiscoveredApp({
                store: 'google_play', app_id: a.appId, title: a.title, vertical: v.id, country: market,
                source: 'chart', discovery_depth: 0, chart, rank: i + 1,
                // Publisher identity rides along in the list payload we already
                // paid for — this is what the fast lane rolls up, so a charted
                // publisher is confirmable before any detail page is fetched.
                list_developer: a.developer, list_developer_id: a.developerId,
              });
            });
            chartRows += apps.length;
          }
        }
        playCellsDone++;
        chartProgress();
      }
    };
    const appleChartsTask = async () => {
      for (const { v, market } of chartCells) {
        if (isCancelRequested(job.id) || leadTargetMet) return;
        for (const _c of params.appleCharts) {
          const apps = await appleChart(v.appleGenre, market, onLog);
          apps.forEach((a, i) => {
            upsertDiscoveredApp({
              store: 'app_store', app_id: a.appId, title: a.title, vertical: v.id, country: market,
              source: 'chart', discovery_depth: 0, chart: 'top-free', rank: i + 1,
            });
          });
          chartRows += apps.length;
        }
        appleCellsDone++;
        chartProgress();
      }
    };
    await Promise.all([playChartsTask(), appleChartsTask()]);
    throwIfCancelled(job.id);
    onLog('info', `charts done: ${chartRows} chart sightings; ${countDiscoveredApps()} distinct (store,app,country) rows`);

    // ── LEAD CHECKPOINT 1 — the cheapest, highest-yield one ──────────────────
    // Charted publishers are the TOP tier of listPublishersForConfirmation's
    // priority order, and the chart harvest that produces them is the fastest
    // phase in the pipeline (48s on a measured single-market run). So the first
    // leads can be on the table about a minute into a job, and a small order is
    // frequently filled here outright — before a single enrichment fetch.
    if (await queueHarvest('top charts', 'scraping', 6, 12)) return await finishRun();
    throwIfCancelled(job.id);

    // ── Phases 2+3: similar crawl (Play) OVERLAPPED with the search battery ──
    //
    // The similar crawl is Play-only, so the iTunes limiter used to sit idle for
    // its whole duration — and then the search battery paid 6s per cell waiting
    // on iTunes. Restructured into two concurrent tracks:
    //   • Play track:  similar crawl, then the Play half of the search battery.
    //   • Apple track: the Apple half of the search battery, immediately.
    // Each store half keeps its own per-(store, cell) rotation stamp, so the
    // capped budget still sweeps the whole grid across runs per store. Total
    // requests spent are unchanged; the wall-clock is max(tracks), not the sum.
    setJobPhase(job.id, 'scraping', 'similar crawl + store search');
    ensureSimilarCrawlTable();
    ensureSearchBatteryTables();

    const searchCells: SearchCell[] = [];
    for (const vId of params.verticals) {
      let terms = tailSearchTerms(vId);
      if (params.searchTermsLimit != null) terms = terms.slice(0, params.searchTermsLimit);
      for (const market of params.markets) {
        for (const term of terms) searchCells.push({ vertical: vId, market, term });
      }
    }
    // Half the request budget per store — same total spend as the old combined
    // loop, which charged 2 requests per cell.
    const perStoreSearchBudget = Math.floor(SEARCH_MAX_REQUESTS_PER_RUN / 2);

    // Phase 2+3 progress: one shared counter over the phase's request budget
    // (similar-crawl requests + both search halves). Budgets are upper bounds,
    // so an early finish just jumps to the span end at the barrier below.
    let p23done = 0;
    const p23total = Math.max(
      1,
      Math.min(SIMILAR_MAX_REQUESTS_PER_RUN, params.similarMaxAppsPerRun > 0 ? SIMILAR_MAX_REQUESTS_PER_RUN : 0) +
        Math.min(perStoreSearchBudget, searchCells.length) * 2,
    );
    const p23tick = () => span(18, 14, ++p23done / p23total);

    /** One store's half of the battery: LRU-ordered over ITS OWN stamps. */
    const runSearchStore = async (store: StoreKind): Promise<{ cells: number; rows: number }> => {
      const ordered = orderByProgress(searchCells, searchCellKey, searchCellTimesForStore(store));
      let cells = 0;
      let rows = 0;
      for (const cell of ordered) {
        if (isCancelRequested(job.id) || leadTargetMet) break; // stop/target: unwound after the barrier
        if (cells >= perStoreSearchBudget) break;
        cells++;
        // Stamped whether or not it yields — a barren or blocked cell goes to the
        // BACK of this store's rotation rather than re-consuming budget.
        markSearchCellForStore(store, cell);
        const apps =
          store === 'google_play'
            ? await playSearch(cell.term, cell.market, onLog)
            : await appleSearch(cell.term, cell.market, onLog);
        p23tick();
        for (const a of apps) {
          upsertDiscoveredApp({
            store, app_id: a.appId, title: a.title, vertical: cell.vertical, country: cell.market, source: 'search',
            // Only the Play half carries a stable developerId; the Apple search
            // shape has no equivalent, and the fast lane is Play-only by design.
            list_developer: store === 'google_play' ? (a as { developer?: string }).developer : null,
            list_developer_id: store === 'google_play' ? (a as { developerId?: string }).developerId : null,
          });
        }
        rows += apps.length;
      }
      return { cells, rows };
    };

    /** The similar crawl, unchanged in logic — only lifted so the Play track can
     *  sequence it before its search half. Returns {newApps, requests}. */
    const runSimilarCrawl = async (): Promise<{ newApps: number; requests: number }> => {
      let newSimilar = 0;
      let similarRequests = 0;
      const crawledAt = similarCrawlTimes('google_play');
      outer: for (let depth = 0; depth < SIMILAR_MAX_DEPTH; depth++) {
        if (newSimilar >= params.similarMaxAppsPerRun) break;
        // Seeds are Play apps of the ACTIVE verticals whose shallowest graph
        // sighting is exactly this depth; never-crawled first, then least-recent
        // (the anti-starvation rotation — see orderByProgress).
        const seeds = orderByProgress(
          similarSeedApps('google_play', depth, params.verticals),
          (s) => s.app_id,
          crawledAt,
        );
        const fresh = seeds.filter((s) => !crawledAt.has(s.app_id)).length;
        onLog(
          'info',
          `similar depth ${depth}: ${seeds.length} seeds (${fresh} never crawled) ` +
            `(new so far ${newSimilar}/${params.similarMaxAppsPerRun})`,
        );
        for (const seed of seeds) {
          if (isCancelRequested(job.id) || leadTargetMet) break outer; // stop/target: unwound after the barrier
          if (newSimilar >= params.similarMaxAppsPerRun) break outer;
          // Independent REQUEST bound. Without it a saturated graph inserts
          // nothing, never reaches the app cap, and re-walks every seed for hours.
          if (similarRequests >= SIMILAR_MAX_REQUESTS_PER_RUN) {
            onLog('warn', `similar crawl hit request cap ${SIMILAR_MAX_REQUESTS_PER_RUN} — stopping crawl`);
            break outer;
          }
          similarRequests++;
          // Stamped whether or not this seed yields anything — spent budget sends
          // it to the back of the queue either way.
          markSimilarCrawled('google_play', seed.app_id);
          // Queried in the seed's own storefront (geo-restricted seeds resolve
          // only there).
          const sims = await playSimilar(seed.app_id, seed.country, onLog);
          p23tick();
          for (const a of sims) {
            const { inserted } = upsertDiscoveredApp({
              store: 'google_play', app_id: a.appId, title: a.title, country: seed.country,
              // Inherit the seed's vertical so deeper levels stay attributable.
              vertical: seed.vertical,
              source: 'similar', discovery_depth: depth + 1,
              list_developer: a.developer, list_developer_id: a.developerId,
            });
            if (inserted) {
              newSimilar++;
              if (newSimilar >= params.similarMaxAppsPerRun) {
                onLog('warn', `similar crawl hit cap ${params.similarMaxAppsPerRun} — stopping crawl`);
                break outer;
              }
            }
          }
        }
      }
      return { newApps: newSimilar, requests: similarRequests };
    };

    const [playTrack, appleSearchHalf] = await Promise.all([
      (async () => {
        const similar = await runSimilarCrawl();
        onLog('info', `similar crawl done: +${similar.newApps} new apps from ${similar.requests} requests`);
        setJobPhase(job.id, 'scraping', 'store search (Play half)');
        const search = await runSearchStore('google_play');
        return { similar, search };
      })(),
      runSearchStore('app_store'),
    ]);
    throwIfCancelled(job.id);
    newSimilar = playTrack.similar.newApps;
    searchRows = playTrack.search.rows + appleSearchHalf.rows;
    onLog(
      'info',
      `search battery done: Play ${playTrack.search.cells} + Apple ${appleSearchHalf.cells} cells ` +
        `(budget ${perStoreSearchBudget}/store), ${searchRows} sightings; ${countDiscoveredApps()} distinct rows total`,
    );
    if (playTrack.search.cells >= perStoreSearchBudget || appleSearchHalf.cells >= perStoreSearchBudget) {
      onLog(
        'warn',
        `search battery capped at ${SEARCH_MAX_REQUESTS_PER_RUN} requests — remaining cells deferred ` +
          `to the next run (least-recently-searched first, per store)`,
      );
    }

    setJobProgress(job.id, 32); // phase 2+3 barrier

    // ── LEAD CHECKPOINT 2 — after the long-tail discovery ────────────────────
    // The similar crawl and the search battery add the tail publishers that the
    // charts miss; confirm what they found BEFORE paying for enrichment, which
    // is by far the most expensive phase in the run.
    if (await queueHarvest('long-tail discovery', 'scraping', 32, 8)) return await finishRun();
    throwIfCancelled(job.id);

    // ── Phase 4: enrichment (+ install-band gate) ────────────────────────────
    setJobPhase(job.id, 'enriching', 'app detail');
    const stopCheck = {
      // The pump can satisfy the lead target MID-ENRICHMENT — from that moment
      // every further store fetch is pure waste, so the streams drain out here
      // exactly like a user Stop, except the job then completes successfully.
      shouldStop: () => isCancelRequested(job.id) || leadTargetMet,
      onProgress: (done: number, total: number) => span(40, 18, done / Math.max(1, total)),
    };
    // ONE fetch budget for the whole run, threaded through both enrichment
    // passes. It used to be a fresh ENRICH_MAX_APPS_PER_RUN per call, so a run
    // quietly spent up to double the configured ceiling.
    enrichSummary = await enrichApps(buildWorklist(), onLog, {
      ...stopCheck,
      fetchBudget: ENRICH_MAX_APPS_PER_RUN,
    });
    logEnrich(onLog, 'enrichment', enrichSummary);
    throwIfCancelled(job.id);
    setJobProgress(job.id, 58);

    // ── LEAD CHECKPOINT 3 — after enrichment ─────────────────────────────────
    // Enrichment is what unlocks the in-band tail tiers (an app needs its
    // install count and developer contact before it can qualify), so this is
    // where the tail publishers become confirmable.
    if (await queueHarvest('enriched catalog', 'enriching', 58, 8)) return await finishRun();
    throwIfCancelled(job.id);

    // Target met mid-enrichment (pump) drains the streams and lands here —
    // everything after this point is corpus upkeep the filled order does not
    // need, so go straight to the finish.
    if (leadTargetMet) return await finishRun();

    // ── Phase 5: developer-catalog expansion, then a second enrichment pass ──
    setJobPhase(job.id, 'enriching', 'developer catalogs');
    catalogApps = await expandDeveloperCatalogs(onLog, job.id);
    setJobProgress(job.id, 70);
    if (catalogApps > 0) {
      onLog('info', `dev-catalog: +${catalogApps} portfolio apps discovered; re-enriching`);
      // Relabel: this is a SECOND enrichment pass, not the catalog fetch. Leaving
      // the detail on "developer catalogs" is precisely what made the reported
      // job look frozen — it sat at 73% under that label for the better part of
      // an hour while it was actually enriching.
      setJobPhase(job.id, 'enriching', `app detail (portfolio pass — ${catalogApps} new apps)`);
      // Spends only what the FIRST pass left of the run's single fetch budget.
      // Previously this call received a fresh full budget, so one run could make
      // 2x ENRICH_MAX_APPS_PER_RUN network fetches (measured: 3,202 + 2,480
      // against a stated cap of 4,000) — the single largest block of wall-clock
      // in the whole pipeline, most of it spent re-walking backlog rather than
      // the catalog apps this pass exists to enrich.
      enrichSummary = await enrichApps(buildWorklist(), onLog, {
        shouldStop: stopCheck.shouldStop,
        onProgress: (done, total) => span(70, 4, done / Math.max(1, total)),
        fetchBudget: enrichSummary.budgetLeft,
      });
      logEnrich(onLog, 're-enrichment', enrichSummary);
    }
    throwIfCancelled(job.id);
    setJobProgress(job.id, 74);

    if (leadTargetMet) return await finishRun(); // pump satisfied the order during catalogs

    // ── Phase 5b: liveness sweep — drop apps the stores no longer list ───────
    // The catalog is permanent and never re-fetched, which is what makes repeat
    // runs fast; this is the counterweight that keeps it honest. Runs BEFORE the
    // final checkpoint so a delisting is reflected in this run's publishers.
    setJobPhase(job.id, 'enriching', 'liveness sweep');
    await sweepLiveness(onLog, job.id);
    throwIfCancelled(job.id);
    setJobProgress(job.id, 78);

    // ── FINAL LEAD CHECKPOINT — spend whatever budget is left ────────────────
    await queueHarvest('full catalog', 'classifying', 78, 17);
    throwIfCancelled(job.id);

    return await finishRun();

    /**
     * Land the run: report the funnel, build the per-HQ Excel bundle from the
     * CSV the last checkpoint already wrote, and mark the job completed.
     *
     * Every exit path goes through here — an early one because the lead target
     * was met, or the full sweep. The CSV and the lead rows are already on disk
     * and in job_results by this point (each checkpoint rewrites them), so this
     * adds no export work of its own.
     */
    async function finishRun(): Promise<void> {
      // Land the pump FIRST: no pass may rewrite the CSV between here and the
      // Excel build, or the .xlsx and the .csv would disagree.
      await stopPump();
      // Every path into finishRun has run at least one checkpoint, so the CSV is
      // already on disk. Rebuild defensively rather than trusting that invariant
      // to survive a future edit — it is local DB work and idempotent.
      if (csvPath == null) leadsOnTable = exportLeadsSoFar();
      const exportPath = csvPath as string;
      const discovered = listPublishersByScore(1_000_000);
      const confirmedCount = discovered.filter((p) => p.confirmed_advertiser === 1).length;
      if (EXPORT_CONFIRMED_ONLY) {
        const unchecked = discovered.filter((p) => p.last_confirm_at == null).length;
        onLog(
          'info',
          `export filter: ${confirmedCount}/${discovered.length} publishers confirmed advertising ` +
            `(${discovered.length - confirmedCount} held back — of those ${unchecked} not yet checked by the confirmation budget)`,
        );
      }
      if (params.maxLeads != null && leadsOnTable >= params.maxLeads) {
        onLog('info', `lead cap: exported the top ${leadsOnTable} publishers by score (cap ${params.maxLeads})`);
      }
      onLog(
        'info',
        `CSV written: ${exportPath} (${leadsOnTable} publisher leads; ` +
          `${confirmSpent}/${params.confirmationMaxApiCalls} confirmation calls spent)`,
      );

      // ── per-HQ-country .xlsx bundle ───────────────────────────────────────
      setJobProgress(job.id, 95);
      await buildExcelBundle(job.id, leadsOnTable, onLog);

      printRunSummary(onLog, { confirm: confirmTotals, enrichSummary, publishers: confirmedCount });

      // `ads` is this RUN's discovery volume, not the lifetime size of the
      // discovered_apps table — that table accumulates across every run, so
      // reporting its total made each job look like it had re-scraped everything.
      const appsThisRun = chartRows + newSimilar + searchRows + catalogApps;
      markJobCompleted(job.id, exportPath, { ads: appsThisRun, advertisers: leadsOnTable });
      onLog(
        'info',
        leadTargetMet
          ? `store-first job completed early — ${leadsOnTable}/${params.maxLeads} leads found without needing the remaining phases`
          : 'store-first job completed',
      );

      const done = getJob(job.id);
      if (done) {
        void notifyJobCompleted(done)
          .then(() => onLog('info', 'notification dispatched'))
          .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
      }
    }
  } catch (err) {
    // Land the pump before ANY finalize: a mid-flight confirm pass finishing
    // after finalize would rewrite the CSV/lead rows of a settled job.
    if (shutdownPump) await shutdownPump().catch(() => {});
    if (err instanceof JobCancelledError) {
      finalizeCancelledStoreJob(job, onLog);
      return;
    }
    const msg = (err as Error).message || 'unknown error';
    log.error(`store-first job ${job.id} failed`, err);
    onLog('error', `job failed: ${msg}`);
    markJobFailed(job.id, msg);
    const fresh = getJob(job.id);
    if (fresh) void notifyJobFailed(fresh).catch(() => {});
  }
}

/**
 * Stop-button finalize: everything discovered/enriched/confirmed up to the stop
 * is already persisted in the shared corpus, so a quick LOCAL rollup + scoring +
 * CSV (all DB work, no network, no paid calls) turns the partial run into a
 * partial deliverable instead of throwing it away. Best-effort throughout — a
 * failure here still marks the job cancelled, never failed.
 */
function finalizeCancelledStoreJob(job: JobRow, onLog: OnLog): void {
  let csvPath: string | null = null;
  let kept = 0;
  try {
    setJobPhase(job.id, 'building_csv', 'stopped — exporting what was found so far');
    rollupPublishers(onLog);
    scoreAllPublishers(onLog);
    const params = resolveStoreParams(job.source_params ? JSON.parse(job.source_params) : null);
    const out = rebuildJobLeadExport(job.id, params.maxLeads);
    csvPath = out.path;
    kept = out.rowsWritten;
    setJobLeadsFound(job.id, kept);
  } catch (e) {
    onLog('warn', `stop-finalize could not export partial leads (non-fatal): ${(e as Error).message}`);
  }
  markJobCancelled(job.id, `stopped by user — ${kept} lead(s) kept`, csvPath);
  onLog('warn', `store-first job stopped by user — ${kept} partial lead(s) exported`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Publishers eligible to become leads right now, score-descending. The export
 *  is confirmed-only by default: an unconfirmed publisher is a candidate, not a
 *  lead, and stays in the Publishers table until its verdict comes back. */
function leadEligiblePublishers() {
  const discovered = listPublishersByScore(1_000_000);
  return EXPORT_CONFIRMED_ONLY ? discovered.filter((p) => p.confirmed_advertiser === 1) : discovered;
}

/**
 * (Re)write a job's CSV from the corpus as it stands and persist the rows into
 * the shared lead store. Returns the file path and the row count.
 *
 * IDEMPOTENT, and that is the whole point: it clears the job's OWN previously
 * exported rows first. Those rows feed leadHistorySeed()'s cross-job dedupe, so
 * without the clear a job's earlier export marks its own leads as "already
 * delivered" and the rebuild silently drops every one of them. That is exactly
 * how a stopped run with 5 leads on the table reported "0 partial lead(s)
 * exported" — the checkpoint had persisted them, then the stop-finalize deduped
 * them against themselves.
 */
function rebuildJobLeadExport(jobId: string, maxLeads: number | null): { path: string; rowsWritten: number } {
  clearJobResults(jobId);
  const out = buildPublisherCsv(jobId, leadEligiblePublishers(), leadHistorySeed(), maxLeads);
  persistPublisherLeads(jobId, out.exported);
  return { path: out.path, rowsWritten: out.rowsWritten };
}

/** Build the enrichment worklist: distinct (store, app_id) for both stores, with
 *  is_chart carried through so enrichment can order + band-gate correctly. */
function buildWorklist(): EnrichWorkItem[] {
  const items: EnrichWorkItem[] = [];
  for (const store of ['google_play', 'app_store'] as StoreKind[]) {
    for (const a of distinctAppsForStore(store)) {
      items.push({ store, app_id: a.app_id, is_chart: a.is_chart === 1, country: a.country });
    }
  }
  return items;
}

/**
 * Per-developer "this catalog has already been fetched" marker (spec step 8).
 *
 * DEV_CATALOG_MAX_PER_RUN truncates a candidate list the DB layer orders by
 * VALUE (charted first, then in-band, then install size), and that order barely
 * moves between runs — so with no marker every run re-fetched the identical
 * prefix and a publisher ranked past the cut NEVER had its portfolio fetched, no
 * matter how many times the job ran. Its app_count, both_stores flag and the
 * TAIL_WEIGHTS.portfolio score component stayed permanently wrong, against step
 * 8's "for EVERY publisher with an email or website".
 *
 * The table lives here rather than in storeDiscoveryDb.ts because this phase is
 * its only reader and writer; it is created idempotently on first use, exactly
 * like the tables ensureStoreDiscoveryTables() owns.
 */
function ensureCatalogExpansionTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS developer_catalog_expansion (
      store TEXT NOT NULL,
      developer_id TEXT NOT NULL,
      last_expanded_at INTEGER NOT NULL,
      PRIMARY KEY (store, developer_id)
    );
  `);
}

/** developer id → ms epoch of its last catalog fetch, for one store. */
function catalogExpansionTimes(store: StoreKind): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT developer_id, last_expanded_at FROM developer_catalog_expansion WHERE store = ?`)
    .all(store) as Array<{ developer_id: string; last_expanded_at: number }>;
  return new Map(rows.map((r) => [r.developer_id, r.last_expanded_at]));
}

/**
 * Per-seed crawl marker for the similar graph — the same starvation guard the
 * developer-catalog phase already has.
 *
 * similarSeedApps re-selects EVERY depth-0 app on record, and discovered_apps
 * accumulates across runs, so that seed set only grows as chart membership churns.
 * With no marker and no ORDER BY, every run re-walked the same prefix: once the
 * depth-0 set alone reached SIMILAR_MAX_REQUESTS_PER_RUN the `break outer` fired
 * inside depth 0 and depth 1+ was never crawled again in ANY run — no new tail apps
 * from the crawl, while the job still logged success. Stamping each seed as crawled
 * makes successive runs advance through the level instead of restarting it.
 */
/**
 * Re-check the least-recently-verified known apps against their store and
 * tombstone the ones that are gone (spec-adjacent: keeps the permanent catalog
 * honest without re-scraping it).
 *
 * The invariant that matters: ONLY an unambiguous store "not found" tombstones an
 * app. playAppLiveness returns 'unknown' for a rate-limit or a network error and
 * appleLiveness omits a failed batch entirely, and neither is treated as gone —
 * otherwise one throttled afternoon would wipe live apps out of every publisher's
 * portfolio, and nothing in the pipeline would ever put them back.
 */
/**
 * The per-HQ-country .xlsx bundle every other source produces (spec: one run, one
 * Excel). persistPublisherLeads has already written job_results rows classified
 * mobile_google_play/mobile_app_store with a store_url — exactly the shape
 * runHqSplit consumes — so this is one call, not a parallel export path.
 *
 * Two rules, both about not destroying finished work:
 *
 * BUDGET — HQ resolution is the ONLY LLM spend in this pipeline, and the queue
 * dispatches store_first CAP-EXEMPT (on the rationale that store discovery and
 * GATC confirmation are plain HTTP). The cap therefore has to be honoured here,
 * or an exempt job would quietly spend past it. Checked up front so a capped day
 * skips the split cleanly rather than dying part-way through it.
 *
 * NON-FATAL — unlike the appgoblin/affplus pipelines, a failure here is never
 * re-thrown. There the CSV and the split share one outcome; here discovery,
 * enrichment, rollup, confirmation and the CSV have all already succeeded and are
 * on disk. Failing the job over an optional trailing bundle would report hours of
 * completed work as a failure and hide a good CSV behind a 'failed' status.
 */
async function buildExcelBundle(jobId: string, rowsWritten: number, onLog: OnLog): Promise<void> {
  const spent = spentTodayUsd();
  if (spent >= DAILY_CAP_USD) {
    onLog(
      'warn',
      `hq-split skipped: daily LLM cap reached ($${spent.toFixed(2)} of $${DAILY_CAP_USD.toFixed(2)}) — ` +
        `the CSV is complete; the Excel bundle will be produced by the next run after the cap resets`,
    );
    return;
  }
  setJobPhase(jobId, 'hq_splitting', `resolving HQ for ${rowsWritten} publishers`);
  try {
    const outcome = await runHqSplit({ jobId, results: getResults(jobId), onLog });
    if (outcome.zipPath) {
      setJobHqZipPath(jobId, outcome.zipPath);
      const summary = Object.entries(outcome.perCountryCounts)
        .sort(([, a], [, b]) => b - a)
        .map(([c, n]) => `${c}=${n}`)
        .join(', ');
      onLog('info', `hq-split: Excel bundle ready (${summary})`);
    } else {
      onLog('warn', 'hq-split: no Excel bundle produced (no resolvable mobile rows)');
    }
    if (outcome.playBlocked) {
      onLog('warn', 'hq-split: Play page-fetch was blocked/rate-limited — Android HQ resolution may be degraded');
    }
  } catch (err) {
    const why = err instanceof BudgetExceededError ? 'daily LLM cap reached mid-split' : (err as Error).message;
    onLog('warn', `hq-split failed (non-fatal, CSV unaffected): ${why}`);
  }
}

export function livenessAction(verdict: 'live' | 'gone' | 'unknown'): 'skip' | 'mark_live' | 'mark_gone' {
  // The whole safety property of the sweep, in one place: only a definitive
  // store answer is actionable. 'unknown' (rate-limit, timeout, 5xx) means ask
  // again next run — never a tombstone.
  if (verdict === 'unknown') return 'skip';
  return verdict === 'gone' ? 'mark_gone' : 'mark_live';
}

async function sweepLiveness(onLog: OnLog, jobId?: string): Promise<{ checked: number; delisted: number }> {
  const staleBefore = Date.now() - LIVENESS_RECHECK_AFTER_DAYS * 86_400_000;
  let checked = 0;
  let delisted = 0;

  // Play: one throttled request per app, so the budget is small.
  const playSweep = async () => {
    const playCandidates = listLivenessCandidates('google_play', staleBefore, LIVENESS_MAX_PLAY_PER_RUN);
    for (const c of playCandidates) {
      if (jobId && isCancelRequested(jobId)) break; // Stop button — sweep resumes next run
      const action = livenessAction(await playAppLiveness(c.app_id, c.country, onLog));
      if (action === 'skip') continue; // inconclusive: ask again next run
      markAppLiveness('google_play', c.app_id, action === 'mark_gone');
      checked++;
      if (action === 'mark_gone') delisted++;
    }
  };

  // Apple: 100 ids per request, so a much larger slice fits the same wall-clock.
  // Grouped by storefront because a listing is per-country: an app pulled from one
  // market may still be live in another, and asking in the wrong one is a false
  // delisting. Same country preference the enrichment worklist uses.
  const appleSweep = async () => {
    const appleCandidates = listLivenessCandidates('app_store', staleBefore, LIVENESS_MAX_APPLE_PER_RUN);
    const byCountry = new Map<string, string[]>();
    for (const c of appleCandidates) {
      const cc = (c.country || 'us').toLowerCase();
      if (!byCountry.has(cc)) byCountry.set(cc, []);
      byCountry.get(cc)!.push(c.app_id);
    }
    for (const [cc, ids] of byCountry) {
      if (jobId && isCancelRequested(jobId)) break; // Stop button — sweep resumes next run
      const verdicts = await appleLiveness(ids, cc, onLog);
      for (const [appId, verdict] of verdicts) {
        const action = livenessAction(verdict);
        if (action === 'skip') continue;
        markAppLiveness('app_store', appId, action === 'mark_gone');
        checked++;
        if (action === 'mark_gone') delisted++;
      }
    }
  };

  // The two stores throttle independently — sweep them concurrently.
  await Promise.all([playSweep(), appleSweep()]);

  if (checked > 0) {
    onLog(
      'info',
      `liveness: re-checked ${checked} known apps, ${delisted} newly delisted and dropped from rollup ` +
        `(${countDelistedApps()} delisted in total)`,
    );
  } else {
    onLog('info', 'liveness: nothing due for re-check this run');
  }
  return { checked, delisted };
}

/** One search-battery cell: a (vertical, market, term) triple. */
export interface SearchCell {
  vertical: string;
  market: string;
  term: string;
}

/** Rotation key for a search cell. Stable across runs — it IS the primary key. */
export function searchCellKey(cell: SearchCell): string {
  return `${cell.vertical}|${cell.market}|${cell.term}`;
}

/**
 * Per-(store, cell) "this search has already run" marker.
 *
 * The same starvation guard similar_crawl_seed and developer_catalog_expansion
 * carry, and for the same reason: SEARCH_MAX_REQUESTS_PER_RUN truncates a list
 * that is otherwise built vertical-then-market-then-term, so with no marker every
 * run would re-search the identical prefix (finance/us/...) and the cells past the
 * cut — at full scope that is most of the grid — would never be searched at all.
 *
 * Stamps are PER STORE since the Play and Apple halves of the battery run as
 * independent concurrent streams (each behind its own rate limiter) with their
 * own budgets — one shared stamp would let the faster stream mark cells the
 * slower one never actually searched. The legacy combined table seeds the
 * per-store table once, so rotation history from before the split carries over.
 */
function ensureSearchBatteryTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_battery_cell (
      vertical TEXT NOT NULL,
      market TEXT NOT NULL,
      term TEXT NOT NULL,
      last_searched_at INTEGER NOT NULL,
      PRIMARY KEY (vertical, market, term)
    );
    CREATE TABLE IF NOT EXISTS search_battery_cell_store (
      store TEXT NOT NULL,
      vertical TEXT NOT NULL,
      market TEXT NOT NULL,
      term TEXT NOT NULL,
      last_searched_at INTEGER NOT NULL,
      PRIMARY KEY (store, vertical, market, term)
    );
  `);
  // One-time inheritance: a cell the combined loop already searched was searched
  // in BOTH stores, so both per-store rows inherit its stamp. INSERT OR IGNORE
  // keeps newer per-store stamps untouched on later runs.
  for (const store of ['google_play', 'app_store']) {
    db.prepare(
      `INSERT OR IGNORE INTO search_battery_cell_store (store, vertical, market, term, last_searched_at)
        SELECT ?, vertical, market, term, last_searched_at FROM search_battery_cell`,
    ).run(store);
  }
}

/** cell key → ms epoch of this STORE's last search of it. */
function searchCellTimesForStore(store: StoreKind): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT vertical, market, term, last_searched_at FROM search_battery_cell_store WHERE store = ?`)
    .all(store) as Array<SearchCell & { last_searched_at: number }>;
  return new Map(rows.map((r) => [searchCellKey(r), r.last_searched_at]));
}

function markSearchCellForStore(store: StoreKind, cell: SearchCell): void {
  getDb()
    .prepare(
      `INSERT INTO search_battery_cell_store (store, vertical, market, term, last_searched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(store, vertical, market, term) DO UPDATE SET last_searched_at = excluded.last_searched_at`,
    )
    .run(store, cell.vertical, cell.market, cell.term, Date.now());
}

function ensureSimilarCrawlTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS similar_crawl_seed (
      store TEXT NOT NULL,
      app_id TEXT NOT NULL,
      last_crawled_at INTEGER NOT NULL,
      PRIMARY KEY (store, app_id)
    );
  `);
}

/** seed app id → ms epoch of the last similar-crawl request made FROM it. */
function similarCrawlTimes(store: StoreKind): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT app_id, last_crawled_at FROM similar_crawl_seed WHERE store = ?`)
    .all(store) as Array<{ app_id: string; last_crawled_at: number }>;
  return new Map(rows.map((r) => [r.app_id, r.last_crawled_at]));
}

function markSimilarCrawled(store: StoreKind, appId: string): void {
  getDb()
    .prepare(
      `INSERT INTO similar_crawl_seed (store, app_id, last_crawled_at) VALUES (?, ?, ?)
       ON CONFLICT(store, app_id) DO UPDATE SET last_crawled_at = excluded.last_crawled_at`,
    )
    .run(store, appId, Date.now());
}

function markCatalogExpanded(store: StoreKind, developerId: string): void {
  getDb()
    .prepare(
      `INSERT INTO developer_catalog_expansion (store, developer_id, last_expanded_at) VALUES (?, ?, ?)
       ON CONFLICT(store, developer_id) DO UPDATE SET last_expanded_at = excluded.last_expanded_at`,
    )
    .run(store, developerId, Date.now());
}

/**
 * ONE-SHOT purge of crawl/expansion stamps written while the fetches behind
 * them were hard-coded to the us storefront. A geo-restricted developer or
 * seed — one whose sightings never include us — was fetched against a market
 * it does not resolve in, yielded [], and was stamped anyway. That stamp is a
 * lie, and under the never-visited-first ordering the correct per-market
 * re-fetch would only come round after the entire never-visited backlog
 * drains. Deleting the stamp makes the row "never visited" again: it
 * re-fetches promptly, now against its own storefront, at its value-order
 * position. us-sighted rows keep their stamps — their fetches ran against the
 * right storefront all along.
 *
 * Marker-guarded like backfillDiscoveryDepth (and for the same reason a plain
 * predicate cannot be): post-fix stamps on non-us rows mean "fetched in the
 * RIGHT market" and must never be purged. The settings table is created by
 * initDb, which always precedes a pipeline run. Exported for tests.
 */
const GEO_STAMP_PURGE_MARKER = 'store_discovery.geo_stamp_purge_v1';

export function purgeUsEraGeoStamps(onLog: OnLog): void {
  const db = getDb();
  if (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(GEO_STAMP_PURGE_MARKER)) return;
  // Both stamp tables must exist before the DELETEs reference them: on a fresh
  // database (nothing to purge) they may not have been created yet.
  ensureSimilarCrawlTable();
  ensureCatalogExpansionTable();
  const nonUs = (col: string) => `${sightedCountrySql(col)} <> 'us'`;
  const seeds = db
    .prepare(
      `DELETE FROM similar_crawl_seed
        WHERE store = 'google_play'
          AND app_id IN (SELECT app_id FROM discovered_apps
                          WHERE store = 'google_play'
                          GROUP BY app_id HAVING ${nonUs('country')})`,
    )
    .run();
  // The developer subqueries deliberately skip the contact filter the
  // expansion sets apply: a stamp for a developer outside those sets is never
  // consulted, so over-deleting is harmless while under-deleting leaves the
  // us-era latency in place.
  const purgeCatalog = (store: string, idCol: string) =>
    db
      .prepare(
        `DELETE FROM developer_catalog_expansion
          WHERE store = '${store}'
            AND developer_id IN (
              SELECT d.${idCol}
                FROM store_app_detail d
                LEFT JOIN discovered_apps a
                  ON a.store = d.store AND a.app_id = d.app_id
               WHERE d.store = '${store}' AND d.${idCol} IS NOT NULL
               GROUP BY d.${idCol}
              HAVING ${nonUs('a.country')})`,
      )
      .run();
  const play = purgeCatalog('google_play', 'developer_id');
  const apple = purgeCatalog('app_store', 'artist_id');
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(GEO_STAMP_PURGE_MARKER, Date.now());
  const n = seeds.changes + play.changes + apple.changes;
  if (n > 0) {
    onLog(
      'info',
      `purged ${n} us-era stamps on geo-restricted rows ` +
        `(${seeds.changes} similar seeds, ${play.changes} Play catalogs, ${apple.changes} Apple catalogs) — they re-fetch in their own storefront`,
    );
  }
}

/**
 * Order a phase's candidates so the run's budget makes MONOTONIC progress:
 * never-visited records first — in the caller's value order, since the sort is
 * stable — then the already-visited, least-recently first. Successive runs
 * therefore walk the whole eligible set instead of re-walking its head, while
 * re-visits stay reachable once the backlog drains (portfolios and similar
 * graphs do change) and can never overtake a record never visited at all.
 * Both the developer-catalog phase and the similar crawl budget through this,
 * and they must not drift apart: any phase that walks a growing candidate set
 * under a per-run budget re-walks the same prefix forever without it.
 *
 * Pure, so that guarantee is unit-testable without a database.
 */
export function orderByProgress<T>(
  items: readonly T[],
  key: (item: T) => string,
  visitedAt: ReadonlyMap<string, number>,
): T[] {
  return [...items].sort((a, b) => (visitedAt.get(key(a)) ?? 0) - (visitedAt.get(key(b)) ?? 0));
}

/** Step 8: fetch the full Play + Apple portfolios for enriched developers that
 *  publish a contact, storing them as developer_catalog. Bounded by
 *  DEV_CATALOG_MAX_PER_RUN combined, spent on the developers whose catalogs are
 *  still un-expanded. Returns the count of NEW apps discovered. */
async function expandDeveloperCatalogs(onLog: OnLog, jobId?: string): Promise<number> {
  const total = DEV_CATALOG_MAX_PER_RUN;
  if (total <= 0) return 0;
  ensureCatalogExpansionTable();
  let newApps = 0;

  /** Fetch up to `budget` catalogs for one store. Returns catalogs actually fetched. */
  const runStore = async (
    devs: Array<{ id: string; country: string }>,
    budget: number,
    fetch: (id: string, country: string) => Promise<Array<{ appId: string; title: string | null }>>,
    store: 'google_play' | 'app_store',
  ): Promise<number> => {
    let used = 0;
    for (const dev of orderByProgress(devs, (d) => d.id, catalogExpansionTimes(store))) {
      if (jobId && isCancelRequested(jobId)) break; // Stop button — everything fetched so far is stamped
      if (used >= budget) break;
      if (newApps >= DEV_CATALOG_MAX_APPS_PER_RUN) break;
      used++;
      // Fetched against the developer's own storefront (us-preferred, from the
      // markets its apps were sighted in): catalogs are storefront-listings, so
      // a geo-restricted developer queried in us yields an EMPTY catalog that
      // the stamp below would record as expanded — the portfolio (app_count,
      // both_stores, portfolio score) then stays understated forever, for
      // exactly the publishers the per-market enrichment newly unlocks.
      const apps = await fetch(dev.id, dev.country);
      // Stamped whether or not the catalog yielded anything: the budget slot was
      // spent either way, and a blocked fetch goes to the BACK of the queue to be
      // retried on a later run rather than re-consuming the budget ahead of the
      // developers behind it (store calls degrade to [] instead of throwing).
      markCatalogExpanded(store, dev.id);
      for (const a of apps) {
        const { inserted } = upsertDiscoveredApp({
          // Sighted in the storefront the catalog was fetched from, NOT
          // CRAWL_COUNTRY: recording us for a de-fetched catalog would point
          // the app's own detail fetch at a storefront it may not exist in.
          store, app_id: a.appId, title: a.title, country: dev.country,
          // The catalog was fetched FOR this developer, so identity is known
          // without trusting the row's own (often absent) developer field.
          list_developer: store === 'google_play' ? (a as { developer?: string }).developer ?? null : null,
          list_developer_id: store === 'google_play' ? dev.id : null,
          // NO explicit depth: a developer_catalog app is not in the similar
          // graph, so it must take NON_GRAPH_DEPTH. Passing 1 here made every
          // catalog app a depth-1 crawl seed — exactly what the sentinel exists
          // to prevent.
          source: 'developer_catalog',
        });
        if (inserted) newApps++;
      }
    }
    return used;
  };

  // Split the budget per store — HALF EACH, RUN CONCURRENTLY. Play was listed
  // first against one shared counter, so with more Play developers than budget
  // the Apple loop never executed a single request; and serial execution paid
  // Play-time + Apple-time even though the two stores throttle independently.
  const playDevs = playDevelopersWithContact();
  const appleDevs = appleArtistsWithContact();
  const playShare = Math.ceil(total / 2);
  let [playUsed, appleUsed] = await Promise.all([
    runStore(playDevs, playShare, (id, cc) => playDeveloper(id, cc, onLog), 'google_play'),
    runStore(appleDevs, total - playShare, (id, cc) => appleDeveloper(id, cc, onLog), 'app_store'),
  ]);
  // Leftover budget flows to the other store, but ONLY toward developers never
  // expanded — re-reading the fresh stamps guards against burning leftover on
  // re-expansion while un-expanded developers exist elsewhere in neither list.
  let leftover = total - playUsed - appleUsed;
  if (leftover > 0 && newApps < DEV_CATALOG_MAX_APPS_PER_RUN && !(jobId && isCancelRequested(jobId))) {
    const unexpanded = (devs: Array<{ id: string }>, store: StoreKind) => {
      const t = catalogExpansionTimes(store);
      return devs.filter((d) => !t.has(d.id)).length;
    };
    const appleExtra = Math.min(leftover, unexpanded(appleDevs, 'app_store'));
    if (appleExtra > 0) {
      appleUsed += await runStore(appleDevs, appleExtra, (id, cc) => appleDeveloper(id, cc, onLog), 'app_store');
      leftover = total - playUsed - appleUsed;
    }
    const playExtra = Math.min(leftover, unexpanded(playDevs, 'google_play'));
    if (playExtra > 0) {
      playUsed += await runStore(playDevs, playExtra, (id, cc) => playDeveloper(id, cc, onLog), 'google_play');
    }
  }

  onLog('info', `dev-catalog: ${playUsed} Play + ${appleUsed} Apple catalogs → +${newApps} new apps`);
  if (playUsed + appleUsed >= total) {
    onLog('warn', `dev-catalog: hit DEV_CATALOG_MAX_PER_RUN (${total}) — the un-expanded remainder resumes next run`);
  }
  if (newApps >= DEV_CATALOG_MAX_APPS_PER_RUN) {
    onLog('warn', `dev-catalog: hit DEV_CATALOG_MAX_APPS_PER_RUN (${DEV_CATALOG_MAX_APPS_PER_RUN}) — stopped early`);
  }
  return newApps;
}

function logEnrich(onLog: OnLog, label: string, s: EnrichSummary): void {
  onLog(
    'info',
    `${label}: ${s.apps} apps (${s.enriched} fetched, ${s.cached} cached, ${s.failed} failed) — ` +
      `${s.games} games / ${s.nonGames} non-games / ${s.unclassified} unknown; ` +
      `band: ${s.inBand} in / ${s.outOfBand} out; requests=${s.requests}${s.cappedOut ? `; capped=${s.cappedOut}` : ''}`,
  );
}

function printRunSummary(
  onLog: OnLog,
  ctx: { confirm: Awaited<ReturnType<typeof confirmPublishers>>; enrichSummary: EnrichSummary; publishers: number },
): void {
  const bySource = discoveredCountsBySource();
  const totalApps = countDiscoveredApps();
  const nonChart = totalApps - (bySource.chart ?? 0);
  const publishers = countPublishers();
  const confirmed = countConfirmedPublishers();
  const withEmail = countPublishersWithEmail();
  // Store calls are free; the only paid surface is GATC confirmation via the
  // residential proxy. A rough per-call proxy-traffic estimate keeps the operator
  // oriented without pretending to bill exact bytes.
  const estUsd = (ctx.confirm.apiCalls * 0.002).toFixed(3); // ~2/10¢ per RPC round-trip, order-of-magnitude
  const top = listPublishersByScore(10);

  onLog('info', '──────── RUN SUMMARY ────────');
  onLog('info', `apps by source: ${Object.entries(bySource).map(([k, n]) => `${k}=${n}`).join(', ') || '(none)'}`);
  onLog('info', `apps: ${totalApps} total, ${nonChart} non-chart; enriched this run: ${ctx.enrichSummary.enriched}`);
  onLog('info', `publishers: ${publishers} (${withEmail} with email); confirmed: ${confirmed}`);
  onLog(
    'info',
    `confirmation: ${ctx.confirm.processed}/${ctx.confirm.queued} processed, ${ctx.confirm.apiCalls} API calls` +
      `${ctx.confirm.skipped ? ' (skipped)' : ''}; est cost ~$${estUsd} (store discovery is free)`,
  );
  onLog('info', `top publishers by score:`);
  top.forEach((p, i) => {
    onLog(
      'info',
      `  ${i + 1}. ${p.name} — score ${p.score}${p.confirmed_advertiser ? ' ✓confirmed' : ''}` +
        `${p.is_charted ? ` rank ${p.best_rank}` : ' (tail)'}${p.both_stores ? ' both-stores' : ''}` +
        `${p.gatc_ads_count ? ` gatc:${p.gatc_ads_count}` : ''}`,
    );
  });
  onLog('info', '─────────────────────────────');
}

// ── offline unit tests ───────────────────────────────────────────────────────

export function runStoreDiscoveryPipelineTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // Step-8 budget ordering. The DB layer hands the candidates over in value
  // order as {id, country} records, so an untouched list must come back
  // untouched — and each developer's storefront must ride along with it, since
  // runStore reads the country straight off the ordered record.
  const dev = (id: string, country = 'us') => ({ id, country });
  const devOrder = (devs: Array<{ id: string; country: string }>, times: ReadonlyMap<string, number>) =>
    orderByProgress(devs, (d) => d.id, times).map((d) => d.id).join(',');
  check(
    devOrder([dev('a'), dev('b'), dev('c')], new Map()) === 'a,b,c',
    'catalog order: never-expanded candidates keep the value order they arrived in',
  );
  check(
    devOrder([dev('a'), dev('b'), dev('c')], new Map([['a', 500]])) === 'b,c,a',
    'catalog order: an already-expanded developer yields the budget to never-expanded ones',
  );
  check(
    devOrder([dev('a'), dev('b')], new Map([['a', 900], ['b', 100]])) === 'b,a',
    'catalog order: with nothing left un-expanded, the least-recently-expanded goes first',
  );
  check(
    orderByProgress([dev('x', 'de'), dev('y', 'us')], (d) => d.id, new Map([['x', 9]]))
      .map((d) => `${d.id}:${d.country}`)
      .join(',') === 'y:us,x:de',
    'catalog order: each developer keeps its own storefront through the ordering',
  );

  // The regression itself: consecutive runs must ADVANCE through the eligible
  // set. Before the marker existed every run re-fetched the same prefix, so
  // 'c'..'e' below were never expanded no matter how often the job ran.
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) => dev(id));
  const expandedAt = new Map<string, number>();
  const simulateRun = (clock: number): string[] => {
    const picked = orderByProgress(candidates, (d) => d.id, expandedAt)
      .slice(0, 2) // budget of 2
      .map((d) => d.id);
    picked.forEach((id, i) => expandedAt.set(id, clock + i));
    return picked;
  };
  const run1 = simulateRun(1_000);
  const run2 = simulateRun(2_000);
  const run3 = simulateRun(3_000);
  check(run1.join(',') === 'a,b', 'catalog budget: run 1 spends on the two highest-value candidates');
  check(run2.join(',') === 'c,d', 'catalog budget: run 2 skips what run 1 already expanded');
  check(run3[0] === 'e', 'catalog budget: run 3 finishes the backlog before re-expanding anything');
  check(run3[1] === 'a', 'catalog budget: only a drained backlog lets the oldest expansion come round again');
  check(
    new Set([...run1, ...run2, ...run3]).size === candidates.length,
    'catalog budget: three budget-2 runs cover every eligible developer',
  );

  // The same starvation, on the similar crawl. The depth-0 seed set outgrows the
  // per-run REQUEST budget (discovered_apps accumulates across runs), so before the
  // marker existed every run re-walked seeds s1..s3 and depth 1 was never reached in
  // ANY run — the crawl silently stopped discovering tail apps while logging success.
  const seedIds = ['s1', 's2', 's3', 's4', 's5'];
  const crawled = new Map<string, number>();
  const REQUEST_BUDGET = 3;
  const crawlRun = (clock: number): string[] => {
    const ordered = orderByProgress(seedIds, (s) => s, crawled).slice(0, REQUEST_BUDGET);
    ordered.forEach((s, i) => crawled.set(s, clock + i));
    return ordered;
  };
  const crawl1 = crawlRun(1_000);
  check(crawl1.join(',') === 's1,s2,s3', 'similar seeds: run 1 spends its request budget on the first three seeds');
  const crawl2 = crawlRun(2_000);
  check(
    crawl2.includes('s4') && crawl2.includes('s5'),
    'similar seeds: run 2 advances to the seeds run 1 never reached (was: re-walked s1..s3 forever)',
  );
  check(
    crawled.size === seedIds.length,
    'similar seeds: two budget-3 runs exhaust a 5-seed level, so the next run can descend a depth',
  );
  // Run 2 had budget left over after s4/s5, so it also re-crawled s1 — which makes s2
  // the least-recently-crawled seed. Re-crawling is only ever reachable once nothing
  // un-crawled remains, and it always takes the oldest first.
  const crawl3 = crawlRun(3_000);
  check(crawl3[0] === 's2', 'similar seeds: a fully-crawled level comes round again oldest-first');
  // Generic ordering contract shared with the catalog phase.
  check(
    orderByProgress([{ id: 'b' }, { id: 'a' }], (x) => x.id, new Map([['b', 5]]))
      .map((x) => x.id)
      .join(',') === 'a,b',
    'orderByProgress: a never-visited record outranks a visited one regardless of input order',
  );

  // ── Search battery: the cap must defer cells, never starve them ────────────
  // At the full default scope the grid is 9 verticals x 12 markets x 15 terms =
  // 1620 cells against a 600-request (300-cell) budget, so MOST of the grid is
  // deferred on any one run. That is only correct if the deferred cells are the
  // ones that run next time.
  const cell = (vertical: string, market: string, term: string): SearchCell => ({ vertical, market, term });
  check(
    searchCellKey(cell('finance', 'us', 'loan app')) === 'finance|us|loan app',
    'search key: (vertical, market, term) triple is the rotation key',
  );
  check(
    searchCellKey(cell('finance', 'us', 'a')) !== searchCellKey(cell('finance', 'gb', 'a')),
    'search key: same term in two markets is two distinct cells',
  );
  check(
    searchCellKey(cell('games', 'us', 'a')) !== searchCellKey(cell('finance', 'us', 'a')),
    'search key: same term under two verticals is two distinct cells',
  );

  // Build a miniature grid and sweep it with a budget far below its size.
  const grid: SearchCell[] = [];
  for (const v of ['finance', 'games']) {
    for (const m of ['us', 'gb', 'de']) {
      for (const t of ['t1', 't2']) grid.push(cell(v, m, t));
    }
  }
  const searchedTimes = new Map<string, number>();
  const sweep = (clock: number, budgetCells: number): string[] => {
    const picked = orderByProgress(grid, searchCellKey, searchedTimes)
      .slice(0, budgetCells)
      .map(searchCellKey);
    picked.forEach((k, i) => searchedTimes.set(k, clock + i));
    return picked;
  };
  const s1 = sweep(1_000, 4);
  const s2 = sweep(2_000, 4);
  const s3 = sweep(3_000, 4);
  check(grid.length === 12, 'search grid: 2 verticals x 3 markets x 2 terms = 12 cells');
  check(new Set([...s1, ...s2, ...s3]).size === 12, 'search rotation: three capped runs cover the whole grid exactly once');
  check(s1.every((k) => !s2.includes(k)), 'search rotation: run 2 repeats nothing from run 1');
  check(s2.every((k) => !s3.includes(k)), 'search rotation: run 3 repeats nothing from run 2');
  // A fourth run wraps around to the oldest cells rather than stalling.
  const s4 = sweep(4_000, 4);
  check(s4.join(',') === s1.join(','), 'search rotation: a swept grid comes round again oldest-first');
  // Every market and every vertical is reached — the starvation this guards.
  const reached = new Set([...s1, ...s2, ...s3].map((k) => k.split('|').slice(0, 2).join('|')));
  check(reached.size === 6, 'search rotation: every (vertical, market) pair is reached, none starved');

  // ── Liveness sweep: an inconclusive answer must never tombstone an app ─────
  check(livenessAction('gone') === 'mark_gone', 'liveness: a definitive not-found tombstones the app');
  check(livenessAction('live') === 'mark_live', 'liveness: a definitive hit refreshes the checked-at stamp');
  check(livenessAction('unknown') === 'skip', 'liveness: an inconclusive answer is never a tombstone');
  check(
    (['live', 'gone', 'unknown'] as const).filter((v) => livenessAction(v) === 'mark_gone').length === 1,
    'liveness: exactly one verdict can delist — a rate-limit cannot wipe live apps',
  );

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeDiscoveryPipeline.js') || process.argv[1].endsWith('storeDiscoveryPipeline.ts'));
if (isMain) {
  const { passed, failed, failures } = runStoreDiscoveryPipelineTests();
  console.log(`storeDiscoveryPipeline tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
