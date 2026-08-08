/**
 * Enrichment + install-band gate (spec steps 6 & 7).
 *
 * Given a worklist of distinct (store, app_id) apps, fetch each app's full detail
 * CACHE-FIRST against the permanent store_app_detail table:
 *   • a previously-succeeded app makes ZERO requests (permanent cache);
 *   • a previously-failed app retries until MAX_ENRICH_ATTEMPTS, then stays failed.
 * Play detail comes one-by-one (gplay.app); Apple detail is batched (/lookup).
 * is_game is decided by the SAME rules the GATC pipeline uses (appCategory.ts):
 *   Play genreId starts with GAME → game; Apple primaryGenreId 6014 or 6014 in
 *   genreIds → game. category_raw is the store's own label.
 *
 * INSTALL-BAND GATE (Play only): the gate does not decide whether to FETCH detail
 * (minInstalls is only known after the fetch), it decides ELIGIBILITY — a non-chart
 * Play app whose minInstalls falls outside TAIL_MIN..TAIL_MAX is stored+enriched
 * but marked out-of-band, so confirmation and tail-publisher scoring skip it.
 * Chart apps are always in-band-exempt. Apple apps have no install signal and are
 * never band-gated.
 *
 * ENRICHMENT ORDER: chart apps first; then non-chart apps with a known (cached)
 * minInstalls, descending; then remaining non-chart apps by most-recent store
 * update; then the rest. Bounded by ENRICH_MAX_APPS_PER_RUN network fetches.
 */

import { isGameApple, isGamePlayCategory } from './appCategory.js';
import {
  getAppDetail,
  upsertAppDetail,
  type StoreKind,
  type StoreAppDetailRow,
} from './storeDiscoveryDb.js';
import { playAppDetail } from './playSource.js';
import { appleLookup, type AppleAppDetail } from './appleSource.js';
import {
  MAX_ENRICH_ATTEMPTS,
  ENRICH_MAX_APPS_PER_RUN,
  ITUNES_LOOKUP_BATCH,
  TAIL_MIN_INSTALLS,
  TAIL_MAX_INSTALLS,
} from './storeDiscoveryConfig.js';

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

export interface EnrichWorkItem {
  store: StoreKind;
  app_id: string;
  is_chart: boolean;
  /** Market to fetch detail against — a country the app was actually discovered
   *  in ('us' preferred). Geo-restricted apps 404 outside their market. */
  country?: string;
}

export interface EnrichSummary {
  apps: number; // distinct apps considered
  enriched: number; // freshly fetched this run
  cached: number; // served from permanent cache (no network)
  failed: number; // fetch failed (or capped-out)
  games: number;
  nonGames: number;
  unclassified: number;
  inBand: number; // Play non-chart apps within the install band
  outOfBand: number; // Play non-chart apps outside the band
  requests: number; // outbound store requests actually made
  cappedOut: number; // apps skipped because the fetch budget was exhausted
  /** Fetch budget still unspent when the pass ended. The pipeline calls
   *  enrichApps TWICE per run (once after discovery, once after the developer
   *  catalogs), and the budget used to be a fresh ENRICH_MAX_APPS_PER_RUN on each
   *  call — so a run silently spent up to 2x the configured ceiling (measured:
   *  3,202 + 2,480 = 5,682 Play fetches against a stated cap of 4,000). Threading
   *  the remainder into the second call makes the config value mean what it says. */
  budgetLeft: number;
}

/** Pure install-band predicate (Play). null installs ⇒ NOT in band (tail
 *  eligibility requires a known band). Exported for tests. */
export function isInInstallBand(minInstalls: number | null | undefined): boolean {
  if (minInstalls == null) return false;
  return minInstalls >= TAIL_MIN_INSTALLS && minInstalls <= TAIL_MAX_INSTALLS;
}

/** A cached detail is "usable" (skip re-fetch) when it succeeded, OR it failed
 *  but has already exhausted its retry budget. */
