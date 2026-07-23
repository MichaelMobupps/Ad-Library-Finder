/**
 * App-category enrichment: game vs non-game for a resolved mobile app lead.
 *
 * The GATC mobile pipeline resolves an advertiser to a STORE URL (Play package or
 * Apple track id). "Is this a game?" cannot be answered from the advertiser name
 * or ad text — only the store listing is authoritative — so this module keys on
 * the app_id the pipeline already extracts and asks the store itself:
 *
 *   • Apple  (app_store):  itunes.apple.com/lookup?id=<id1,id2,…>&country=us
 *       is_game ⇐ primaryGenreId === 6014 OR genreIds contains 6014.
 *       category_raw = primaryGenreName. Batched up to 100 ids per call.
 *   • Google (google_play): fetch the listing and read the JSON-LD
 *       `applicationCategory` (e.g. GAME_STRATEGY, EDUCATION, FINANCE).
 *       is_game ⇐ value starts with "GAME". category_raw = that value.
 *       NOTE: the store's category-URL *path* is unreliable (Clash of Clans lists
 *       under FAMILY), so we deliberately use applicationCategory, not the path.
 *
 * Results are cached PERMANENTLY, keyed on app_id (mirrors hqCache): a succeeded
 * row is never re-fetched; a failed row retries up to MAX_ENRICH_ATTEMPTS across
 * runs, then stays unknown (is_game = null ⇒ "Unclassified"). Pure rule + parse
 * helpers are exported and covered by offline tests (runAppCategoryTests).
 */

import { getDb } from './db.js';
import { parsePlayPackage, parseITunesTrackId } from './storePageFetcher.js';
import { log } from './logger.js';

// ── Tunables (all env-overridable; see comments) ─────────────────────────────
/** Apple genre id for "Games" — the authoritative game marker. */
export const APPLE_GAMES_GENRE_ID = 6014;
/** Max app ids per itunes /lookup call (Apple accepts up to ~200; stay at 100). */
const ITUNES_BATCH = clampInt(process.env.GATC_ITUNES_BATCH, 100, 1, 200);
/** Apple throttle: min ms between /lookup calls (10 req/min ⇒ 6000ms). */
const ITUNES_MIN_INTERVAL_MS = clampInt(process.env.GATC_ITUNES_INTERVAL_MS, 6_000, 0, 60_000);
/** Play throttle: min ms between listing fetches (1 req/sec ⇒ 1000ms). */
const PLAY_MIN_INTERVAL_MS = clampInt(process.env.GATC_PLAY_INTERVAL_MS, 1_000, 0, 30_000);
/** Retry a failed enrichment at most this many times across runs, then give up. */
const MAX_ENRICH_ATTEMPTS = clampInt(process.env.GATC_MAX_ENRICH_ATTEMPTS, 3, 1, 10);
const FETCH_TIMEOUT_MS = clampInt(process.env.GATC_ENRICH_TIMEOUT_MS, 15_000, 2_000, 60_000);

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
export type AppStore = 'google_play' | 'app_store';

export interface AppCategory {
  app_id: string;
  store: AppStore;
  /** Store's own category label (primaryGenreName / applicationCategory), or null. */
  category_raw: string | null;
  /** true=game, false=non-game, null=unknown/unclassified. */
  is_game: boolean | null;
  enrichment_source: 'itunes_lookup' | 'play_listing' | 'cache' | null;
  failed: boolean;
}

export interface StoreRef {
  store: AppStore;
  app_id: string;
}

// ── Store-URL → (store, app_id) ──────────────────────────────────────────────

/** Identify the store and app id behind a resolved store URL, or null if it is
 *  not a Play/Apple listing (or is missing its id/package). */
