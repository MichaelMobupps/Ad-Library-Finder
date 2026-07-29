/**
 * Google Play discovery source (google-play-scraper, free).
 *
 * Wraps the five google-play-scraper endpoints the pipeline uses — charts (list),
 * similar apps, developer catalog, store search, and full app detail — behind a
 * 1-req/sec RateLimiter and MY OWN typed result shapes. The library's shipped
 * .d.ts mistypes enum-member access (`gplay.collection.TOP_FREE`), so the raw
 * module is isolated as `gplay: any` HERE and nowhere else; every value that
 * leaves this file is defensively coerced into a stable interface, because store
 * payloads drift and a scraper must never trust field presence.
 *
 * Every function NEVER throws: a transport/parse failure logs at debug and yields
 * an empty result, so one blocked call can't abort a whole harvest.
 */

import gplayDefault from 'google-play-scraper';
import {
  PLAY_REQUEST_INTERVAL_MS,
  PLAY_CONCURRENCY,
  PLAY_BLOCK_BACKOFF_MS,
  PLAY_CHART_NUM,
  PLAY_SEARCH_NUM,
  PLAY_DEV_CATALOG_NUM,
  type PlayChart,
} from './storeDiscoveryConfig.js';
import { RateLimiter } from './storeThrottle.js';
import { withDeadline } from './deadline.js';

// The library is CJS with a loose default-export type; cast once, isolate here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gplayRaw: any = gplayDefault as unknown;

/**
 * google-play-scraper drives `got` with NO timeout configured (verified in its
 * lib/utils/request.js), so every call can await forever — same unbounded-hang
 * class that wedged the 2026-07-29 meta job. This proxy puts a hard deadline on
 * every endpoint; the existing per-call catch blocks turn a breach into the
 * same []/null degradation as any other failure.
 */
const PLAY_CALL_TIMEOUT_MS = Number(process.env.PLAY_CALL_TIMEOUT_MS) || 45_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gplay: any = new Proxy(gplayRaw, {
  get(target, prop) {
    const v = target[prop];
    if (typeof v !== 'function') return v;
    return (...args: unknown[]) =>
      withDeadline(Promise.resolve(v.apply(target, args)), PLAY_CALL_TIMEOUT_MS, `gplay.${String(prop)}`);
  },
});

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

const limiter = new RateLimiter(PLAY_REQUEST_INTERVAL_MS, PLAY_CONCURRENCY);

/**
 * Does this failure look like Google pushing back (rather than an ordinary
 * missing listing)? google-play-scraper surfaces HTTP failures as Error messages
 * carrying the status, so match on those rather than on a typed field the library
 * does not promise.
 *
 * Exported for tests. Deliberately NARROW: a false positive here idles every Play
 * stream for PLAY_BLOCK_BACKOFF_MS, so only unambiguous rate-limit/forbidden
 * signals qualify — a 404 (app delisted) must never trip it.
 */
export function playRequestBlocked(err: unknown): boolean {
  const msg = ((err as Error)?.message || String(err ?? '')).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('403') ||
    msg.includes('forbidden') ||
    msg.includes('captcha') ||
    msg.includes('unusual traffic')
  );
}

/** Trip the shared adaptive backoff when a call looks blocked. Every Play stream
 *  behind the limiter holds off, so a penalty-boxed exit IP slows the harvest
 *  instead of being hammered into a longer ban. */
function notePlayFailure(err: unknown, where: string, onLog?: LogFn): void {
  if (!playRequestBlocked(err)) return;
  const already = limiter.penaltyRemainingMs();
  limiter.penalize(PLAY_BLOCK_BACKOFF_MS);
  if (already <= 0) {
    onLog?.('warn', `play: blocked on ${where} — backing off all Play streams for ${Math.round(PLAY_BLOCK_BACKOFF_MS / 1000)}s`);
  }
}

/** A chart/search/similar list item (partial detail). */
export interface PlayListApp {
  appId: string;
  title: string;
  developer: string;
  developerId: string;
}

/** Full app detail we care about (subset of IAppItemFullDetail). */
export interface PlayAppDetail {
  appId: string;
  title: string;
  developer: string;
  developerId: string | null;
  developerEmail: string | null;
  developerWebsite: string | null;
  minInstalls: number | null;
  genre: string | null;
  genreId: string | null;
  updated: number | null; // ms epoch
  free: boolean | null;
  offersIAP: boolean | null;
}