function cacheIsTerminal(row: StoreAppDetailRow | null): boolean {
  if (!row) return false;
  if (row.enrich_status !== 'failed') return true;
  return row.attempts >= MAX_ENRICH_ATTEMPTS;
}

function tally(summary: EnrichSummary, isGame: number | null): void {
  if (isGame === 1) summary.games++;
  else if (isGame === 0) summary.nonGames++;
  else summary.unclassified++;
}

/**
 * Order the worklist per the spec: chart first; then non-chart with a known
 * cached minInstalls (desc); then remaining non-chart by most-recent cached
 * store update (desc); then the rest (unknown — arbitrary but stable).
 */
async function orderWorklist(items: EnrichWorkItem[]): Promise<EnrichWorkItem[]> {
  // The cached metadata each row is ordered BY now comes from the database, so
  // it has to be resolved before the comparator runs — a comparator cannot
  // await, and sorting an array of pending promises would order the worklist by
  // nothing at all while still looking like it worked.
  const withMeta = await Promise.all(
    items.map(async (it, idx) => {
      const cached = await getAppDetail(it.store, it.app_id);
      return {
        it,
        idx,
        minInstalls: cached?.min_installs ?? null,
        updated: cached?.store_updated_at ?? null,
      };
    }),
  );
  withMeta.sort((a, b) => {
    // 1. chart apps first
    if (a.it.is_chart !== b.it.is_chart) return a.it.is_chart ? -1 : 1;
    // 2. known minInstalls desc (nulls after knowns)
    const am = a.minInstalls,
      bm = b.minInstalls;
    if (am != null && bm != null && am !== bm) return bm - am;
    if ((am == null) !== (bm == null)) return am == null ? 1 : -1;
    // 3. most-recent update desc (nulls after knowns)
    const au = a.updated,
      bu = b.updated;
    if (au != null && bu != null && au !== bu) return bu - au;
    if ((au == null) !== (bu == null)) return au == null ? 1 : -1;
    // 4. stable
    return a.idx - b.idx;
  });
  return withMeta.map((w) => w.it);
}

/**
 * Enrich a worklist. Writes results onto store_app_detail (permanent cache).
 * Returns a summary for the run's discovery funnel.
 *
 * `opts.shouldStop` (job Stop button) is polled between store fetches; a stop
 * ends the pass early and returns the partial summary — everything enriched so
 * far is already in the permanent cache, so nothing is lost.
 */