export function parseStoreRef(storeUrl: string | null | undefined): StoreRef | null {
  if (!storeUrl || typeof storeUrl !== 'string') return null;
  if (/^https?:\/\/play\.google\.com/i.test(storeUrl)) {
    const pkg = parsePlayPackage(storeUrl);
    return pkg ? { store: 'google_play', app_id: pkg } : null;
  }
  if (/^https?:\/\/(apps|itunes)\.apple\.com/i.test(storeUrl)) {
    const id = parseITunesTrackId(storeUrl);
    return id ? { store: 'app_store', app_id: id } : null;
  }
  return null;
}

// ── Pure is_game rules (exported for tests) ──────────────────────────────────

/** Apple rule: primaryGenreId 6014, or 6014 anywhere in genreIds. genreIds come
 *  back as STRINGS ("6014") but tolerate numbers too. */
export function isGameApple(primaryGenreId: unknown, genreIds: unknown): boolean {
  const target = String(APPLE_GAMES_GENRE_ID);
  if (String(primaryGenreId) === target) return true;
  if (Array.isArray(genreIds) && genreIds.some((g) => String(g) === target)) return true;
  return false;
}

/** Play rule: applicationCategory value starts with "GAME" (GAME_STRATEGY,
 *  GAME_PUZZLE, …). Anything else (EDUCATION, FINANCE, …) is non-game. Empty ⇒
 *  null (unknown) so the caller can mark it unclassified rather than "non-game". */
export function isGamePlayCategory(applicationCategory: string | null | undefined): boolean | null {
  if (!applicationCategory) return null;
  return /^GAME/i.test(applicationCategory.trim());
}

/** Pull `applicationCategory` from a Play listing HTML: JSON-LD block first (the
 *  authoritative source), then a permissive regex fallback. Returns null if the
 *  page carried neither (blocked/interstitial/absent). */
export function extractPlayApplicationCategory(html: string): string | null {
  if (!html) return null;
  // 1. JSON-LD <script type="application/ld+json">{ …, applicationCategory }</script>
  const ldBlocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of ldBlocks) {
    try {
      const j = JSON.parse(m[1].trim()) as { applicationCategory?: unknown };
      if (typeof j.applicationCategory === 'string' && j.applicationCategory.trim()) {
        return j.applicationCategory.trim();
      }
    } catch {
      /* one malformed block shouldn't abort the scan */
    }
  }
  // 2. Regex fallback: `applicationCategory":"GAME_STRATEGY"` (also handles = form).
  const re = /applicationCategory["']?\s*[:=]\s*["']([^"']+)["']/i;
  const rm = html.match(re);
  if (rm && rm[1].trim()) return rm[1].trim();
  return null;
}

// ── Permanent cache (mirrors hqCache; keyed on app_id) ───────────────────────

export function ensureAppCategoryTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS app_category_cache (
      app_id TEXT PRIMARY KEY,
      store TEXT NOT NULL,
      category_raw TEXT,
      is_game INTEGER,              -- 1=game, 0=non-game, NULL=unknown
      enrichment_source TEXT,
      failed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
}

interface CacheRow {
  app_id: string;
  store: string;
  category_raw: string | null;
  is_game: number | null;
  enrichment_source: string | null;
  failed: number;
  attempts: number;
}

export function lookupAppCategoryCache(appId: string): (AppCategory & { attempts: number }) | null {
  if (!appId) return null;
  const row = getDb()
    .prepare(`SELECT * FROM app_category_cache WHERE app_id = ?`)
    .get(appId) as CacheRow | undefined;
  if (!row) return null;
  return {
    app_id: row.app_id,
    store: row.store as AppStore,
    category_raw: row.category_raw,
    is_game: row.is_game === null ? null : row.is_game === 1,
    enrichment_source: (row.enrichment_source as AppCategory['enrichment_source']) ?? 'cache',
    failed: row.failed === 1,
    attempts: row.attempts,
  };
}

