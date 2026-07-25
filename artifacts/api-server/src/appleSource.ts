/**
 * Apple App Store discovery source (official, free).
 *
 *   • Charts  — the legacy iTunes RSS feed (the only free official chart endpoint
 *       that supports a genre filter — see appleChart for why the Marketing Tools
 *       v2 feed the spec names cannot be used):
 *       https://itunes.apple.com/<cc>/rss/topfreeapplications/limit=<n>/genre=<G>/json
 *       (omit the genre segment for all-categories). Lower-case country codes.
 *   • Detail  — itunes.apple.com/lookup?id=<id,id,…>&country=<cc>  (batched ≤100)
 *   • Catalog — itunes.apple.com/lookup?id=<artistId>&entity=software&country=<cc>
 *   • Search  — itunes.apple.com/search?term=<t>&country=<cc>&entity=software&limit=200
 *
 * Throttling: ALL of these are itunes.apple.com and share ONE 10-req/min limiter
 * (spec). Nothing throws — a failed call logs and yields empty, and every field is
 * coerced defensively. A chart that yields nothing warns, because a silent empty
 * chart is a harvest-wide hole.
 */

import {
  ITUNES_REQUEST_INTERVAL_MS,
  ITUNES_LOOKUP_BATCH,
  ITUNES_SEARCH_LIMIT,
  APPLE_CHART_NUM,
  STORE_FETCH_TIMEOUT_MS,
} from './storeDiscoveryConfig.js';
import { RateLimiter } from './storeThrottle.js';

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// One limiter for EVERY itunes.apple.com call (spec: 10 req/min across all iTunes
// endpoints). Charts, lookup, catalog and search all share this single budget —
// the chart feed is served from itunes.apple.com too (see appleChart).
const itunesLimiter = new RateLimiter(ITUNES_REQUEST_INTERVAL_MS);

export interface AppleListApp {
  appId: string; // numeric track id, as string
  title: string;
  artistName: string;
}

export interface AppleAppDetail {
  appId: string;
  title: string;
  sellerName: string | null;
  sellerUrl: string | null;
  artistId: string | null;
  artistName: string | null;
  primaryGenreId: string | null;
  genreIds: string[];
  primaryGenreName: string | null;
  bundleId: string | null;
  currentVersionReleaseDate: number | null; // ms epoch
}