export async function enrichApps(
  items: EnrichWorkItem[],
  onLog?: LogFn,
  opts?: {
    shouldStop?: () => boolean | Promise<boolean>;
    /** Fetch-stream progress: (network units done, total units) — one unit is a
     *  Play detail fetch or an Apple lookup batch. Cache hits are excluded, so
     *  this tracks the part of the pass that actually costs wall-clock. */
    onProgress?: (done: number, total: number) => void;
    /** Network fetches this pass may spend. Defaults to the full configured
     *  ceiling; the pipeline passes the previous pass's `budgetLeft` so both
     *  passes of a run share ONE ENRICH_MAX_APPS_PER_RUN between them. */
    fetchBudget?: number;
  },
): Promise<EnrichSummary> {
  const summary: EnrichSummary = {
    apps: 0,
    enriched: 0,
    cached: 0,
    failed: 0,
    games: 0,
    nonGames: 0,
    unclassified: 0,
    inBand: 0,
    outOfBand: 0,
    requests: 0,
    cappedOut: 0,
    budgetLeft: 0,
  };

  // Dedupe by (store, app_id).
  const seen = new Set<string>();
  const unique: EnrichWorkItem[] = [];
  for (const it of items) {
    const k = `${it.store}|${it.app_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(it);
  }
  summary.apps = unique.length;

  const ordered = await orderWorklist(unique);

  // Split into cached-terminal (no fetch) vs to-fetch, preserving order.
  const toFetchPlay: EnrichWorkItem[] = [];
  const toFetchApple: EnrichWorkItem[] = [];
  let fetchBudget = Math.max(0, opts?.fetchBudget ?? ENRICH_MAX_APPS_PER_RUN);
  const budgetAtStart = fetchBudget;

  const noteBand = (it: EnrichWorkItem, minInstalls: number | null) => {
    if (it.store !== 'google_play' || it.is_chart) return;
    if (isInInstallBand(minInstalls)) summary.inBand++;
    else summary.outOfBand++;
  };

  for (const it of ordered) {
    const cached = await getAppDetail(it.store, it.app_id);
    if (cacheIsTerminal(cached)) {
      if (cached!.enrich_status === 'failed') summary.failed++;
      else {
        summary.cached++;
        tally(summary, cached!.is_game);
        noteBand(it, cached!.min_installs);
      }
      continue;
    }
    if (fetchBudget <= 0) {
      summary.cappedOut++;
      continue;
    }
    fetchBudget--;
    if (it.store === 'google_play') toFetchPlay.push(it);
    else toFetchApple.push(it);
  }

  summary.budgetLeft = fetchBudget;
  if (summary.cappedOut > 0) {
    onLog?.(
      'warn',
      `enrich: fetch budget exhausted (${budgetAtStart} of the run's ${ENRICH_MAX_APPS_PER_RUN}); ` +
        `${summary.cappedOut} apps deferred to a later run`,
    );
  }

  // The two stores throttle independently (Play ~5 req/s across 5 concurrent
  // streams, iTunes 1 req/3s), so
  // their fetch streams run CONCURRENTLY — same requests, same politeness,
  // wall-clock is max(streams) instead of their sum. Both streams mutate the
  // shared summary; JS is single-threaded, so the counters stay coherent.

  // Progress units: each Play fetch and each Apple batch is one unit.
  const appleGroups = groupByEnrichCountry(toFetchApple);
  let appleBatchTotal = 0;
  for (const [, g] of appleGroups) appleBatchTotal += Math.ceil(g.length / ITUNES_LOOKUP_BATCH);
  const progressTotal = toFetchPlay.length + appleBatchTotal;
  let progressDone = 0;
  const tick = () => opts?.onProgress?.(++progressDone, progressTotal);

  // ── Play: one detail fetch per app (already throttled inside playSource). ──
  const playStream = async () => {
    for (const it of toFetchPlay) {
      if (await opts?.shouldStop?.()) {
        onLog?.('warn', 'enrich: stop requested — ending Play enrichment early (cache keeps everything done so far)');
        return;
      }
      const prior = await getAppDetail(it.store, it.app_id);
      const attempts = (prior?.attempts ?? 0) + 1;
      summary.requests++;
      // eslint-disable-next-line no-await-in-loop
      const d = await playAppDetail(it.app_id, it.country || 'us', onLog);
      tick();
      if (!d) {
        await upsertAppDetail(failedRow(it.store, it.app_id, prior, attempts));
        summary.failed++;
        continue;
      }
      const isGame = playIsGame(d.genreId);
      await upsertAppDetail({
        store: 'google_play',
        app_id: d.appId,
        title: d.title || null,
        developer: d.developer || null,
        developer_id: d.developerId,
        developer_email: d.developerEmail,
        developer_website: d.developerWebsite,
        min_installs: d.minInstalls,
        genre_id: d.genreId,
        category_raw: d.genre ?? d.genreId,
        is_game: isGame,
        store_updated_at: d.updated,
        artist_id: null,
        seller_name: null,
        bundle_id: null,
        enrich_status: 'done',
        attempts,
      });
      summary.enriched++;
      tally(summary, isGame);
      noteBand(it, d.minInstalls);
    }
  };

  // ── Apple: batched /lookup, one storefront per batch. A geo-restricted app
  // resolves only in its own market (the same failure the Play path guards
  // against above), and /lookup takes a single country — so mixing markets in
  // one call would silently fail the minority-market apps into failedRow. ──
  const appleStream = async () => {
    for (const [cc, group] of appleGroups) {
      for (let i = 0; i < group.length; i += ITUNES_LOOKUP_BATCH) {
        if (await opts?.shouldStop?.()) {
          onLog?.('warn', 'enrich: stop requested — ending Apple lookups early (cache keeps everything done so far)');
          return;
        }
        const batch = group.slice(i, i + ITUNES_LOOKUP_BATCH);
        summary.requests++;
        // eslint-disable-next-line no-await-in-loop
        const map = await appleLookup(batch.map((b) => b.app_id), cc, onLog);
        tick();
        await enrichAppleBatch(batch, map, summary);
      }
    }
  };

  await Promise.all([playStream(), appleStream()]);
  return summary;
}