function storeAppCategoryCache(rec: AppCategory, attempts: number): void {
  if (!rec.app_id) return;
  getDb()
    .prepare(
      `INSERT INTO app_category_cache (app_id, store, category_raw, is_game, enrichment_source, failed, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         store = excluded.store,
         category_raw = excluded.category_raw,
         is_game = excluded.is_game,
         enrichment_source = excluded.enrichment_source,
         failed = excluded.failed,
         attempts = excluded.attempts,
         created_at = excluded.created_at`,
    )
    .run(
      rec.app_id,
      rec.store,
      rec.category_raw,
      rec.is_game === null ? null : rec.is_game ? 1 : 0,
      rec.enrichment_source,
      rec.failed ? 1 : 0,
      attempts,
      Date.now(),
    );
}

/** Count cached rows — used by tests to assert the second pass makes 0 requests. */
export function countAppCategoryCache(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM app_category_cache`).get() as { n: number };
  return row.n;
}

/** Test helper: delete one entry (NOT exposed as a route). */
export function deleteAppCategoryCacheEntry(appId: string): void {
  getDb().prepare(`DELETE FROM app_category_cache WHERE app_id = ?`).run(appId);
}

// ── Live enrichment ──────────────────────────────────────────────────────────

interface ItunesResult {
  trackId?: number;
  trackName?: string;
  primaryGenreId?: number;
  primaryGenreName?: string;
  genreIds?: string[];
}

/** Fetch category for a batch of Apple track ids in ONE /lookup call. Returns a
 *  map id→AppCategory for the ids the API resolved; missing ids are the caller's
 *  to mark failed. Never throws — a transport error yields an empty map. */
export async function fetchItunesBatch(ids: string[], onLog?: LogFn): Promise<Map<string, AppCategory>> {
  const out = new Map<string, AppCategory>();
  if (ids.length === 0) return out;
  const url = `https://itunes.apple.com/lookup?id=${ids.map(encodeURIComponent).join(',')}&country=us`;
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      onLog?.('debug', `app-category: itunes lookup HTTP ${res.status} for ${ids.length} id(s)`);
      return out;
    }
    const json = (await res.json()) as { results?: ItunesResult[] };
    for (const r of json.results || []) {
      const id = r.trackId != null ? String(r.trackId) : '';
      if (!id) continue;
      out.set(id, {
        app_id: id,
        store: 'app_store',
        category_raw: r.primaryGenreName ?? null,
        is_game: isGameApple(r.primaryGenreId, r.genreIds),
        enrichment_source: 'itunes_lookup',
        failed: false,
      });
    }
  } catch (err) {
    onLog?.('debug', `app-category: itunes lookup failed (${(err as Error).message})`);
  }
  return out;
}

/** Fetch + parse ONE Play listing for its applicationCategory. Never throws. */
export async function fetchPlayCategory(pkg: string, onLog?: LogFn): Promise<AppCategory> {
  const base: AppCategory = { app_id: pkg, store: 'google_play', category_raw: null, is_game: null, enrichment_source: null, failed: true };
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      onLog?.('debug', `app-category: play listing HTTP ${res.status} for ${pkg}`);
      return base;
    }
    const html = await res.text();
    const cat = extractPlayApplicationCategory(html);
    if (!cat) return base; // page fetched but no category (interstitial/absent) → failed→retry
    return { app_id: pkg, store: 'google_play', category_raw: cat, is_game: isGamePlayCategory(cat), enrichment_source: 'play_listing', failed: false };
  } catch (err) {
    onLog?.('debug', `app-category: play fetch failed for ${pkg} (${(err as Error).message})`);
    return base;
  }
}

export interface EnrichSummary {
  apps: number;        // distinct app ids considered
  enriched: number;    // freshly resolved this run (network)
  cached: number;      // served from the permanent cache (no network)
  games: number;
  nonGames: number;
  unclassified: number;
  requests: number;    // outbound store requests actually made
}

/**
 * Enrich a set of store URLs to category/is_game, cache-first. Returns a map
 * store_url → AppCategory for the caller to write onto its lead rows, plus a
 * summary. Cache-first means: a previously-succeeded app makes zero requests
 * (permanent cache); a previously-failed app retries until MAX_ENRICH_ATTEMPTS.
 * Apple ids are batched; Play listings are fetched one-by-one, both throttled.
 */
