/**
 * Store-first discovery — persistence layer.
 *
 * Three tables, all created idempotently (CREATE TABLE IF NOT EXISTS), wired into
 * initDb() so they exist before any job or the publishers API route runs:
 *
 *   • discovered_apps      — every app the discovery layer has ever seen, from any
 *                            source (chart | similar | developer_catalog | search).
 *                            UNIQUE(store, app_id, country); chart rows carry
 *                            chart+rank, other sources leave them null. (spec step 1)
 *   • store_app_detail     — PERMANENT per-app enrichment cache keyed on
 *                            (store, app_id): developer/email/website/installs/
 *                            category/is_game/updated. A succeeded row is never
 *                            re-fetched; a failed row retries up to
 *                            MAX_ENRICH_ATTEMPTS. Mirrors app_category_cache. (step 6)
 *   • publishers           — one row per publisher entity, its portfolio rollup,
 *                            confirmation fields and score. (spec step 2)
 *   • publisher_identity   — identity key → publisher id. Every key a publisher
 *                            has EVER been known by, so a rollup whose merge_key
 *                            shifted still finds the row it already owns instead
 *                            of inserting a duplicate. (spec step 9)
 *
 * This module owns the DDL + typed row shapes + CRUD helpers. Higher-level logic
 * (rollup, confirmation, scoring, the pipeline) composes these.
 */

import { getDb } from './db.js';
import { TAIL_MIN_INSTALLS, TAIL_MAX_INSTALLS, SIMILAR_MAX_DEPTH } from './storeDiscoveryConfig.js';
import { log } from './logger.js';

export type StoreKind = 'google_play' | 'app_store';
export type DiscoverySource = 'chart' | 'similar' | 'developer_catalog' | 'search';
export type EnrichStatus = 'done' | 'failed' | 'skipped_band';

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface DiscoveredAppRow {
  id: number;
  store: StoreKind;
  app_id: string;
  title: string | null;
  vertical: string | null;
  country: string;
  source: DiscoverySource;
  discovery_depth: number;
  chart: string | null;
  rank: number | null;
  first_seen_at: number;
  last_seen_at: number;
  last_rank: number | null;
}