function coerceListItem(x: unknown): PlayListApp | null {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o.appId !== 'string' || !o.appId) return null;
  return {
    appId: o.appId,
    title: typeof o.title === 'string' ? o.title : '',
    developer: typeof o.developer === 'string' ? o.developer : '',
    developerId: typeof o.developerId === 'string' ? o.developerId : '',
  };
}

function coerceList(arr: unknown): PlayListApp[] {
  if (!Array.isArray(arr)) return [];
  const out: PlayListApp[] = [];
  for (const x of arr) {
    const item = coerceListItem(x);
    if (item) out.push(item);
  }
  return out;
}

/** The 18 GAME_* subcategories + base GAME (games vertical expansion). Read at
 *  call time from the live module so a library update that adds a GAME_* constant
 *  is picked up without a code change. */
export function expandPlayCategories(baseCategory: string, expandGames: boolean): string[] {
  if (!expandGames) return [baseCategory];
  const cats = gplay.category as Record<string, string>;
  const out = new Set<string>([baseCategory]);
  for (const key of Object.keys(cats)) {
    if (key === 'GAME' || key.startsWith('GAME_')) out.add(cats[key]);
  }
  return [...out];
}

/**
 * Our chart id → the collection token google-play-scraper actually accepts.
 *
 * The library's enum is { TOP_FREE, TOP_PAID, GROSSING } — there is no
 * TOP_GROSSING. Passing that name made gplay.list() throw "Invalid collection",
 * which this function swallowed into [], so the entire top-grossing half of
 * every Play harvest silently returned nothing. We keep TOP_GROSSING as OUR
 * stable id (it is what the spec, the config, the `chart` column and the UI all
 * say) and translate only at the library boundary.
 */
const PLAY_COLLECTION_TOKEN: Record<PlayChart, string> = {
  TOP_FREE: 'TOP_FREE',
  TOP_GROSSING: 'GROSSING',
};

/** Pull one Play chart (collection × category × country). Returns [] on failure. */
export async function playChart(
  category: string,
  chart: PlayChart,
  country: string,
  onLog?: LogFn,
): Promise<PlayListApp[]> {
  return limiter.schedule(async () => {
    try {
      const res = await gplay.list({
        category,
        collection: PLAY_COLLECTION_TOKEN[chart],
        country,
        num: PLAY_CHART_NUM,
        throttle: 10,
      });
      return coerceList(res);
    } catch (err) {
      // warn, not debug: a whole chart returning zero apps is a harvest-wide
      // hole and must never be invisible again.
      notePlayFailure(err, `chart ${category}/${chart}/${country}`, onLog);
      onLog?.('warn', `play chart ${category}/${chart}/${country} failed: ${(err as Error).message}`);
      return [];
    }
  });
}

/**
 * An app whose Play listing carries no "similar apps" cluster makes
 * google-play-scraper dereference a null cluster and throw this exact TypeError.
 * Measured on live seeds: the app itself resolves fine via gplay.app(), there is
 * simply no cluster to read — so it is a NORMAL long-tail outcome, not a failure.
 * It ran at ~14% of seeds in the finance/us smoke, and reporting each one as
 * "failed" would bury the errors that do matter under routine noise.
 */
const NO_SIMILAR_CLUSTER = /Cannot read propert(?:y|ies) of null/i;

/** Similar apps for a seed appId. Returns [] on failure. */
export async function playSimilar(appId: string, country: string, onLog?: LogFn): Promise<PlayListApp[]> {
  return limiter.schedule(async () => {
    try {
      return coerceList(await gplay.similar({ appId, country }));
    } catch (err) {
      const msg = (err as Error).message;
      if (NO_SIMILAR_CLUSTER.test(msg)) {
        onLog?.('debug', `play similar ${appId}/${country}: no similar-apps cluster on the listing`);
      } else {
        notePlayFailure(err, `similar ${appId}/${country}`, onLog);
        onLog?.('debug', `play similar ${appId}/${country} failed: ${msg}`);
      }
      return [];
    }
  });
}

/**
 * gplay reports `developerId` in the form it appears in the store URL: a space is
 * a '+', other reserved characters are %-escaped. gplay.developer() then encodes
 * whatever it is given, so handing that value straight back turns "PayPal+Mobile"
 * into "PayPal%2BMobile" and Play answers 404 — measured live: 445 of 579
 * non-numeric developer ids in one finance/us run carry a '+', so the catalog
 * phase lost the entire Play portfolio of every multi-word developer while still
 * reporting success. Numeric ids ("5187430147431084320") pass through unchanged.
 *
 * Decoding happens HERE, at the API boundary, and not at the point the id is
 * stored: publisherRollup groups publishers by the stored developer_id, so
 * rewriting it would repartition every existing publisher row.
 */