export async function enrichStoreUrls(
  storeUrls: string[],
  onLog?: LogFn,
): Promise<{ byStoreUrl: Map<string, AppCategory>; summary: EnrichSummary }> {
  ensureAppCategoryTable();
  const byStoreUrl = new Map<string, AppCategory>();
  const summary: EnrichSummary = { apps: 0, enriched: 0, cached: 0, games: 0, nonGames: 0, unclassified: 0, requests: 0 };

  // Map every store URL to its (store, app_id); group unique app ids per store.
  const refByUrl = new Map<string, StoreRef>();
  const appleToFetch = new Map<string, string[]>(); // app_id → [store urls]
  const playToFetch = new Map<string, string[]>();
  const seenApp = new Set<string>();

  const tally = (rec: AppCategory) => {
    if (rec.is_game === true) summary.games++;
    else if (rec.is_game === false) summary.nonGames++;
    else summary.unclassified++;
  };

  for (const url of storeUrls) {
    if (byStoreUrl.has(url)) continue;
    const ref = parseStoreRef(url);
    if (!ref) continue;
    refByUrl.set(url, ref);

    // Cache-first (permanent for successes; retry-bounded for failures).
    const cached = lookupAppCategoryCache(ref.app_id);
    if (cached && (!cached.failed || cached.attempts >= MAX_ENRICH_ATTEMPTS)) {
      const rec: AppCategory = { ...cached, enrichment_source: cached.enrichment_source ?? 'cache' };
      byStoreUrl.set(url, rec);
      if (!seenApp.has(ref.app_id)) { seenApp.add(ref.app_id); summary.apps++; summary.cached++; tally(rec); }
      continue;
    }
    if (seenApp.has(ref.app_id)) continue; // another URL already queued this app id
    seenApp.add(ref.app_id);
    summary.apps++;
    const bucket = ref.store === 'app_store' ? appleToFetch : playToFetch;
    const list = bucket.get(ref.app_id) ?? [];
    list.push(url);
    bucket.set(ref.app_id, list);
  }

  const priorAttempts = (appId: string) => lookupAppCategoryCache(appId)?.attempts ?? 0;
  const applyRecord = (rec: AppCategory, urls: string[]) => {
    storeAppCategoryCache(rec, priorAttempts(rec.app_id) + 1);
    for (const u of urls) byStoreUrl.set(u, rec);
    if (rec.failed) summary.unclassified++;
    else { summary.enriched++; tally(rec); }
  };

  // ── Apple: batched /lookup ──
  const appleIds = [...appleToFetch.keys()];
  for (let i = 0; i < appleIds.length; i += ITUNES_BATCH) {
    const batch = appleIds.slice(i, i + ITUNES_BATCH);
    if (i > 0 && ITUNES_MIN_INTERVAL_MS > 0) await sleep(ITUNES_MIN_INTERVAL_MS);
    summary.requests++;
    const map = await fetchItunesBatch(batch, onLog);
    for (const id of batch) {
      const urls = appleToFetch.get(id)!;
      const rec = map.get(id) ?? { app_id: id, store: 'app_store' as AppStore, category_raw: null, is_game: null, enrichment_source: null, failed: true };
      applyRecord(rec, urls);
    }
  }

  // ── Play: one listing fetch per package, throttled ──
  const playIds = [...playToFetch.keys()];
  for (let i = 0; i < playIds.length; i++) {
    const id = playIds[i];
    if (i > 0 && PLAY_MIN_INTERVAL_MS > 0) await sleep(PLAY_MIN_INTERVAL_MS);
    summary.requests++;
    const rec = await fetchPlayCategory(id, onLog);
    applyRecord(rec, playToFetch.get(id)!);
  }

  return { byStoreUrl, summary };
}

// ───────────────────────────────────────────────────────────────────────────
// Offline unit tests (no network). Run via `node dist/appCategory.js`.
// ───────────────────────────────────────────────────────────────────────────