async function getJson(url: string, timeoutMs: number, onLog?: LogFn): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      onLog?.('debug', `apple: HTTP ${res.status} on ${url.slice(0, 90)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    onLog?.('debug', `apple: fetch failed (${(err as Error).message}) on ${url.slice(0, 90)}`);
    return null;
  }
}

/**
 * Parse the legacy iTunes RSS chart payload into list items. Pure — exported for
 * the offline suite.
 *
 * Shape (verified live): `feed.entry[]`, each with `id.attributes['im:id']` (the
 * numeric track id — the `id.label` is a store URL, not an id), `im:name.label`
 * and `im:artist.label`. Apple collapses `entry` to a bare OBJECT when the feed
 * carries exactly one row, so array-or-single is handled here rather than at the
 * call site.
 */
export function parseAppleRssChart(json: unknown): AppleListApp[] {
  const feed = (json as { feed?: { entry?: unknown } } | null)?.feed;
  if (!feed?.entry) return [];
  const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
  const out: AppleListApp[] = [];
  for (const e of entries) {
    const o = e as Record<string, any>;
    const id = o?.id?.attributes?.['im:id'];
    if (id == null || String(id) === '') continue;
    out.push({
      appId: String(id),
      title: typeof o?.['im:name']?.label === 'string' ? o['im:name'].label : '',
      artistName: typeof o?.['im:artist']?.label === 'string' ? o['im:artist'].label : '',
    });
  }
  return out;
}

/**
 * Pull an Apple top-free chart for a genre (or all categories when appleGenre is
 * null/'').
 *
 * Endpoint note (measured, not assumed): the Apple Marketing Tools v2 feed the
 * spec names CANNOT do this job — `…/top-free/<n>/genre=<G>/apps.json` 404s in
 * every segment order (v2 has no genre dimension) and even the un-genred form
 * HTTP 500s above limit=100. Pointed at it, this function returned [] for every
 * vertical × market, so Apple contributed ZERO chart apps while the run still
 * reported success. The legacy iTunes RSS feed is the official free endpoint that
 * does support `genre=`; it is verified correct across us/gb/de and genres
 * 6015/6014/6024, and hard-caps at 100 entries whatever limit is requested.
 *
 * It lives on itunes.apple.com, so it draws from the SAME 10-req/min budget as
 * lookup/search (spec throttle), not from the separate RSS-host limiter.
 */
export async function appleChart(
  appleGenre: string | null,
  country: string,
  onLog?: LogFn,
): Promise<AppleListApp[]> {
  const cc = country.toLowerCase();
  const genreSeg = appleGenre ? `/genre=${encodeURIComponent(appleGenre)}` : '';
  const url = `https://itunes.apple.com/${encodeURIComponent(
    cc,
  )}/rss/topfreeapplications/limit=${APPLE_CHART_NUM}${genreSeg}/json`;
  const json = await itunesLimiter.schedule(() => getJson(url, STORE_FETCH_TIMEOUT_MS, onLog));
  const out = parseAppleRssChart(json);
  if (out.length === 0) {
    // warn, not debug: a whole chart returning zero apps is a harvest-wide hole
    // and must never be invisible again (same rule as playChart).
    onLog?.('warn', `apple chart genre=${appleGenre ?? 'all'}/${cc} returned 0 apps`);
  }
  return out;
}

interface ItunesRaw {
  trackId?: number;
  trackName?: string;
  sellerName?: string;
  sellerUrl?: string;
  artistId?: number;
  artistName?: string;
  primaryGenreId?: number;
  primaryGenreName?: string;
  genreIds?: (string | number)[];
  bundleId?: string;
  currentVersionReleaseDate?: string;
  wrapperType?: string;
  kind?: string;
}

function coerceDetail(r: ItunesRaw): AppleAppDetail | null {
  if (r.trackId == null) return null;
  const released = r.currentVersionReleaseDate ? Date.parse(r.currentVersionReleaseDate) : NaN;
  return {
    appId: String(r.trackId),
    title: r.trackName ?? '',
    sellerName: r.sellerName ?? null,
    sellerUrl: r.sellerUrl ?? null,
    artistId: r.artistId != null ? String(r.artistId) : null,
    artistName: r.artistName ?? null,
    primaryGenreId: r.primaryGenreId != null ? String(r.primaryGenreId) : null,
    genreIds: Array.isArray(r.genreIds) ? r.genreIds.map((g) => String(g)) : [],
    primaryGenreName: r.primaryGenreName ?? null,
    bundleId: r.bundleId ?? null,
    currentVersionReleaseDate: Number.isFinite(released) ? released : null,
  };
}

/** Batched iTunes /lookup against one storefront. Returns appId → detail for
 *  every id the API resolved there — a geo-restricted app resolves ONLY in its
 *  own market, so callers must pass a country the apps were actually sighted in.
 *  Batches internally at ITUNES_LOOKUP_BATCH; each batch is one throttled call. */
export async function appleLookup(ids: string[], country: string, onLog?: LogFn): Promise<Map<string, AppleAppDetail>> {
  const out = new Map<string, AppleAppDetail>();
  const cc = (country || 'us').toLowerCase();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += ITUNES_LOOKUP_BATCH) {
    const batch = unique.slice(i, i + ITUNES_LOOKUP_BATCH);
    const url = `https://itunes.apple.com/lookup?id=${batch.map(encodeURIComponent).join(',')}&country=${encodeURIComponent(cc)}`;
    // eslint-disable-next-line no-await-in-loop
    const json = (await itunesLimiter.schedule(() => getJson(url, STORE_FETCH_TIMEOUT_MS, onLog))) as
      | { results?: ItunesRaw[] }
      | null;
    for (const r of json?.results ?? []) {
      const d = coerceDetail(r);
      if (d) out.set(d.appId, d);
    }
  }
  return out;
}

