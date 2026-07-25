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
  PLAY_CHART_NUM,
  PLAY_SEARCH_NUM,
  PLAY_DEV_CATALOG_NUM,
  type PlayChart,
} from './storeDiscoveryConfig.js';
import { RateLimiter } from './storeThrottle.js';

// The library is CJS with a loose default-export type; cast once, isolate here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gplay: any = gplayDefault as unknown;

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

const limiter = new RateLimiter(PLAY_REQUEST_INTERVAL_MS);

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
      onLog?.('debug', `play app ${appId}/${country} failed: ${(err as Error).message}`);
      return null;
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