/** Group a worklist by the storefront its detail fetch must run against
 *  ('us' when unset — the least geo-restricted market and the historical
 *  default). Insertion order is preserved within and across groups. Exported
 *  for tests. */
export function groupByEnrichCountry(items: EnrichWorkItem[]): Map<string, EnrichWorkItem[]> {
  const groups = new Map<string, EnrichWorkItem[]>();
  for (const it of items) {
    const cc = (it.country || 'us').toLowerCase();
    let g = groups.get(cc);
    if (!g) groups.set(cc, (g = []));
    g.push(it);
  }
  return groups;
}

/** Write one /lookup batch's results (or failures) onto the cache + summary. */
async function enrichAppleBatch(
  batch: EnrichWorkItem[],
  map: Map<string, AppleAppDetail>,
  summary: EnrichSummary,
): Promise<void>{
  for (const it of batch) {
    const prior = await getAppDetail(it.store, it.app_id);
    const attempts = (prior?.attempts ?? 0) + 1;
    const d = map.get(it.app_id);
    if (!d) {
      await upsertAppDetail(failedRow(it.store, it.app_id, prior, attempts));
      summary.failed++;
      continue;
    }
    const isGame = appleIsGame(d.primaryGenreId, d.genreIds);
    await upsertAppDetail({
      store: 'app_store',
      app_id: d.appId,
      title: d.title || null,
      developer: d.sellerName ?? d.artistName ?? null,
      developer_id: d.artistId,
      developer_email: null, // Apple never publishes a contact email
      developer_website: d.sellerUrl,
      min_installs: null, // Apple exposes no install count
      genre_id: d.primaryGenreId,
      category_raw: d.primaryGenreName,
      is_game: isGame,
      store_updated_at: d.currentVersionReleaseDate,
      artist_id: d.artistId,
      seller_name: d.sellerName,
      bundle_id: d.bundleId,
      enrich_status: 'done',
      attempts,
    });
    summary.enriched++;
    tally(summary, isGame);
  }
}

function playIsGame(genreId: string | null): number | null {
  const g = isGamePlayCategory(genreId);
  return g === null ? null : g ? 1 : 0;
}
function appleIsGame(primaryGenreId: string | null, genreIds: string[]): number | null {
  // Apple always returns a genre for a resolved app, so this is 1/0 (never null).
  return isGameApple(primaryGenreId, genreIds) ? 1 : 0;
}

function failedRow(
  store: StoreKind,
  appId: string,
  prior: StoreAppDetailRow | null,
  attempts: number,
): Omit<StoreAppDetailRow, 'created_at' | 'updated_at'> {
  return {
    store,
    app_id: appId,
    title: prior?.title ?? null,
    developer: prior?.developer ?? null,
    developer_id: prior?.developer_id ?? null,
    developer_email: prior?.developer_email ?? null,
    developer_website: prior?.developer_website ?? null,
    min_installs: prior?.min_installs ?? null,
    genre_id: prior?.genre_id ?? null,
    category_raw: prior?.category_raw ?? null,
    is_game: prior?.is_game ?? null,
    store_updated_at: prior?.store_updated_at ?? null,
    artist_id: prior?.artist_id ?? null,
    seller_name: prior?.seller_name ?? null,
    bundle_id: prior?.bundle_id ?? null,
    enrich_status: 'failed',
    attempts,
  };
}

