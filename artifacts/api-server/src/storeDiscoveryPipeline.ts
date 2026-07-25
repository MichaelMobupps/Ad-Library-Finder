/**
 * Store-first discovery pipeline (spec IMPLEMENTATION steps 3–13, orchestration).
 *
 * The `store_first` job source. DISCOVERY is app-store data; GATC/Meta only
 * CONFIRM. Phases, in order:
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
 *   6. Rollup               — publishers + portfolio aggregates.
 *   7. Confirmation         — GATC (RPC) + optional Meta, budgeted.
 *   8. Scoring              — charted vs tail-only profiles.
 *   9. Leads + CSV          — one lead per publisher, Prospector export.
 *
 * Store calls are free and internally throttled; the only paid surface is GATC
 * confirmation (residential proxy). Everything degrades gracefully — a blocked
 * store/RPC call is skipped, never thrown, so a run always produces its CSV.
 */

import {
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  setJobPhase,
  appendLog,
  getJob,
  getDb,
  type JobRow,
} from './db.js';
import {
  resolveStoreParams,
  verticalById,
  tailSearchTerms,
  SIMILAR_MAX_DEPTH,
  SIMILAR_MAX_REQUESTS_PER_RUN,
  DEV_CATALOG_MAX_PER_RUN,
  DEV_CATALOG_MAX_APPS_PER_RUN,
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
  type StoreKind,
} from './storeDiscoveryDb.js';
import { expandPlayCategories, playChart, playSimilar, playDeveloper, playSearch } from './playSource.js';
import { appleChart, appleDeveloper, appleSearch } from './appleSource.js';
import { enrichApps, type EnrichWorkItem, type EnrichSummary } from './storeEnrich.js';
import { rollupPublishers } from './publisherRollup.js';
import { confirmPublishers } from './storeConfirm.js';
import { scoreAllPublishers } from './publisherScore.js';
import { buildPublisherCsv, leadHistorySeed, persistPublisherLeads } from './storeLeads.js';
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

  try {
    const params = resolveStoreParams(job.source_params ? JSON.parse(job.source_params) : null);
    onLog(
      'info',
      `active: verticals=[${params.verticals.join(',')}] markets=[${params.markets.join(',')}] ` +
        `charts=play:${params.playCharts.join('+')}/apple:${params.appleCharts.join('+')} ` +
        `similarCap=${params.similarMaxAppsPerRun} searchTerms/vert=${params.searchTermsLimit ?? 'all'} confirmBudget=${params.confirmationMaxApiCalls}`,
    );

    purgeUsEraGeoStamps(onLog);

    // ── Phase 1: chart harvest ───────────────────────────────────────────────
    setJobPhase(job.id, 'scraping', 'charts');
    let chartRows = 0;
    const cellTotal = params.verticals.length * params.markets.length;
    let cell = 0;
    for (const vId of params.verticals) {
      const v = verticalById(vId);
      if (!v) continue;
      const playCats = expandPlayCategories(v.play, !!v.expandGames);
      for (const market of params.markets) {
        cell++;
        setJobPhase(job.id, 'scraping', `charts ${vId}/${market} (${cell}/${cellTotal})`);
        // Play charts (each category × collection)
        for (const chart of params.playCharts) {
          for (const cat of playCats) {
            const apps = await playChart(cat, chart, market, onLog);
            apps.forEach((a, i) => {
              upsertDiscoveredApp({
                store: 'google_play', app_id: a.appId, title: a.title, vertical: vId, country: market,
                source: 'chart', discovery_depth: 0, chart, rank: i + 1,
              });
            });
            chartRows += apps.length;
          }
        }
        // Apple top-free chart
        for (const _c of params.appleCharts) {
          const apps = await appleChart(v.appleGenre, market, onLog);
          apps.forEach((a, i) => {
            upsertDiscoveredApp({
              store: 'app_store', app_id: a.appId, title: a.title, vertical: vId, country: market,
              source: 'chart', discovery_depth: 0, chart: 'top-free', rank: i + 1,
            });
          });
          chartRows += apps.length;
        }
      }
    }
    onLog('info', `charts done: ${chartRows} chart sightings; ${countDiscoveredApps()} distinct (store,app,country) rows`);

    // ── Phase 2: similar crawl (Play), level-by-level to SIMILAR_MAX_DEPTH ────
    setJobPhase(job.id, 'scraping', 'similar crawl');
    let newSimilar = 0;
    let similarRequests = 0;
    ensureSimilarCrawlTable();
    const crawledAt = similarCrawlTimes('google_play');
    outer: for (let depth = 0; depth < SIMILAR_MAX_DEPTH; depth++) {
      if (newSimilar >= params.similarMaxAppsPerRun) break;
      // Seeds are Play apps of the ACTIVE verticals whose shallowest graph sighting
      // is exactly this depth. At depth 0 that is exactly the chart apps, and a
      // depth-SIMILAR_MAX_DEPTH app is never a seed (verification #4).
      // Never-crawled seeds first, then least-recently-crawled: the seed set grows
      // across runs, so without this the request budget is spent re-walking the same
      // prefix and the deeper levels starve permanently.
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
        if (newSimilar >= params.similarMaxAppsPerRun) break outer;
        // Independent REQUEST bound. Without it a saturated graph inserts nothing,
        // never reaches the app cap, and re-walks every seed at 1 req/s for hours.
        if (similarRequests >= SIMILAR_MAX_REQUESTS_PER_RUN) {
          onLog('warn', `similar crawl hit request cap ${SIMILAR_MAX_REQUESTS_PER_RUN} — stopping crawl`);
          break outer;
        }
        similarRequests++;
        // Stamped whether or not this seed yields anything: the request was spent, and
        // a barren or blocked seed must go to the BACK of the queue rather than
        // re-consuming the budget ahead of seeds never tried.
        markSimilarCrawled('google_play', seed.app_id);
        // Queried in the seed's own storefront (us-preferred, from the markets
        // it was sighted in): a geo-restricted seed resolves ONLY there, and a
        // us query would return nothing — stamped above as crawled, the seed
        // would then contribute zero graph edges forever.
        const sims = await playSimilar(seed.app_id, seed.country, onLog);
        for (const a of sims) {
          const { inserted } = upsertDiscoveredApp({
            // Sighted in the storefront the similar query ran against — see the
            // same choice on developer-catalog upserts below.
            store: 'google_play', app_id: a.appId, title: a.title, country: seed.country,
            // Inherit the seed's vertical so the next depth level can find these
            // apps as seeds and so rollup keeps vertical attribution.
            vertical: seed.vertical,
            source: 'similar', discovery_depth: depth + 1,
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
    onLog('info', `similar crawl done: +${newSimilar} new apps from ${similarRequests} requests`);

    // ── Phase 3: search battery ──────────────────────────────────────────────
    setJobPhase(job.id, 'scraping', 'search battery');
    let searchRows = 0;
    for (const vId of params.verticals) {
      let terms = tailSearchTerms(vId);
      if (params.searchTermsLimit != null) terms = terms.slice(0, params.searchTermsLimit);
      for (const market of params.markets) {
        for (const term of terms) {
          const [playApps, appleApps] = await Promise.all([
            playSearch(term, market, onLog),
            appleSearch(term, market, onLog),
          ]);
          for (const a of playApps) {
            upsertDiscoveredApp({ store: 'google_play', app_id: a.appId, title: a.title, vertical: vId, country: market, source: 'search' });
          }
          for (const a of appleApps) {
            upsertDiscoveredApp({ store: 'app_store', app_id: a.appId, title: a.title, vertical: vId, country: market, source: 'search' });
          }
          searchRows += playApps.length + appleApps.length;
        }
      }
    }
    onLog('info', `search battery done: ${searchRows} sightings; ${countDiscoveredApps()} distinct rows total`);

    // ── Phase 4: enrichment (+ install-band gate) ────────────────────────────
    setJobPhase(job.id, 'enriching', 'app detail');
    let enrichSummary = await enrichApps(buildWorklist(), onLog);
    logEnrich(onLog, 'enrichment', enrichSummary);

    // ── Phase 5: developer-catalog expansion, then a second enrichment pass ──
    setJobPhase(job.id, 'enriching', 'developer catalogs');
    const catalogApps = await expandDeveloperCatalogs(onLog);
    if (catalogApps > 0) {
      onLog('info', `dev-catalog: +${catalogApps} portfolio apps discovered; re-enriching`);
      enrichSummary = await enrichApps(buildWorklist(), onLog);
      logEnrich(onLog, 're-enrichment', enrichSummary);
    }

    // ── Phase 6: publisher rollup ────────────────────────────────────────────
    setJobPhase(job.id, 'classifying', 'publisher rollup');
    rollupPublishers(onLog);

    // ── Phase 7: confirmation (GATC RPC + optional Meta), budgeted ───────────
    setJobPhase(job.id, 'classifying', 'confirmation');
    const confirm = await confirmPublishers({ maxApiCalls: params.confirmationMaxApiCalls, onLog });

    // ── Phase 8: scoring ─────────────────────────────────────────────────────
    setJobPhase(job.id, 'classifying', 'scoring');
    scoreAllPublishers(onLog);

    // ── Phase 9: leads + Prospector CSV ──────────────────────────────────────
    setJobPhase(job.id, 'building_csv', 'publisher CSV');
    const publishers = listPublishersByScore(1_000_000);
    // Dedupe against leads earlier jobs already exported, then persist the
    // survivors into the shared lead store (spec step 12).
    const { path: csvPath, rowsWritten, exported } = buildPublisherCsv(job.id, publishers, leadHistorySeed());
    const persisted = persistPublisherLeads(job.id, exported);
    onLog(
      'info',
      `CSV written: ${csvPath} (${rowsWritten} publisher leads, ${publishers.length - rowsWritten} deduped against existing leads; ${persisted} saved)`,
    );

    // ── Run summary ──────────────────────────────────────────────────────────
    printRunSummary(onLog, { confirm, enrichSummary, publishers: publishers.length });

    // `ads` is this RUN's discovery volume, not the lifetime size of the
    // discovered_apps table — that table accumulates across every run, so
    // reporting its total made each job look like it had re-scraped everything.
    const appsThisRun = chartRows + newSimilar + searchRows + catalogApps;
    markJobCompleted(job.id, csvPath, { ads: appsThisRun, advertisers: rowsWritten });
    onLog('info', 'store-first job completed');

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh)
        .then(() => onLog('info', 'notification dispatched'))
        .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
    }
  } catch (err) {
    const msg = (err as Error).message || 'unknown error';
    log.error(`store-first job ${job.id} failed`, err);
    onLog('error', `job failed: ${msg}`);
    markJobFailed(job.id, msg);
    const fresh = getJob(job.id);
    if (fresh) void notifyJobFailed(fresh).catch(() => {});
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
async function expandDeveloperCatalogs(onLog: OnLog): Promise<number> {
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

  // Split the budget per store. Play was listed first against ONE shared
  // counter, so with more Play developers than the budget the Apple loop never
  // executed a single request. Play gets half; whatever it leaves flows to Apple.
  const playShare = Math.ceil(total / 2);
  const playUsed = await runStore(playDevelopersWithContact(), playShare, (id, cc) => playDeveloper(id, cc, onLog), 'google_play');
  const appleUsed = await runStore(appleArtistsWithContact(), total - playUsed, (id, cc) => appleDeveloper(id, cc, onLog), 'app_store');

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