export function decodePlayDevId(devId: string): string {
  const spaced = devId.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    // A stray '%' that is not a valid escape makes decodeURIComponent throw;
    // the '+' → space fix alone is still strictly better than the raw value.
    return spaced;
  }
}

/** Full developer catalog (Play). `num` is a HARD cap in google-play-scraper (it
 *  slices the paginated result to that length), so the page size is a config
 *  tunable, not a literal — see PLAY_DEV_CATALOG_NUM. Returns [] on failure. */
export async function playDeveloper(devId: string, country = 'us', onLog?: LogFn): Promise<PlayListApp[]> {
  return limiter.schedule(async () => {
    const decoded = decodePlayDevId(devId);
    try {
      return coerceList(await gplay.developer({ devId: decoded, country, num: PLAY_DEV_CATALOG_NUM }));
    } catch (err) {
      notePlayFailure(err, `developer ${decoded}`, onLog);
      onLog?.('debug', `play developer ${decoded} failed: ${(err as Error).message}`);
      return [];
    }
  });
}

/** Store search (Play). Returns [] on failure. */
export async function playSearch(term: string, country: string, onLog?: LogFn): Promise<PlayListApp[]> {
  return limiter.schedule(async () => {
    try {
      return coerceList(await gplay.search({ term, country, num: PLAY_SEARCH_NUM }));
    } catch (err) {
      notePlayFailure(err, `search "${term}"/${country}`, onLog);
      onLog?.('debug', `play search "${term}"/${country} failed: ${(err as Error).message}`);
      return [];
    }
  });
}

/** Full app detail. Returns null on failure (caller marks the app failed). */
export async function playAppDetail(appId: string, country = 'us', onLog?: LogFn): Promise<PlayAppDetail | null> {
  return limiter.schedule(async () => {
    try {
      const a = (await gplay.app({ appId, country })) as Record<string, unknown>;
      if (!a || typeof a.appId !== 'string') return null;
      return {
        appId: a.appId,
        title: typeof a.title === 'string' ? a.title : '',
        developer: typeof a.developer === 'string' ? a.developer : '',
        developerId: typeof a.developerId === 'string' ? a.developerId : null,
        developerEmail: typeof a.developerEmail === 'string' && a.developerEmail ? a.developerEmail : null,
        developerWebsite: typeof a.developerWebsite === 'string' && a.developerWebsite ? a.developerWebsite : null,
        minInstalls: typeof a.minInstalls === 'number' ? a.minInstalls : null,
        genre: typeof a.genre === 'string' ? a.genre : null,
        genreId: typeof a.genreId === 'string' ? a.genreId : null,
        updated: typeof a.updated === 'number' ? a.updated : null,
        free: typeof a.free === 'boolean' ? a.free : null,
        offersIAP: typeof a.offersIAP === 'boolean' ? a.offersIAP : null,
      };
    } catch (err) {
      notePlayFailure(err, `app ${appId}/${country}`, onLog);
      onLog?.('debug', `play app ${appId}/${country} failed: ${(err as Error).message}`);
      return null;
    }
  });
}

/**
 * Whether a package is still listed on the Play store.
 *
 * DELIBERATELY separate from playAppDetail, which collapses "gone" and "the
 * request failed" into the same null. For a liveness sweep that conflation is not
 * acceptable: acting on it would mark live apps delisted every time Play
 * rate-limits us, silently shrinking the corpus and corrupting publisher
 * portfolios. google-play-scraper throws this exact message — verified live — for
 * a package that genuinely is not there, and anything else is 'unknown', which
 * the caller must treat as "ask again later", never as "gone".
 */
const PLAY_APP_NOT_FOUND = /App not found \(404\)/i;

export async function playAppLiveness(
  appId: string,
  country = 'us',
  onLog?: LogFn,
): Promise<'live' | 'gone' | 'unknown'> {
  return limiter.schedule(async () => {
    try {
      const a = (await gplay.app({ appId, country })) as Record<string, unknown>;
      return a && typeof a.appId === 'string' ? 'live' : 'unknown';
    } catch (err) {
      const msg = (err as Error).message || '';
      if (PLAY_APP_NOT_FOUND.test(msg)) return 'gone';
      notePlayFailure(err, `liveness ${appId}/${country}`, onLog);
      onLog?.('debug', `play liveness ${appId}/${country} inconclusive: ${msg}`);
      return 'unknown';
    }
  });
}