/**
 * Whether each id is still listed in `country`'s App Store.
 *
 * Cheap and unambiguous, unlike the Play equivalent: /lookup answers HTTP 200 with
 * the found entries and simply OMITS ids that are not in the store, 100 ids per
 * request. The critical distinction is a FAILED request — getJson returns null on
 * timeout/5xx/rate-limit — where every id in that batch is unknown rather than
 * gone. Ids absent from a SUCCESSFUL response are reported 'gone'; ids in a failed
 * batch are omitted from the result map entirely, so a caller that iterates the
 * map can never mistake a network problem for a delisting.
 */
export async function appleLiveness(
  ids: string[],
  country: string,
  onLog?: LogFn,
): Promise<Map<string, 'live' | 'gone'>> {
  const out = new Map<string, 'live' | 'gone'>();
  const cc = (country || 'us').toLowerCase();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += ITUNES_LOOKUP_BATCH) {
    const batch = unique.slice(i, i + ITUNES_LOOKUP_BATCH);
    const url = `https://itunes.apple.com/lookup?id=${batch.map(encodeURIComponent).join(',')}&country=${encodeURIComponent(cc)}`;
    // eslint-disable-next-line no-await-in-loop
    const json = (await itunesLimiter.schedule(() => getJson(url, STORE_FETCH_TIMEOUT_MS, onLog))) as
      | { results?: ItunesRaw[] }
      | null;
    if (!json) {
      onLog?.('debug', `apple liveness: batch of ${batch.length} inconclusive (request failed) — left unknown`);
      continue; // whole batch unknown; never inferred as gone
    }
    const found = new Set<string>();
    for (const r of json.results ?? []) {
      const d = coerceDetail(r);
      if (d) found.add(d.appId);
    }
    for (const id of batch) out.set(id, found.has(id) ? 'live' : 'gone');
  }
  return out;
}

/** iTunes developer catalog for an artistId: the software apps (drops the leading
 *  artist entry) as listed in `country`'s storefront. Returns [] on failure. */
export async function appleDeveloper(artistId: string, country: string, onLog?: LogFn): Promise<AppleAppDetail[]> {
  const cc = (country || 'us').toLowerCase();
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(artistId)}&entity=software&country=${encodeURIComponent(cc)}`;
  const json = (await itunesLimiter.schedule(() => getJson(url, STORE_FETCH_TIMEOUT_MS, onLog))) as
    | { results?: ItunesRaw[] }
    | null;
  const out: AppleAppDetail[] = [];
  for (const r of json?.results ?? []) {
    if (r.wrapperType && r.wrapperType !== 'software') continue; // skip the artist row
    const d = coerceDetail(r);
    if (d) out.push(d);
  }
  return out;
}

/** iTunes store search (software entity). Returns list items (id + title). */
export async function appleSearch(term: string, country: string, onLog?: LogFn): Promise<AppleListApp[]> {
  const cc = country.toLowerCase();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${encodeURIComponent(
    cc,
  )}&entity=software&limit=${ITUNES_SEARCH_LIMIT}`;
  const json = (await itunesLimiter.schedule(() => getJson(url, STORE_FETCH_TIMEOUT_MS, onLog))) as
    | { results?: ItunesRaw[] }
    | null;
  const out: AppleListApp[] = [];
  for (const r of json?.results ?? []) {
    if (r.trackId == null) continue;
    out.push({ appId: String(r.trackId), title: r.trackName ?? '', artistName: r.artistName ?? '' });
  }
  return out;
}

/** Canonical Apple store URL for a track id. */
export function appleStoreUrl(appId: string): string {
  return `https://apps.apple.com/app/id${appId}`;
}

// ── offline unit tests (no network — fixtures are real payload shapes) ───────