// ── offline unit tests (install-band gate) ───────────────────────────────────

export async function runStoreEnrichTests(): Promise<{ passed: number; failed: number; failures: string[] }> {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // Fetch-budget threading: the pipeline runs TWO enrichment passes per run and
  // they must share ONE ENRICH_MAX_APPS_PER_RUN. The regression this guards is a
  // silent 2x overspend — measured at 5,682 Play fetches against a stated 4,000.
  // An empty worklist touches neither DB nor network, so this stays hermetic.
  {
    const explicit = await enrichApps([], undefined, { fetchBudget: 1234 });
    check(explicit.budgetLeft === 1234, `unspent budget is reported back (got ${explicit.budgetLeft})`);
    check(explicit.apps === 0 && explicit.requests === 0, 'empty worklist makes no requests');

    const defaulted = await enrichApps([]);
    check(
      defaulted.budgetLeft === ENRICH_MAX_APPS_PER_RUN,
      `an omitted budget defaults to ENRICH_MAX_APPS_PER_RUN (got ${defaulted.budgetLeft})`,
    );

    const zero = await enrichApps([], undefined, { fetchBudget: 0 });
    check(zero.budgetLeft === 0, 'a fully-spent budget threads through as 0, not as the default');

    const negative = await enrichApps([], undefined, { fetchBudget: -5 });
    check(negative.budgetLeft === 0, 'a negative budget clamps to 0 rather than re-opening the cap');
  }

  // Install-band gate boundaries (TAIL_MIN=50k, TAIL_MAX=5M by default).
  check(isInInstallBand(TAIL_MIN_INSTALLS) === true, `band: min boundary ${TAIL_MIN_INSTALLS} in-band`);
  check(isInInstallBand(TAIL_MAX_INSTALLS) === true, `band: max boundary ${TAIL_MAX_INSTALLS} in-band`);
  check(isInInstallBand(TAIL_MIN_INSTALLS - 1) === false, 'band: below min out-of-band');
  check(isInInstallBand(TAIL_MAX_INSTALLS + 1) === false, 'band: above max out-of-band');
  check(isInInstallBand(1_000_000) === true, 'band: 1M in-band');
  check(isInInstallBand(0) === false, 'band: 0 installs out-of-band');
  check(isInInstallBand(null) === false, 'band: null installs out-of-band');
  check(isInInstallBand(undefined) === false, 'band: undefined installs out-of-band');

  // Apple lookups run one storefront per batch: a geo-restricted app resolves
  // only in the market it was sighted in, so mixing countries in one /lookup
  // call would silently fail the minority-market apps.
  const mkItem = (app_id: string, country?: string): EnrichWorkItem => ({
    store: 'app_store',
    app_id,
    is_chart: false,
    country,
  });
  const groups = groupByEnrichCountry([mkItem('1', 'us'), mkItem('2', 'de'), mkItem('3'), mkItem('4', 'DE')]);
  check([...groups.keys()].join(',') === 'us,de', 'country: one group per market, unset → us, case-folded');
  check(groups.get('us')?.map((i) => i.app_id).join(',') === '1,3', 'country: unset joins the us group in order');
  check(groups.get('de')?.map((i) => i.app_id).join(',') === '2,4', 'country: DE folds into de, order kept');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeEnrich.js') || process.argv[1].endsWith('storeEnrich.ts'));
if (isMain) {
  void runStoreEnrichTests().then(({ passed, failed, failures }) => {
    console.log(`storeEnrich tests: ${passed} passed, ${failed} failed`);
    for (const f of failures) console.log('  ' + f);
    process.exit(failed === 0 ? 0 : 1);
  });
}