export function runAppCategoryTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // parseStoreRef
  check(
    JSON.stringify(parseStoreRef('https://play.google.com/store/apps/details?id=com.foo.bar')) ===
      JSON.stringify({ store: 'google_play', app_id: 'com.foo.bar' }),
    'parseStoreRef: play package',
  );
  check(
    JSON.stringify(parseStoreRef('https://apps.apple.com/us/app/x/id529479190')) ===
      JSON.stringify({ store: 'app_store', app_id: '529479190' }),
    'parseStoreRef: apple track id',
  );
  check(parseStoreRef('https://play.google.com/store/apps/details?id') === null, 'parseStoreRef: empty play id → null');
  check(parseStoreRef('https://example.com/x') === null, 'parseStoreRef: non-store → null');

  // Apple is_game rule — genre 6014 positive/negative, string + number forms.
  check(isGameApple(6014, ['6014', '7001']) === true, 'apple: primaryGenreId 6014 → game');
  check(isGameApple('6014', []) === true, 'apple: primaryGenreId "6014" (string) → game');
  check(isGameApple(6005, ['6005', '6002']) === false, 'apple: Social Networking → non-game');
  check(isGameApple(6017, ['6017', '6005']) === false, 'apple: Education → non-game');
  check(isGameApple(6005, ['6002', '6014']) === true, 'apple: 6014 present in genreIds → game');
  check(isGameApple(6005, 6014) === false, 'apple: genreIds not an array is ignored (only primary counts)');

  // Play is_game rule — GAME_* positive, others negative, empty → null.
  check(isGamePlayCategory('GAME_CASUAL') === true, 'play: GAME_CASUAL → game');
  check(isGamePlayCategory('GAME_STRATEGY') === true, 'play: GAME_STRATEGY → game');
  check(isGamePlayCategory('game_puzzle') === true, 'play: lowercase game_* → game');
  check(isGamePlayCategory('FINANCE') === false, 'play: FINANCE → non-game');
  check(isGamePlayCategory('EDUCATION') === false, 'play: EDUCATION → non-game');
  check(isGamePlayCategory('') === null, 'play: empty → null (unclassified)');
  check(isGamePlayCategory(null) === null, 'play: null → null (unclassified)');

  // extractPlayApplicationCategory — JSON-LD block + regex fallback.
  const ldGame = `<html><script type="application/ld+json">{"@type":"SoftwareApplication","name":"Clash","applicationCategory":"GAME_STRATEGY"}</script></html>`;
  check(extractPlayApplicationCategory(ldGame) === 'GAME_STRATEGY', 'extract: JSON-LD GAME_STRATEGY');
  const ldEdu = `<script type="application/ld+json">\n{"applicationCategory":"EDUCATION"}\n</script>`;
  check(extractPlayApplicationCategory(ldEdu) === 'EDUCATION', 'extract: JSON-LD EDUCATION');
  const regexOnly = `<div>...</div>x"applicationCategory":"GAME_PUZZLE",y`;
  check(extractPlayApplicationCategory(regexOnly) === 'GAME_PUZZLE', 'extract: regex fallback');
  check(extractPlayApplicationCategory('<html>no category here</html>') === null, 'extract: none → null');
  // A malformed ld+json block must not abort the scan; a later regex still wins.
  const brokenLd = `<script type="application/ld+json">{ not json </script> "applicationCategory":"FINANCE"`;
  check(extractPlayApplicationCategory(brokenLd) === 'FINANCE', 'extract: skips malformed ld+json, uses regex');

  // End-to-end classification via the two pure paths.
  check(isGamePlayCategory(extractPlayApplicationCategory(ldGame)) === true, 'e2e: play game listing → is_game true');
  check(isGamePlayCategory(extractPlayApplicationCategory(ldEdu)) === false, 'e2e: play education listing → is_game false');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('appCategory.js') || process.argv[1].endsWith('appCategory.ts'));
if (isMain) {
  const { passed, failed, failures } = runAppCategoryTests();
  console.log(`appCategory tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