/** Canonical Play store URL for a package. */
export function playStoreUrl(appId: string): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}`;
}

// ── offline unit tests (no network — they only read the library's enums) ─────

/**
 * These guard the library boundary. Every chart id we ship must translate to a
 * collection token google-play-scraper actually accepts: an unknown token makes
 * gplay.list() throw, playChart() swallow it, and a whole chart come back empty
 * with no lead ever reaching the funnel. That is exactly how TOP_GROSSING was
 * lost, so the mapping is asserted against the LIVE enum rather than a copy.
 */
export function runPlaySourceTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // Adaptive-backoff classifier. It must fire on unambiguous rate-limit/block
  // signals and STAY SILENT otherwise: a false positive idles every Play stream
  // for PLAY_BLOCK_BACKOFF_MS, and 404s are routine long-tail noise.
  for (const msg of [
    'Request failed with status code 429',
    'Too Many Requests',
    'Request failed with status code 403',
    'Forbidden',
    'Our systems have detected unusual traffic',
    'captcha required',
  ]) {
    check(playRequestBlocked(new Error(msg)), `blocked: "${msg}" trips the backoff`);
  }
  for (const msg of [
    'App not found (404)',
    'Cannot read properties of null (reading \'0\')',
    'Invalid collection',
    'socket hang up',
    'ETIMEDOUT',
    'Request failed with status code 500',
  ]) {
    check(!playRequestBlocked(new Error(msg)), `not blocked: "${msg}" must not trip the backoff`);
  }
  check(!playRequestBlocked(null), 'null error does not trip the backoff');
  check(!playRequestBlocked(undefined), 'undefined error does not trip the backoff');
  check(playRequestBlocked('HTTP 429 from play'), 'a bare string carrying 429 is recognised');

  const collections = Object.values((gplay.category ? gplay.collection : {}) as Record<string, string>);
  check(collections.length > 0, 'library exposes a collection enum');

  for (const [chartId, token] of Object.entries(PLAY_COLLECTION_TOKEN)) {
    check(collections.includes(token), `chart ${chartId} maps to a valid collection token (got "${token}")`);
  }
  check(PLAY_COLLECTION_TOKEN.TOP_GROSSING === 'GROSSING', 'TOP_GROSSING maps to the library GROSSING token');
  check(!collections.includes('TOP_GROSSING'), 'guard premise: TOP_GROSSING is NOT a library token');

  // Games expansion must actually find the GAME_* constants it relies on.
  const games = expandPlayCategories('GAME', true);
  check(games.length > 5, `games expansion yields the GAME_* subcategories (got ${games.length})`);
  check(expandPlayCategories('FINANCE', false).length === 1, 'non-games vertical is not expanded');

  // devId decoding — the URL-form ids gplay reports are NOT what gplay.developer
  // accepts. Verified live: 'PayPal+Mobile' 404s, 'PayPal Mobile' returns 4 apps.
  check(decodePlayDevId('PayPal+Mobile') === 'PayPal Mobile', 'devId: + → space');
  check(
    decodePlayDevId('Capital+One+Services,+LLC') === 'Capital One Services, LLC',
    'devId: every + is decoded, punctuation preserved',
  );
  check(decodePlayDevId('5187430147431084320') === '5187430147431084320', 'devId: numeric id untouched');
  check(decodePlayDevId('Comun') === 'Comun', 'devId: single-word name untouched');
  check(decodePlayDevId('Caf%C3%A9+Apps') === 'Café Apps', 'devId: %-escapes decoded too');
  check(decodePlayDevId('100%+Free+Apps') === '100% Free Apps', 'devId: invalid %-escape falls back, + still fixed');

  // playDeveloper's page size must come from the config file, never from a
  // literal at the call site (spec CONSTRAINT 3). google-play-scraper treats
  // `num` as a HARD cap, so the old inline 120 silently truncated any 200-app
  // portfolio during the step-8 catalog expansion with no env override to raise
  // it. This assertion is the binding: without the config export, the import
  // above does not resolve and the whole suite fails.
  check(
    Number.isInteger(PLAY_DEV_CATALOG_NUM) && PLAY_DEV_CATALOG_NUM > 0,
    `developer-catalog page size is the config tunable (got ${PLAY_DEV_CATALOG_NUM})`,
  );

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('playSource.js') || process.argv[1].endsWith('playSource.ts'));
if (isMain) {
  const { passed, failed, failures } = runPlaySourceTests();
  console.log(`playSource tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