export interface StoreAppDetailRow {
  store: StoreKind;
  app_id: string;
  title: string | null;
  developer: string | null;
  developer_id: string | null; // Play developerId / Apple artistId (as string)
  developer_email: string | null; // Play only
  developer_website: string | null; // Play developerWebsite / Apple sellerUrl
  min_installs: number | null; // Play only
  genre_id: string | null; // Play genreId / Apple primaryGenreId
  category_raw: string | null;
  is_game: number | null; // 1=game, 0=non-game, NULL=unknown
  store_updated_at: number | null; // ms epoch of the store listing's last update
  artist_id: string | null; // Apple
  seller_name: string | null; // Apple sellerName
  bundle_id: string | null; // Apple
  enrich_status: EnrichStatus;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface PublisherRow {
  id: number;
  merge_key: string; // stable identity for idempotent upserts across runs
  name: string;
  play_developer_id: string | null;
  apple_seller_name: string | null;
  website: string | null;
  email: string | null;
  countries_charted: string; // json array — countries where an app CHARTED
  countries_seen: string; // json array — every country any app was sighted in
  verticals: string; // json array
  charted_app_count: number;
  app_count: number; // total portfolio size
  best_rank: number | null;
  both_stores: number; // bool 0/1
  in_band: number; // bool 0/1 — has an in-install-band app (tail eligibility)
  source_mix: string; // json object {chart:n, similar:n, ...}
  gatc_advertiser_id: string | null;
  gatc_ads_count: number | null;
  meta_active_ads: number | null;
  confirmed_advertiser: number; // bool 0/1
  is_game_publisher: number; // bool 0/1
  is_charted: number; // bool 0/1 — has at least one chart app (score profile switch)
  preview_url: string | null; // top app's store URL (lead preview link)
  preview_title: string | null;
  score: number;
  /** ms epoch of the last confirmation pass that touched this row. */
  last_confirm_at: number | null;
  created_at: number;
  updated_at: number;
}

// ── Boot repairs ─────────────────────────────────────────────────────────────

/**
 * What used to be here: `ensureStoreDiscoveryTables()`, a wall of
 * `CREATE TABLE IF NOT EXISTS` followed by `addColumnIfMissing()` calls that
 * read `PRAGMA table_info` and ALTERed anything a previous release had not
 * created. Every one of those tables and columns is now migration 1
 * (migrations.ts), applied once and recorded, so none of it has anything left
 * to do — and `PRAGMA` was SQLite-only in any case.
 *
 * What remains is the one repair that is about DATA rather than shape.
 */
export async function runStoreDiscoveryBootRepairs(): Promise<void> {
  await backfillDiscoveryDepth();
}

/**
 * ONE-SHOT repair of discovery_depth rows written under the OLD depth semantics.
 *
 * There is no migration framework here (tables are CREATE TABLE IF NOT EXISTS),
 * so this is invoked on every boot but guarded by a settings marker to actually
 * run once. The marker is load-bearing: state 1's predicate is NOT unreachable
 * going forward — the similar crawl legitimately lowers a search/developer_catalog
 * row's depth via MIN() without changing source (see upsertDiscoveredApp), and
 * re-running this repair on every boot would erase those real graph depths,
 * silently shrinking the similar-crawl frontier after every restart.
 *
 * Two legacy states, both of which make an app a bogus depth-0 crawl seed and so
 * re-create the runaway the depth sentinel was introduced to stop:
 *
 *  1. search / developer_catalog rows used to default to depth 0. Under the OLD
 *     semantics they were never graph-sighted, so → NON_GRAPH_DEPTH.
 *  2. similar rows that the old `discovery_depth = MIN(depth, 0)` update flattened
 *     to 0. A similar row is always written at parent+1, so depth 0 is impossible
 *     now and proves corruption. Their true depth is unrecoverable, so we clamp
 *     CONSERVATIVELY to SIMILAR_MAX_DEPTH — never crawled from. This self-heals:
 *     if such an app really is reachable at depth 1, the next run's crawl re-sights
 *     it from a chart seed and MIN() lowers it back.
 */
const DEPTH_BACKFILL_MARKER = 'store_discovery.depth_backfill_v1';

async function backfillDiscoveryDepth(): Promise<void>{
  const db = getDb();
  const done = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(DEPTH_BACKFILL_MARKER);
  if (done) return;
  const nonGraph = await db
    .prepare(
      `UPDATE discovered_apps SET discovery_depth = ?
        WHERE source IN ('search', 'developer_catalog') AND discovery_depth < ?`,
    )
    .run(NON_GRAPH_DEPTH, NON_GRAPH_DEPTH);
  const flattened = await db
    .prepare(`UPDATE discovered_apps SET discovery_depth = ? WHERE source = 'similar' AND discovery_depth = 0`)
    .run(SIMILAR_MAX_DEPTH);
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(DEPTH_BACKFILL_MARKER, Date.now());
  const n = nonGraph.changes + flattened.changes;
  if (n > 0) {
    log.info(
      `store-discovery: repaired discovery_depth on ${n} legacy rows ` +
        `(${nonGraph.changes} non-graph, ${flattened.changes} flattened similar)`,
    );
  }
}

// ── discovered_apps helpers ──────────────────────────────────────────────────

/** '' is what the store list payloads use for "not provided" — store NULL so
 *  COALESCE-based fill-in works and empty strings never masquerade as identity. */
function emptyToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

export interface UpsertAppInput {
  store: StoreKind;
  app_id: string;
  title?: string | null;
  vertical?: string | null;
  country: string;
  source: DiscoverySource;
  discovery_depth?: number;
  chart?: string | null;
  rank?: number | null;
  /** Publisher name from the list payload (Play `developer`, Apple `artistName`). */
  list_developer?: string | null;
  /** Play `developerId` from the list payload — the SAME value that later lands in
   *  store_app_detail.developer_id, which is what makes the provisional publisher
   *  merge cleanly with the full rollup instead of duplicating it. */
  list_developer_id?: string | null;
}

/**
 * discovery_depth measures distance along the SIMILAR graph from a chart app, so
 * it is only meaningful for the two sources that form that graph: `chart` (0) and
 * `similar` (parent+1). Apps found by `search` or `developer_catalog` are not in
 * the graph at all and get this sentinel, which is deliberately larger than any
 * allowed SIMILAR_MAX_DEPTH so they are never picked as crawl seeds.
 *
 * This matters across runs: these sources previously defaulted to depth 0 and the
 * update path lowered depth with MIN(), so on run 2 every search-discovered app —
 * and any depth-1/2 app that later turned up in a search — became a depth-0 seed
 * and the crawl bound silently dissolved.
 */
export const NON_GRAPH_DEPTH = 99;

/** The sources that define the similar-crawl graph and may set discovery_depth. */
function isGraphSource(s: DiscoverySource): boolean {
  return s === 'chart' || s === 'similar';
}

/**
 * Upsert one discovered app. Unique on (store, app_id, country). On conflict we
 * refresh last_seen_at, last_rank and title, and UPGRADE the source only from a
 * weaker discovery mode to a stronger one is NOT done — instead we keep the
 * FIRST (strongest-by-arrival) source but always keep chart/rank if this sighting
 * is a chart sighting (chart is the most valuable provenance). Returns whether the
 * row was freshly inserted (used to enforce SIMILAR_MAX_APPS_PER_RUN on NEW apps).
 */
/**
 * Which (rank, chart) a repeat chart sighting should leave on the row.
 *
 * `rank` is the BEST rank ever seen and `last_rank` the most recent one — that is what
 * the two columns are for, and `rank` is what publisherRollup reads to derive
 * best_rank and to pick the preview app. One app legitimately charts more than once
 * per (store, app_id, country): phase 1 walks every chart × category, so a free
 * finance app with IAP can be #5 in TOP_FREE and #180 in TOP_GROSSING. Writing `rank`
 * unconditionally kept whichever sighting was written LAST, so that app reported
 * best_rank 180 and forfeited ~22 of the 25 rank points in the charted score.
 *
 * Pure so it can be tested without a database — the bug it fixes was invisible
 * precisely because this decision lived inline in a SQL parameter list.
 */
export function bestChartSighting(args: {
  isChart: boolean;
  existingRank: number | null;
  existingChart: string | null;
  newRank: number | null;
  newChart: string | null;
}): { rank: number | null; chart: string | null } {
  const { isChart, existingRank, existingChart, newRank, newChart } = args;
  // A non-chart sighting never touches chart provenance.
  if (!isChart) return { rank: existingRank, chart: existingChart };
  const keepNew = newRank != null && (existingRank == null || newRank < existingRank);
  return {
    rank: keepNew ? newRank : existingRank,
    // Relabel the chart only when this sighting owns the best rank — or when no chart
    // was recorded yet, so a first chart sighting still labels the row.
    chart: keepNew || existingChart == null ? (newChart ?? existingChart) : existingChart,
  };
}

export async function upsertDiscoveredApp(
  input: UpsertAppInput,
  retry = 0,
): Promise<{ id: number; inserted: boolean }> {
  const now = Date.now();
  const db = getDb();
  const existing = await db
    .prepare(`SELECT id, rank, chart FROM discovered_apps WHERE store = ? AND app_id = ? AND country = ?`)
    .get(input.store, input.app_id, input.country) as
    | { id: number; rank: number | null; chart: string | null }
    | undefined;

  if (!existing) {
    // RETURNING id, because `lastInsertRowid` was a better-sqlite3 concept and
    // has no equivalent here — the identity value has to be asked for.
    //
    // ON CONFLICT DO NOTHING covers the gap the port opened: the SELECT above
    // and this INSERT used to be one uninterruptible synchronous turn, so
    // "no row exists" could not stop being true between them. Two pipeline
    // workers can now interleave there, and UNIQUE(store, app_id, country)
    // would turn that race into a thrown error mid-crawl. When the insert is
    // skipped, `inserted` comes back undefined and the retry below takes the
    // update path — exactly what this call would have done had it read a
    // moment later.
    const inserted = (await db
      .prepare(
        `INSERT INTO discovered_apps
           (store, app_id, title, vertical, country, source, discovery_depth, chart, rank, first_seen_at, last_seen_at, last_rank,
            list_developer, list_developer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (store, app_id, country) DO NOTHING
         RETURNING id`,
      )
      .get(
        input.store,
        input.app_id,
        input.title ?? null,
        input.vertical ?? null,
        input.country,
        input.source,
        input.discovery_depth ?? (isGraphSource(input.source) ? 0 : NON_GRAPH_DEPTH),
        input.chart ?? null,
        input.rank ?? null,
        now,
        now,
        input.rank ?? null,
        emptyToNull(input.list_developer),
        emptyToNull(input.list_developer_id),
      )) as { id: number } | undefined;
    if (inserted) return { id: Number(inserted.id), inserted: true };
    // Lost the race. Re-read and fall through to the update path; `retry`
    // bounds it so a genuinely impossible state cannot spin forever.
    if (retry >= 2) {
      throw new Error(
        `upsertDiscoveredApp: ${input.store}/${input.app_id}/${input.country} neither inserted nor found after ${retry} attempts`,
      );
    }
    return await upsertDiscoveredApp(input, retry + 1);
  }

  // Update: always refresh last_seen; keep title/vertical if newly known; a chart
  // sighting always (re)writes chart+rank+last_rank and promotes source→chart.
  const isChart = input.source === 'chart';
  const { rank: bestRank, chart: bestChart } = bestChartSighting({
    isChart,
    existingRank: existing.rank,
    existingChart: existing.chart,
    newRank: input.rank ?? null,
    newChart: input.chart ?? null,
  });
  await db.prepare(
    `UPDATE discovered_apps
        SET last_seen_at = ?,
            title = COALESCE(?, title),
            vertical = COALESCE(?, vertical),
            source = CASE WHEN ? = 1 THEN 'chart' ELSE source END,
            chart = CASE WHEN ? = 1 THEN ? ELSE chart END,
            rank = CASE WHEN ? = 1 THEN ? ELSE rank END,
            last_rank = CASE WHEN ? = 1 THEN ? ELSE last_rank END,
            discovery_depth = CASE WHEN ? = 1 THEN LEAST(discovery_depth, ?) ELSE discovery_depth END,
            -- COALESCE(existing, new): first writer wins, and a later sighting
            -- that happens to omit the identity can never blank one we already
            -- hold. (Same shape as title/vertical above, opposite argument order
            -- because here the STORED value is the one to keep.)
            list_developer = COALESCE(list_developer, ?),
            list_developer_id = COALESCE(list_developer_id, ?)
      WHERE id = ?`,
  ).run(
    now,
    input.title ?? null,
    input.vertical ?? null,
    isChart ? 1 : 0,
    isChart ? 1 : 0,
    bestChart,
    isChart ? 1 : 0,
    bestRank,
    // last_rank keeps the MOST RECENT sighting — that is the column's whole purpose,
    // and it is what makes rank-vs-last_rank drift visible (an app sliding down the
    // chart keeps its best rank here and its current rank there).
    isChart ? 1 : 0,
    input.rank ?? null,
    // Only a chart/similar sighting may lower depth; search and developer_catalog
    // leave an existing graph depth untouched.
    isGraphSource(input.source) ? 1 : 0,
    input.discovery_depth ?? 0,
    emptyToNull(input.list_developer),
    emptyToNull(input.list_developer_id),
    existing.id,
  );
  return { id: existing.id, inserted: false };
}

export async function getDiscoveredApp(store: StoreKind, appId: string, country: string): Promise<DiscoveredAppRow | null>{
  return (
    (await getDb()
      .prepare(`SELECT * FROM discovered_apps WHERE store = ? AND app_id = ? AND country = ?`)
      .get(store, appId, country) as DiscoveredAppRow) ?? null
  );
}

/** SQL fragment (aggregated per GROUP BY group): the storefront a store fetch
 *  for this group must run against — 'us' when it was sighted there (the least
 *  geo-restricted market and the historical default, so cached rows keep
 *  meaning the same thing), otherwise the alphabetically-first market it WAS
 *  sighted in. A geo-restricted app or developer (e.g. a German bank charting
 *  only in de) resolves ONLY in its own market: querying us for it returns
 *  nothing, indistinguishable from a real miss. Shared by the enrichment
 *  worklist and both developer-catalog sets so the preference cannot drift
 *  between phases; the trailing 'us' covers LEFT-JOINed groups with no
 *  sighting row at all. Exported for the pipeline's one-shot stamp purge,
 *  which must select geo-restricted rows by the SAME preference. */
export const sightedCountrySql = (col: string): string =>
  `COALESCE(MAX(CASE WHEN ${col} = 'us' THEN ${col} END), MIN(${col}), 'us')`;

/** Distinct (store, app_id) pairs for a store, most-charted first. Used as the
 *  similar-crawl seed set and the enrichment worklist source. `country` is the
 *  storefront the detail fetch must run against (see sightedCountrySql) —
 *  fetching a geo-restricted app elsewhere 404s it into a permanent 'failed'
 *  after MAX_ENRICH_ATTEMPTS. */
export async function distinctAppsForStore(
  store: StoreKind,
): Promise<{ app_id: string; min_depth: number; is_chart: number; country: string; }[]>{
  return await getDb()
    .prepare(
      `SELECT app_id,
              MIN(discovery_depth) AS min_depth,
              MAX(CASE WHEN source = 'chart' THEN 1 ELSE 0 END) AS is_chart,
              ${sightedCountrySql('country')} AS country
         FROM discovered_apps
        WHERE store = ?
        GROUP BY app_id`,
    )
    .all(store) as Array<{ app_id: string; min_depth: number; is_chart: number; country: string }>;
}

/**
 * Similar-crawl seed set for one depth level (spec step 4).
 *
 * Seeds are apps whose SHALLOWEST graph sighting is exactly `depth`, restricted
 * to the run's active verticals. At depth 0 that is precisely the chart apps —
 * search/developer_catalog rows carry NON_GRAPH_DEPTH and can never qualify — so
 * an app at SIMILAR_MAX_DEPTH is never crawled from (verification #4).
 *
 * The vertical filter is on the app's own sightings, so a chart app harvested for
 * a vertical that is not active this run does not seed this run's crawl.
 *
 * `country` is the storefront the similar query must run against (see
 * sightedCountrySql): similar results are storefront-listings too, so a
 * geo-restricted seed queried in us yields nothing and contributes zero graph
 * edges — the same silent loss the enrichment and catalog phases guard against.
 */
export async function similarSeedApps(
  store: StoreKind,
  depth: number,
  verticals: string[],
): Promise<{ app_id: string; vertical: string | null; country: string; }[]>{
  if (verticals.length === 0) return [];
  const placeholders = verticals.map(() => '?').join(',');
  // MIN(vertical) just picks one deterministic vertical for an app sighted under
  // several; it is carried onto the app's similar results so vertical attribution
  // survives the crawl (a depth-1 app has no chart vertical of its own).
  return await getDb()
    .prepare(
      `SELECT app_id,
              MIN(vertical) AS vertical,
              ${sightedCountrySql('country')} AS country
         FROM discovered_apps
        WHERE store = ?
          AND vertical IN (${placeholders})
        GROUP BY app_id
       HAVING MIN(discovery_depth) = ?`,
    )
    .all(store, ...verticals, depth) as Array<{ app_id: string; vertical: string | null; country: string }>;
}

export async function countDiscoveredApps(): Promise<number>{
  return (await getDb().prepare(`SELECT COUNT(*) AS n FROM discovered_apps`).get() as { n: number }).n;
}

/** Source → count across all discovered_apps (funnel widget input). */
export async function discoveredCountsBySource(): Promise<Record<string, number>>{
  const rows = await getDb()
    .prepare(`SELECT source, COUNT(*) AS n FROM discovered_apps GROUP BY source`)
    .all() as Array<{ source: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source] = r.n;
  return out;
}

// ── store_app_detail (permanent enrichment cache) helpers ────────────────────

export async function getAppDetail(store: StoreKind, appId: string): Promise<StoreAppDetailRow | null>{
  return (
    (await getDb().prepare(`SELECT * FROM store_app_detail WHERE store = ? AND app_id = ?`).get(store, appId) as
      | StoreAppDetailRow) ?? null
  );
}

export async function upsertAppDetail(rec: Omit<StoreAppDetailRow, 'created_at' | 'updated_at'>): Promise<void>{
  const now = Date.now();
  await getDb()
    .prepare(
      `INSERT INTO store_app_detail
         (store, app_id, title, developer, developer_id, developer_email, developer_website,
          min_installs, genre_id, category_raw, is_game, store_updated_at, artist_id, seller_name,
          bundle_id, enrich_status, attempts, created_at, updated_at)
       VALUES (@store, @app_id, @title, @developer, @developer_id, @developer_email, @developer_website,
          @min_installs, @genre_id, @category_raw, @is_game, @store_updated_at, @artist_id, @seller_name,
          @bundle_id, @enrich_status, @attempts, @now, @now)
       ON CONFLICT(store, app_id) DO UPDATE SET
          title = excluded.title,
          developer = excluded.developer,
          developer_id = excluded.developer_id,
          developer_email = excluded.developer_email,
          developer_website = excluded.developer_website,
          min_installs = excluded.min_installs,
          genre_id = excluded.genre_id,
          category_raw = excluded.category_raw,
          is_game = excluded.is_game,
          store_updated_at = excluded.store_updated_at,
          artist_id = excluded.artist_id,
          seller_name = excluded.seller_name,
          bundle_id = excluded.bundle_id,
          enrich_status = excluded.enrich_status,
          attempts = excluded.attempts,
          updated_at = excluded.updated_at`,
    )
    .run({
      store: rec.store,
      app_id: rec.app_id,
      title: rec.title,
      developer: rec.developer,
      developer_id: rec.developer_id,
      developer_email: rec.developer_email,
      developer_website: rec.developer_website,
      min_installs: rec.min_installs,
      genre_id: rec.genre_id,
      category_raw: rec.category_raw,
      is_game: rec.is_game,
      store_updated_at: rec.store_updated_at,
      artist_id: rec.artist_id,
      seller_name: rec.seller_name,
      bundle_id: rec.bundle_id,
      enrich_status: rec.enrich_status,
      attempts: rec.attempts,
      now,
    });
}

// ── publishers helpers ───────────────────────────────────────────────────────

// last_confirm_at is excluded: the CONFIRMATION pass owns that column, and a
// rollup must never reset it or every re-run would restart the confirmation queue.
export type PublisherUpsert = Omit<PublisherRow, 'id' | 'created_at' | 'updated_at' | 'last_confirm_at'>;

/** The columns an absorb merges: everything but the row's own identity/timestamps. */
export type PublisherMergedFields = Omit<PublisherRow, 'id' | 'merge_key' | 'created_at' | 'updated_at'>;

function parseJsonArray(s: string): string[] {
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonCounts(s: string): Record<string, number> {
  try {
    const v: unknown = JSON.parse(s);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number') out[k] = n;
    return out;
  } catch {
    return {};
  }
}

/**
 * Fold a duplicate publisher row into the row that survives it. Pure, so the
 * merge rules are unit-testable without a database.
 *
 * The two rows are the SAME entity split in two by a merge_key that moved, so
 * nothing may be dropped: contact fields and confirmation evidence COALESCE /
 * take the stronger value, provenance sets union, and the confirmation clock
 * keeps the later stamp (the entity really was confirmed then — resetting it
 * would send it back to the head of the confirmation queue).
 *
 * Portfolio counts (app_count, charted_app_count, source_mix) take the MAX per
 * value rather than the sum: the rows describe ONE portfolio at two points in
 * time (the newer one normally holds a superset), so summing would inflate it.
 * That also makes the merge itself idempotent — merging a row with itself is the
 * identity — which is what lets a re-run absorb safely.
 */
export function mergePublisherFields(survivor: PublisherRow, orphan: PublisherRow): PublisherMergedFields {
  const richer = orphan.app_count > survivor.app_count ? orphan : survivor;
  const minOf = (a: number | null, b: number | null): number | null =>
    a == null ? b : b == null ? a : Math.min(a, b);
  const maxOf = (a: number | null, b: number | null): number | null =>
    a == null ? b : b == null ? a : Math.max(a, b);
  const unionJson = (a: string, b: string): string =>
    JSON.stringify([...new Set([...parseJsonArray(a), ...parseJsonArray(b)])].sort());
  const mix = parseJsonCounts(survivor.source_mix);
  for (const [k, n] of Object.entries(parseJsonCounts(orphan.source_mix))) mix[k] = Math.max(mix[k] ?? 0, n);

  return {
    name: richer.name,
    play_developer_id: survivor.play_developer_id ?? orphan.play_developer_id,
    apple_seller_name: survivor.apple_seller_name ?? orphan.apple_seller_name,
    website: survivor.website ?? orphan.website,
    email: survivor.email ?? orphan.email,
    countries_charted: unionJson(survivor.countries_charted, orphan.countries_charted),
    countries_seen: unionJson(survivor.countries_seen, orphan.countries_seen),
    verticals: unionJson(survivor.verticals, orphan.verticals),
    charted_app_count: Math.max(survivor.charted_app_count, orphan.charted_app_count),
    app_count: Math.max(survivor.app_count, orphan.app_count),
    best_rank: minOf(survivor.best_rank, orphan.best_rank),
    both_stores: survivor.both_stores || orphan.both_stores ? 1 : 0,
    in_band: survivor.in_band || orphan.in_band ? 1 : 0,
    source_mix: JSON.stringify(mix),
    gatc_advertiser_id: survivor.gatc_advertiser_id ?? orphan.gatc_advertiser_id,
    gatc_ads_count: maxOf(survivor.gatc_ads_count, orphan.gatc_ads_count),
    meta_active_ads: maxOf(survivor.meta_active_ads, orphan.meta_active_ads),
    confirmed_advertiser: survivor.confirmed_advertiser || orphan.confirmed_advertiser ? 1 : 0,
    is_game_publisher: richer.is_game_publisher,
    is_charted: survivor.is_charted || orphan.is_charted ? 1 : 0,
    preview_url: survivor.preview_url ?? orphan.preview_url,
    preview_title: survivor.preview_title ?? orphan.preview_title,
    score: Math.max(survivor.score, orphan.score),
    last_confirm_at: maxOf(survivor.last_confirm_at, orphan.last_confirm_at),
  };
}

/**
 * Every publisher any of `keys` already resolves to, oldest first.
 *
 * The publishers.merge_key arm is not redundant with publisher_identity: rows
 * written before this table existed have no identity entries, and their stored
 * merge_key is itself one of the group's keys (mergeKeyFor's prefixes are a
 * subset of identityKeysFor's), so this is what lazily adopts them instead of
 * duplicating them. The JOIN keeps a key that outlived an absorbed row from
 * resolving to an id that is gone.
 */
async function resolvePublisherIds(keys: string[]): Promise<number[]>{
  if (keys.length === 0) return [];
  const ph = keys.map(() => '?').join(',');
  return (
    await getDb()
      .prepare(
        `SELECT p.id AS id FROM publisher_identity i JOIN publishers p ON p.id = i.publisher_id
          WHERE i.identity_key IN (${ph})
          UNION
         SELECT id FROM publishers WHERE merge_key IN (${ph})
          ORDER BY id ASC`,
      )
      .all(...keys, ...keys) as Array<{ id: number }>
  ).map((r) => r.id);
}

/** Point every key at `publisherId`. Keys are cumulative: an identity a
 *  publisher was once known by keeps resolving to it after its merge_key moves. */
async function rememberPublisherIdentity(publisherId: number, keys: string[]): Promise<void>{
  const stmt = await getDb().prepare(
    `INSERT INTO publisher_identity (identity_key, publisher_id) VALUES (?, ?)
     ON CONFLICT(identity_key) DO UPDATE SET publisher_id = excluded.publisher_id`,
  );
  for (const k of keys) await stmt.run(k, publisherId);
}

/**
 * Fold `orphanId` into `survivorId` and delete it (spec step 9: one publisher
 * row per entity). Idempotent: it only ever runs when one merged app group
 * claims BOTH rows — the same domain/name/developerId evidence the rollup
 * merges on — and once the orphan is gone there is nothing left to absorb.
 */
async function absorbPublisher(survivorId: number, orphanId: number): Promise<void>{
  if (survivorId === orphanId) return;
  const db = getDb();
  const survivor = await getPublisher(survivorId);
  const orphan = await getPublisher(orphanId);
  if (!survivor || !orphan) return;
  await db.prepare(
    `UPDATE publishers
        SET name = @name, play_developer_id = @play_developer_id, apple_seller_name = @apple_seller_name,
            website = @website, email = @email, countries_charted = @countries_charted,
            countries_seen = @countries_seen, verticals = @verticals, charted_app_count = @charted_app_count,
            app_count = @app_count, best_rank = @best_rank, both_stores = @both_stores, in_band = @in_band,
            source_mix = @source_mix, gatc_advertiser_id = @gatc_advertiser_id, gatc_ads_count = @gatc_ads_count,
            meta_active_ads = @meta_active_ads, confirmed_advertiser = @confirmed_advertiser,
            is_game_publisher = @is_game_publisher, is_charted = @is_charted, preview_url = @preview_url,
            preview_title = @preview_title, score = @score, last_confirm_at = @last_confirm_at,
            updated_at = @now
      WHERE id = @id`,
  ).run({ ...mergePublisherFields(survivor, orphan), id: survivorId, now: Date.now() });
  await db.prepare(`UPDATE publisher_identity SET publisher_id = ? WHERE publisher_id = ?`).run(survivorId, orphanId);
  await db.prepare(`DELETE FROM publishers WHERE id = ?`).run(orphanId);
  log.info(`store-discovery: absorbed duplicate publisher #${orphanId} into #${survivorId} ("${survivor.name}")`);
}

/**
 * Idempotent upsert of one merged app group. Returns the publisher id.
 *
 * Identity comes from `identityKeys` (every key the group asserts), NOT from
 * merge_key alone: merge_key is recomputed from the group's contents on every
 * rollup, so an entity whose group gains its first Play app — or that unions
 * with another group — emits a DIFFERENT key than the one already stored, and a
 * plain ON CONFLICT(merge_key) inserts a second row for it that countPublishers,
 * the score pass, the confirmation budget and the lead export all double-count
 * (spec step 9, verification 5). Resolving by the whole key set instead makes N
 * runs over a growing corpus converge on one row, and folds in any duplicate an
 * earlier run already created.
 */
export async function upsertPublisher(
  p: PublisherUpsert,
  identityKeys: string[],
  opts?: {
    /**
     * Provisional (fast-lane) mode: this row was built from LIST payloads, which
     * know LESS than a row built from enriched detail pages. The full rollup may
     * legitimately overwrite everything (it recomputed the world); a provisional
     * writer must not. In this mode the conflict clause:
     *   • never lowers enrichment-derived facts (in_band, both_stores,
     *     is_game_publisher, source_mix, countries, verticals, previews, name),
     *   • only raises counters (app_count, charted_app_count, is_charted) and
     *     only improves best_rank,
     * so a partially-enriched publisher keeps every fact its detail pages earned.
     * Regression this guards: a provisional upsert zeroed in_band/both_stores/
     * is_game_publisher on a publisher whose new chart app hadn't enriched yet.
     */
    preserveEnriched?: boolean;
  },
): Promise<number>{
  const now = Date.now();
  const db = getDb();
  const keys = [...new Set([p.merge_key, ...identityKeys])];

  // Re-key the surviving row to this run's merge_key BEFORE the insert, so the
  // statement below lands on it through its own ON CONFLICT and insert/update
  // stay one code path. Any other row the group claims is absorbed first, which
  // is also what frees that merge_key if a duplicate happened to hold it.
  const claimed = await resolvePublisherIds(keys);
  if (claimed.length > 0) {
    const survivorId = claimed[0]; // oldest row wins, so created_at survives
    for (const orphanId of claimed.slice(1)) await absorbPublisher(survivorId, orphanId);
    await db.prepare(`UPDATE publishers SET merge_key = ? WHERE id = ?`).run(p.merge_key, survivorId);
  }

  await db.prepare(
    `INSERT INTO publishers
       (merge_key, name, play_developer_id, apple_seller_name, website, email, countries_charted, countries_seen, verticals,
        charted_app_count, app_count, best_rank, both_stores, in_band, source_mix, gatc_advertiser_id,
        gatc_ads_count, meta_active_ads, confirmed_advertiser, is_game_publisher, is_charted, preview_url,
        preview_title, score, created_at, updated_at)
     VALUES (@merge_key, @name, @play_developer_id, @apple_seller_name, @website, @email, @countries_charted, @countries_seen, @verticals,
        @charted_app_count, @app_count, @best_rank, @both_stores, @in_band, @source_mix, @gatc_advertiser_id,
        @gatc_ads_count, @meta_active_ads, @confirmed_advertiser, @is_game_publisher, @is_charted, @preview_url,
        @preview_title, @score, @now, @now)
     ON CONFLICT(merge_key) DO UPDATE SET ${
       opts?.preserveEnriched
         ? `name = publishers.name,
        play_developer_id = COALESCE(publishers.play_developer_id, excluded.play_developer_id),
        apple_seller_name = publishers.apple_seller_name,
        website = publishers.website,
        email = publishers.email,
        countries_charted = publishers.countries_charted,
        countries_seen = publishers.countries_seen,
        verticals = publishers.verticals,
        charted_app_count = GREATEST(publishers.charted_app_count, excluded.charted_app_count),
        app_count = GREATEST(publishers.app_count, excluded.app_count),
        best_rank = CASE
          WHEN publishers.best_rank IS NULL THEN excluded.best_rank
          WHEN excluded.best_rank IS NULL THEN publishers.best_rank
          ELSE LEAST(publishers.best_rank, excluded.best_rank) END,
        both_stores = publishers.both_stores,
        in_band = publishers.in_band,
        source_mix = publishers.source_mix,
        is_game_publisher = publishers.is_game_publisher,
        is_charted = GREATEST(publishers.is_charted, excluded.is_charted),
        preview_url = COALESCE(publishers.preview_url, excluded.preview_url),
        preview_title = COALESCE(publishers.preview_title, excluded.preview_title),`
         : `name = excluded.name,
        play_developer_id = COALESCE(excluded.play_developer_id, publishers.play_developer_id),
        apple_seller_name = COALESCE(excluded.apple_seller_name, publishers.apple_seller_name),
        website = COALESCE(excluded.website, publishers.website),
        email = COALESCE(excluded.email, publishers.email),
        countries_charted = excluded.countries_charted,
        countries_seen = excluded.countries_seen,
        verticals = excluded.verticals,
        charted_app_count = excluded.charted_app_count,
        app_count = excluded.app_count,
        best_rank = excluded.best_rank,
        both_stores = excluded.both_stores,
        in_band = excluded.in_band,
        source_mix = excluded.source_mix,
        is_game_publisher = excluded.is_game_publisher,
        is_charted = excluded.is_charted,
        preview_url = excluded.preview_url,
        preview_title = excluded.preview_title,`
     }
        updated_at = @now`,
  ).run({ ...p, now });
  const row = await db.prepare(`SELECT id FROM publishers WHERE merge_key = ?`).get(p.merge_key) as { id: number };
  await rememberPublisherIdentity(row.id, keys);
  return row.id;
}

/**
 * Write confirmation fields back onto a publisher.
 *
 * Absence of evidence is not evidence of absence: a provider that did not RUN
 * this pass (GATC on cooldown, Meta with no API key) passes null for its fields,
 * and null LEAVES THE STORED VALUE ALONE rather than erasing it.
 *
 * confirmed_advertiser is then DERIVED from the resulting counts rather than
 * passed in, so it can never contradict them. That fixes a real data loss: a
 * cooldown-skipped pass used to null a publisher's paid-for ad count and flip it
 * back to unconfirmed. A provider that genuinely re-measures and finds zero can
 * still decay the flag — only a pass that measured nothing leaves it alone.
 */
export async function setPublisherConfirmation(
  id: number,
  fields: {
    gatc_advertiser_id: string | null;
    gatc_ads_count: number | null;
    meta_active_ads: number | null;
  },
): Promise<void>{
  await getDb()
    .prepare(
      `UPDATE publishers
          SET gatc_advertiser_id = COALESCE(?, gatc_advertiser_id),
              gatc_ads_count = COALESCE(?, gatc_ads_count),
              meta_active_ads = COALESCE(?, meta_active_ads),
              confirmed_advertiser =
                CASE WHEN COALESCE(?, gatc_ads_count, 0) > 0
                       OR COALESCE(?, meta_active_ads, 0) > 0
                     THEN 1 ELSE 0 END,
              last_confirm_at = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(
      fields.gatc_advertiser_id,
      fields.gatc_ads_count,
      fields.meta_active_ads,
      fields.gatc_ads_count,
      fields.meta_active_ads,
      Date.now(),
      Date.now(),
      id,
    );
}

export async function setPublisherScore(id: number, score: number): Promise<void>{
  await getDb().prepare(`UPDATE publishers SET score = ?, updated_at = ? WHERE id = ?`).run(score, Date.now(), id);
}

export async function getPublisher(id: number): Promise<PublisherRow | null>{
  return (await getDb().prepare(`SELECT * FROM publishers WHERE id = ?`).get(id) as PublisherRow) ?? null;
}

export async function listPublishersByScore(limit = 5000): Promise<PublisherRow[]>{
  return await getDb()
    .prepare(`SELECT * FROM publishers ORDER BY score DESC, charted_app_count DESC LIMIT ?`)
    .all(limit) as PublisherRow[];
}

export async function countPublishers(): Promise<number>{
  return (await getDb().prepare(`SELECT COUNT(*) AS n FROM publishers`).get() as { n: number }).n;
}

export async function countConfirmedPublishers(): Promise<number>{
  return (await getDb().prepare(`SELECT COUNT(*) AS n FROM publishers WHERE confirmed_advertiser = 1`).get() as { n: number }).n;
}

/** Count of apps with a successful enrichment (funnel widget). */
export async function countEnrichedApps(): Promise<number>{
  return (await getDb().prepare(`SELECT COUNT(*) AS n FROM store_app_detail WHERE enrich_status = 'done'`).get() as { n: number }).n;
}

/** Count of enriched Play apps whose minInstalls falls in [min,max] (funnel). */
export async function countInBandApps(min: number, max: number): Promise<number>{
  return (
    await getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM store_app_detail
          WHERE store = 'google_play' AND enrich_status = 'done'
            AND min_installs IS NOT NULL AND min_installs >= ? AND min_installs <= ?`,
      )
      .get(min, max) as { n: number }
  ).n;
}

export async function countPublishersWithEmail(): Promise<number>{
  return (await getDb()
    .prepare(`SELECT COUNT(*) AS n FROM publishers WHERE email IS NOT NULL AND email <> ''`)
    .get() as { n: number }).n;
}

/**
 * Distinct Play developerIds whose enriched detail carries a website or email —
 * the step-8 developer-catalog expansion set (Play). `country` is the storefront
 * the catalog fetch must run against (see sightedCountrySql): a developer whose
 * apps were only ever sighted in de lists a catalog only in de, and a us fetch
 * would return an empty catalog that gets stamped as expanded anyway.
 *
 * ORDERED by value, because DEV_CATALOG_MAX_PER_RUN cuts this list off: charted
 * developers first, then in-band ones, then by install size. Unordered, the
 * budget was spent in SQLite insertion order and could be exhausted entirely on
 * out-of-band tail developers before a single charted one was reached.
 */
export async function playDevelopersWithContact(): Promise<{ id: string; country: string; }[]>{
  return await getDb()
    .prepare(
      `SELECT d.developer_id AS id,
              ${sightedCountrySql('a.country')} AS country
         FROM store_app_detail d
         LEFT JOIN discovered_apps a
           ON a.store = d.store AND a.app_id = d.app_id
        WHERE d.store = 'google_play' AND d.developer_id IS NOT NULL
          AND (d.developer_website IS NOT NULL OR d.developer_email IS NOT NULL)
        GROUP BY d.developer_id
        ORDER BY MAX(CASE WHEN a.source = 'chart' THEN 1 ELSE 0 END) DESC,
                 MAX(CASE WHEN d.min_installs BETWEEN ? AND ? THEN 1 ELSE 0 END) DESC,
                 MAX(COALESCE(d.min_installs, 0)) DESC`,
    )
    .all(TAIL_MIN_INSTALLS, TAIL_MAX_INSTALLS) as Array<{ id: string; country: string }>;
}

/** Distinct Apple artistIds whose enriched detail carries a seller URL — the
 *  step-8 developer-catalog expansion set (Apple). Charted artists first, for
 *  the same budget reason as the Play list above; `country` as there. */
export async function appleArtistsWithContact(): Promise<{ id: string; country: string; }[]>{
  return await getDb()
    .prepare(
      `SELECT d.artist_id AS id,
              ${sightedCountrySql('a.country')} AS country
         FROM store_app_detail d
         LEFT JOIN discovered_apps a
           ON a.store = d.store AND a.app_id = d.app_id
        WHERE d.store = 'app_store' AND d.artist_id IS NOT NULL
          AND d.developer_website IS NOT NULL
        GROUP BY d.artist_id
        ORDER BY MAX(CASE WHEN a.source = 'chart' THEN 1 ELSE 0 END) DESC,
                 MIN(COALESCE(a.rank, 9999)) ASC`,
    )
    .all() as Array<{ id: string; country: string }>;
}

// ── rollup / confirmation read helpers ───────────────────────────────────────

/**
 * Every successfully-enriched, still-listed app detail — the rollup input set.
 *
 * Delisted apps are excluded here rather than deleted: the row stays as the
 * record that we checked and it was gone (so the sweep does not keep re-checking
 * it), but it no longer inflates its publisher's app_count, both_stores flag or
 * portfolio score. This is the single chokepoint for that rule — publisherRollup
 * reads its whole world through this function.
 */
/**
 * How many apps the rollup would actually see — the SAME predicate as
 * allDoneAppDetails, as a COUNT.
 *
 * Exists for the background lead pump's change detection: a full rollup loads
 * every enriched app and every discovery sighting, which is far too heavy to run
 * on a 15-second timer just to discover that nothing moved. This is one indexed
 * count, so an idle tick costs effectively nothing.
 */
export async function countDoneAppDetails(): Promise<number>{
  return (
    await getDb()
      .prepare(`SELECT COUNT(*) AS c FROM store_app_detail WHERE enrich_status = 'done' AND delisted_at IS NULL`)
      .get() as { c: number }
  ).c;
}

export async function allDoneAppDetails(): Promise<StoreAppDetailRow[]>{
  return await getDb()
    .prepare(`SELECT * FROM store_app_detail WHERE enrich_status = 'done' AND delisted_at IS NULL`)
    .all() as StoreAppDetailRow[];
}

/**
 * Apps due a liveness re-check, least-recently-checked first.
 *
 * Only 'done' rows are candidates: a row that never enriched has nothing to keep
 * accurate. `staleBefore` keeps a run from re-checking what it just checked — apps
 * checked more recently than that are not offered at all, so the budget always
 * goes to the oldest knowledge first.
 *
 * Delisted rows stay in the pool DELIBERATELY. Apps get pulled and re-listed
 * (policy strikes, temporary regional removals, re-publishes), and excluding
 * tombstoned rows would make delisting permanent: enrichment already treats the
 * row as settled and the rollup already skips it, so nothing else would ever look
 * at it again and a returning app would stay invisible forever. Because a check
 * stamps last_live_check_at either way, a tombstoned app costs at most one request
 * per staleness window, and markAppLiveness clears the tombstone the moment the
 * store answers with the listing again.
 */
export async function listLivenessCandidates(
  store: StoreKind,
  staleBefore: number,
  limit: number,
): Promise<{ app_id: string; country: string; }[]>{
  if (limit <= 0) return [];
  return await getDb()
    .prepare(
      `SELECT d.app_id AS app_id,
              ${sightedCountrySql('a.country')} AS country
         FROM store_app_detail d
         LEFT JOIN discovered_apps a
           ON a.store = d.store AND a.app_id = d.app_id
        WHERE d.store = @store
          AND d.enrich_status = 'done'
          AND COALESCE(d.last_live_check_at, 0) < @staleBefore
        GROUP BY d.app_id
        ORDER BY COALESCE(MAX(d.last_live_check_at), 0) ASC
        LIMIT @limit`,
    )
    .all({ store, staleBefore, limit }) as Array<{ app_id: string; country: string }>;
}

/**
 * Record a liveness verdict. `gone` writes the tombstone; a live result only
 * advances the checked-at stamp. Callers must never pass an inconclusive result
 * here — 'unknown' means ask again later, not gone.
 */
export async function markAppLiveness(store: StoreKind, appId: string, gone: boolean): Promise<void>{
  await getDb()
    .prepare(
      `UPDATE store_app_detail
          SET last_live_check_at = @now,
              delisted_at = CASE WHEN @gone = 1 THEN COALESCE(delisted_at, @now) ELSE NULL END
        WHERE store = @store AND app_id = @appId`,
    )
    .run({ store, appId, gone: gone ? 1 : 0, now: Date.now() });
}

/** Count of apps currently tombstoned as removed from their store. */
export async function countDelistedApps(): Promise<number>{
  return (await getDb().prepare(`SELECT COUNT(*) AS n FROM store_app_detail WHERE delisted_at IS NOT NULL`).get() as {
    n: number;
  }).n;
}

/** Every identity key → publisher mapping. Lets a caller attribute an app to the
 *  publisher that OWNS it even after a merge, rather than to whichever single
 *  developerId/sellerName happened to land on the publishers row. */
export async function allPublisherIdentities(): Promise<{ identity_key: string; publisher_id: number; }[]>{
  return await getDb()
    .prepare(`SELECT identity_key, publisher_id FROM publisher_identity`)
    .all() as Array<{ identity_key: string; publisher_id: number }>;
}

export interface DiscoveredLite {
  store: StoreKind;
  app_id: string;
  country: string;
  source: DiscoverySource;
  rank: number | null;
  vertical: string | null;
  title: string | null;
}

/** Minimal discovered_apps projection used to aggregate a publisher's chart
 *  provenance (countries, best rank, source mix, verticals) during rollup. */
export async function allDiscoveredLite(): Promise<DiscoveredLite[]>{
  return await getDb()
    .prepare(`SELECT store, app_id, country, source, rank, vertical, title FROM discovered_apps`)
    .all() as DiscoveredLite[];
}

/**
 * Per-publisher app signals used by tail scoring: the min-installs of its Play apps
 * and the most-recent store update across its whole portfolio.
 *
 * Lives in publisherRollup (as allPublisherAppSignals) rather than here, because
 * attributing an app to its publisher needs the same identity-key construction the
 * rollup uses — and getting that wrong is not a small error. The previous version of
 * this helper matched on the SINGLE play_developer_id / apple_seller_name persisted on
 * the publishers row, but a merged publisher has several of each and buildPublisherRow
 * keeps only the first. A publisher the rollup marked in_band on developer B's
 * 300k-install app therefore scored its band from developer A's 10k app alone —
 * measured at 16 of 100 points lost, up to 20 at the band midpoint — and latestUpdate
 * was truncated the same way.
 */

/**
 * Confirmation queue order (spec step 10): (a) charted publishers, (b) in-band
 * tail publishers WITH an email, (c) in-band tail publishers WITHOUT an email.
 * Publishers that are neither charted nor in-band are excluded — there is no
 * chart fallback for them and they are not tail-eligible. Within each tier,
 * richer portfolios first for stable, useful budget spend.
 */
/**
 * The confirmation queue, in spec step 10's priority order: charted publishers,
 * then in-band tail publishers with an email, then in-band tail without.
 *
 * WITHIN a tier, never-confirmed publishers come first and the rest are ordered
 * least-recently-confirmed. Without that, a fixed CONFIRMATION_MAX_API_CALLS_PER_RUN
 * spent the whole budget re-confirming the SAME head of the queue on every run,
 * so a publisher ranked below roughly the budget size was never confirmed no
 * matter how many times the job ran. Now each run advances through the backlog.
 */
/**
 * Play publishers derivable from LIST payloads alone — the fast lane.
 *
 * WHY THIS EXISTS. The normal rollup reads its world through allDoneAppDetails(),
 * i.e. ENRICHED apps only. On a cold corpus that means a run can discover 8,000+
 * apps in under a minute and still roll up ZERO publishers — so zero
 * confirmations and zero leads — until ~27 minutes of 1.2 MB-per-app detail
 * fetching completes. Measured on a real production run: charts done at +49s,
 * then `rollup: 0 publishers` every 15s for the next six minutes.
 *
 * MEASURED CORRECTION (this cost a design iteration): Play's list endpoints do
 * NOT all return a developerId. Verified live against google-play-scraper 10.1.3:
 *   list()      → developer: "Block, Inc.", developerId: undefined
 *   similar()   → developer only
 *   developer() → developer only
 *   search()    → developerId === the developer NAME (Play uses the name as the
 *                 id for non-numeric developers)
 * So the identity a list payload actually carries is the developer NAME. That is
 * still enough, because it is the SAME string that later lands in
 * store_app_detail.developer.
 *
 * MERGE SAFETY. Grouping is therefore on `mergeNameKey(developer)` and the row
 * registers identity key `n:<that key>` — exactly what identityKeysFor() emits
 * for every rolled-up publisher (`mergeableNames` adds one per app,
 * unconditionally). So when the full rollup runs it resolves to the SAME
 * publisher row and updates it. Name-based merging is looser than id-based, but
 * it is precisely the merge evidence the existing rollup already uses, so this
 * introduces no new class of risk.
 *
 * PLAY ONLY: Apple's list shape has no comparable field, and Apple enriches 100
 * ids per request anyway, so there is nothing to win there.
 */
export interface ProvisionalPublisher {
  /** mergeNameKey(developer) — the identity this group asserts. */
  name_key: string;
  /** Display name (the most common raw spelling seen). */
  developer: string;
  /** Every raw spelling that normalised into this group. */
  raw_developers: string[];
  /** developerId when a payload happened to carry one (search does). */
  developer_id: string | null;
  app_count: number;
  charted_app_count: number;
  best_rank: number | null;
  preview_app_id: string | null;
  preview_title: string | null;
  countries: string[];
  verticals: string[];
  unenriched_apps: number;
  /** Real per-source counts, using the SAME vocabulary the full rollup emits
   *  (chart/search/similar/developer_catalog) — the Publishers view filters on
   *  this, so a synthetic key would hide provisional rows behind any filter. */
  source_mix: Record<string, number>;
}

interface RawDevGroup {
  developer: string;
  developer_id: string | null;
  app_count: number;
  charted_app_count: number;
  best_rank: number | null;
  unenriched_apps: number;
  countries: string | null;
  verticals: string | null;
  preview_app_id: string | null;
  preview_title: string | null;
  src_chart: number;
  src_search: number;
  src_similar: number;
  src_catalog: number;
}

/**
 * Raw per-developer aggregates straight from SQL. Grouped on the RAW name here
 * (SQL cannot call mergeNameKey); the caller folds these into normalised groups.
 */
export async function rawPlayListDeveloperGroups(limit = 20_000): Promise<RawDevGroup[]>{
  return await getDb()
    .prepare(
      `WITH preview AS (
         -- The group's representative app, chosen DETERMINISTICALLY.
         --
         -- This used to lean on SQLite's min()/max() "bare column" rule, but that
         -- guarantee holds only when the query contains EXACTLY ONE min/max
         -- aggregate — and this one has three (developer_id, best_rank,
         -- preview_sort). With more than one the row backing a bare column is
         -- explicitly undefined, so the preview app was correct only by luck of
         -- the current implementation. It is the lead's store_url, so a silent
         -- drift here would point customers at the wrong app page. ROW_NUMBER is
         -- defined behaviour and costs one windowed pass, not a subquery per group.
         SELECT list_developer, app_id, title,
                ROW_NUMBER() OVER (
                  PARTITION BY list_developer
                  ORDER BY CASE WHEN source = 'chart' THEN 0 ELSE 1 END,
                           rank IS NULL, rank ASC, app_id ASC
                ) AS rn
           FROM discovered_apps
          WHERE store = 'google_play' AND list_developer IS NOT NULL AND TRIM(list_developer) <> ''
       )
       SELECT d.list_developer                                       AS developer,
              MAX(d.list_developer_id)                               AS developer_id,
              COUNT(*)                                               AS app_count,
              SUM(CASE WHEN d.source = 'chart' THEN 1 ELSE 0 END)    AS charted_app_count,
              MIN(CASE WHEN d.source = 'chart' THEN d.rank END)      AS best_rank,
              SUM(CASE WHEN sd.app_id IS NULL THEN 1 ELSE 0 END)     AS unenriched_apps,
              -- Real per-source counts. The Publishers view filters on
              -- source_mix, so inventing a synthetic key here would make every
              -- provisional publisher disappear under any source filter — and
              -- the honest counts are right there in the rows being grouped.
              SUM(CASE WHEN d.source = 'chart' THEN 1 ELSE 0 END)     AS src_chart,
              SUM(CASE WHEN d.source = 'search' THEN 1 ELSE 0 END)    AS src_search,
              SUM(CASE WHEN d.source = 'similar' THEN 1 ELSE 0 END)   AS src_similar,
              SUM(CASE WHEN d.source = 'developer_catalog' THEN 1 ELSE 0 END) AS src_catalog,
              string_agg(DISTINCT d.country, ',')                    AS countries,
              string_agg(DISTINCT d.vertical, ',')                   AS verticals,
              -- From the CTE above: deterministic, not implementation-defined.
              MAX(pv.app_id)                                         AS preview_app_id,
              MAX(pv.title)                                          AS preview_title
         FROM discovered_apps d
         LEFT JOIN store_app_detail sd
                ON sd.store = d.store AND sd.app_id = d.app_id AND sd.enrich_status = 'done'
         LEFT JOIN preview pv
                ON pv.list_developer = d.list_developer AND pv.rn = 1
        WHERE d.store = 'google_play'
          AND d.list_developer IS NOT NULL
          AND TRIM(d.list_developer) <> ''
        GROUP BY d.list_developer
        ORDER BY charted_app_count DESC, app_count DESC
        LIMIT ?`,
    )
    .all(limit) as RawDevGroup[];
}

/** Play rows carrying list identity — the fast lane's input size. One indexed
 *  count, used to skip the whole pass when nothing new has been discovered. */
export async function countPlayListIdentityRows(): Promise<number>{
  return (
    await getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM discovered_apps
          WHERE store = 'google_play' AND list_developer IS NOT NULL AND TRIM(list_developer) <> ''`,
      )
      .get() as { c: number }
  ).c;
}

/** Apps of the given RAW developer names that still lack enrichment — the
 *  "enrich only the winners" worklist. Chart apps first, so contact details come
 *  from the publisher's most visible titles. */
export async function unenrichedAppsForPlayDevelopers(
  rawDevelopers: string[],
  limit = 25,
): Promise<{ app_id: string; country: string; }[]>{
  if (rawDevelopers.length === 0) return [];
  const holes = rawDevelopers.map(() => '?').join(',');
  return await getDb()
    .prepare(
      `SELECT d.app_id, d.country
         FROM discovered_apps d
         LEFT JOIN store_app_detail sd
                ON sd.store = d.store AND sd.app_id = d.app_id
        WHERE d.store = 'google_play' AND d.list_developer IN (${holes})
          AND (sd.app_id IS NULL OR sd.enrich_status <> 'done')
        ORDER BY CASE WHEN d.source = 'chart' THEN 0 ELSE 1 END, d.rank IS NULL, d.rank ASC
        LIMIT ?`,
    )
    .all(...rawDevelopers, limit) as Array<{ app_id: string; country: string }>;
}

export async function listPublishersForConfirmation(): Promise<PublisherRow[]>{
  return await getDb()
    .prepare(
      `SELECT * FROM publishers
        WHERE is_charted = 1 OR in_band = 1
        ORDER BY
          CASE
            WHEN is_charted = 1 THEN 0
            WHEN in_band = 1 AND email IS NOT NULL AND email <> '' THEN 1
            ELSE 2
          END ASC,
          COALESCE(last_confirm_at, 0) ASC,
          charted_app_count DESC, app_count DESC, id ASC`,
    )
    .all() as PublisherRow[];
}

// ── offline unit tests ───────────────────────────────────────────────────────

export function runStoreDiscoveryDbTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // The regression: an app charting twice for one (store, app_id, country) must keep
  // its BEST rank, not the last one written. Before this, phase 1 walking
  // TOP_FREE then TOP_GROSSING left the TOP_GROSSING rank on the row.
  const topFreeThenGrossing = bestChartSighting({
    isChart: true,
    existingRank: 5,
    existingChart: 'TOP_FREE',
    newRank: 180,
    newChart: 'TOP_GROSSING',
  });
  check(topFreeThenGrossing.rank === 5, 'rank: a worse later sighting does not replace the best rank');
  check(
    topFreeThenGrossing.chart === 'TOP_FREE',
    'rank: the chart label stays with the chart that produced the best rank',
  );

  const grossingThenTopFree = bestChartSighting({
    isChart: true,
    existingRank: 180,
    existingChart: 'TOP_GROSSING',
    newRank: 5,
    newChart: 'TOP_FREE',
  });
  check(grossingThenTopFree.rank === 5, 'rank: a better later sighting does replace the best rank');
  check(grossingThenTopFree.chart === 'TOP_FREE', 'rank: a better sighting relabels the chart with it');

  // Order independence is the property that actually matters: whichever way phase 1
  // happens to walk the charts, the row must settle on the same answer.
  check(
    topFreeThenGrossing.rank === grossingThenTopFree.rank &&
      topFreeThenGrossing.chart === grossingThenTopFree.chart,
    'rank: the outcome is independent of the order the charts were walked',
  );

  // First chart sighting on a row discovered by the graph (rank/chart still null).
  const firstSighting = bestChartSighting({
    isChart: true,
    existingRank: null,
    existingChart: null,
    newRank: 42,
    newChart: 'top-free',
  });
  check(firstSighting.rank === 42, 'rank: a first chart sighting sets the rank');
  check(firstSighting.chart === 'top-free', 'rank: a first chart sighting labels the chart');

  // A chart sighting carrying no rank must not blank an existing one...
  const ranklessChart = bestChartSighting({
    isChart: true,
    existingRank: 7,
    existingChart: 'TOP_FREE',
    newRank: null,
    newChart: 'TOP_GROSSING',
  });
  check(ranklessChart.rank === 7, 'rank: a rankless chart sighting keeps the existing rank');
  check(ranklessChart.chart === 'TOP_FREE', 'rank: a rankless sighting does not steal the chart label');

  // ...but it may still label a row that had no chart at all.
  const ranklessOnUnlabeled = bestChartSighting({
    isChart: true,
    existingRank: null,
    existingChart: null,
    newRank: null,
    newChart: 'TOP_FREE',
  });
  check(ranklessOnUnlabeled.chart === 'TOP_FREE', 'rank: a rankless sighting still labels an unlabeled row');

  // Non-chart sources never touch chart provenance (spec step 1).
  const fromSimilar = bestChartSighting({
    isChart: false,
    existingRank: 12,
    existingChart: 'TOP_FREE',
    newRank: 1,
    newChart: 'TOP_GROSSING',
  });
  check(fromSimilar.rank === 12, 'rank: a non-chart sighting leaves rank alone even with a better number');
  check(fromSimilar.chart === 'TOP_FREE', 'rank: a non-chart sighting leaves the chart label alone');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeDiscoveryDb.js') || process.argv[1].endsWith('storeDiscoveryDb.ts'));
if (isMain) {
  const { passed, failed, failures } = runStoreDiscoveryDbTests();
  console.log(`storeDiscoveryDb tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