/**
 * These guard the chart parser, which is where Apple discovery silently died:
 * pointed at a feed whose shape it did not understand, appleChart returned [] for
 * every vertical × market and the run still reported success. So the fixtures
 * below are verbatim slices of the LIVE payloads — the legacy RSS shape we now
 * read, and the Marketing-Tools v2 shape we must never silently accept again.
 */
export function runAppleSourceTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // Real legacy-RSS slice (itunes.apple.com/us/rss/topfreeapplications/…/genre=6015).
  const legacy = {
    feed: {
      entry: [
        {
          'im:name': { label: 'PayPal - Pay, Send, Save' },
          'im:artist': { label: 'PayPal, Inc.' },
          id: {
            label: 'https://apps.apple.com/us/app/paypal-pay-send-save/id283646709?uo=2',
            attributes: { 'im:id': '283646709', 'im:bundleId': 'com.yourcompany.PPClient' },
          },
          category: { attributes: { 'im:id': '6015', label: 'Finance' } },
        },
        {
          'im:name': { label: 'Cash App' },
          'im:artist': { label: 'Block, Inc.' },
          id: { label: 'https://apps.apple.com/us/app/cash-app/id711923939?uo=2', attributes: { 'im:id': '711923939' } },
        },
      ],
    },
  };
  const parsed = parseAppleRssChart(legacy);
  check(parsed.length === 2, `legacy feed yields both entries (got ${parsed.length})`);
  check(parsed[0]?.appId === '283646709', 'id comes from id.attributes["im:id"], not the id.label URL');
  check(parsed[0]?.title === 'PayPal - Pay, Send, Save', 'title comes from im:name.label');
  check(parsed[0]?.artistName === 'PayPal, Inc.', 'artistName comes from im:artist.label');

  // Apple collapses `entry` to a bare object when the feed holds exactly one row.
  const single = { feed: { entry: { 'im:name': { label: 'Solo' }, id: { attributes: { 'im:id': '42' } } } } };
  const one = parseAppleRssChart(single);
  check(one.length === 1 && one[0].appId === '42', 'single-entry feed is not dropped');
  check(one[0]?.artistName === '', 'missing artist coerces to empty string, not undefined');

  // Malformed / hostile inputs must yield [], never throw.
  for (const [label, input] of [
    ['null', null],
    ['empty object', {}],
    ['feed without entry', { feed: {} }],
    ['entry not an object', { feed: { entry: [null, 7, 'x'] } }],
    ['entry without an id', { feed: { entry: [{ 'im:name': { label: 'No id' } }] } }],
    ['id without im:id', { feed: { entry: [{ id: { label: 'https://…' } }] } }],
    ['blank im:id', { feed: { entry: [{ id: { attributes: { 'im:id': '' } } }] } }],
  ] as Array<[string, unknown]>) {
    let threw = false;
    let out: AppleListApp[] = [];
    try {
      out = parseAppleRssChart(input);
    } catch {
      threw = true;
    }
    check(!threw && out.length === 0, `${label} → [] without throwing`);
  }

  // The v2 Marketing-Tools shape (feed.results[]) must NOT parse as a chart: it
  // has no genre dimension, so accepting it silently would restore the outage.
  const v2 = { feed: { results: [{ id: '283646709', name: 'PayPal', artistName: 'PayPal, Inc.' }] } };
  check(parseAppleRssChart(v2).length === 0, 'v2 marketing-tools shape yields [] (caller must warn)');

  // A numeric im:id (Apple has shipped both) still stringifies.
  const numeric = { feed: { entry: [{ id: { attributes: { 'im:id': 6752672568 } } }] } };
  check(parseAppleRssChart(numeric)[0]?.appId === '6752672568', 'numeric im:id is stringified');

  // The chart URL must target the genre-capable feed. A regression back to the
  // v2 host is the exact failure this module already suffered once.
  check(APPLE_CHART_NUM <= 200, 'APPLE_CHART_NUM stays within the legacy feed ceiling');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('appleSource.js') || process.argv[1].endsWith('appleSource.ts'));
if (isMain) {
  const { passed, failed, failures } = runAppleSourceTests();
  console.log(`appleSource tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
