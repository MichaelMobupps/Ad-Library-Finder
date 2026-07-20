/**
 * Google Ads Transparency Center scraper.
 *
 * The Transparency Center (adstransparency.google.com) has no public API and no
 * browseable feed — you type a query and Google's SearchService matches it
 * against advertiser NAMES and verified DOMAINS. This module talks to the same
 * internal RPC endpoints the website's own frontend calls (no browser, plain
 * fetch), driven by the multilingual keyword bank in googleAdsKeywords.ts.
 *
 * Endpoints (all under {BASE}/anji/_/rpc/, POST, body `f.req=<json>`):
 *   - SearchService/SearchSuggestions  → advertisers matching a keyword
 *   - SearchService/SearchCreatives    → an advertiser's creatives (+ paging)
 *   - LookupService/GetCreativeById    → one creative's full detail (destination)
 *
 * IMPORTANT — this is a reverse-engineered, unofficial surface:
 *   1. Responses are prefixed with the anti-JSON-hijacking guard `)]}'` which
 *      must be stripped before JSON.parse.
 *   2. The payloads are positional (numeric string keys: "1","2","12",…). Field
 *      numbers can drift, so every parser tries the documented key first and
 *      then falls back to a defensive recursive scan (advertiser ids look like
 *      AR\d+, creative ids like CR\d+, destinations are the first non-Google
 *      http(s) URL, unwrapping googleadservices `adurl=` click wrappers).
 *   3. Google fingerprints TLS/H2; a plain-fetch client CAN be soft-blocked
 *      (HTTP 403/429 or an HTML challenge). Every call degrades gracefully:
 *      a blocked/failed request returns empty + sets `blocked`, never throws
 *      the job. `region` is metadata, not a real filter (Google returns the
 *      same creative set regardless), so it is recorded, not sent, by default.
 *
 * Pure parsers are exported and covered by offline fixture tests
 * (runGoogleAdsScraperTests) so the shape logic is verified without a live call.
 */

import { log } from './logger.js';

const BASE = (process.env.GOOGLE_ADS_BASE || 'https://adstransparency.google.com').replace(/\/$/, '');
const AUTHUSER = process.env.GOOGLE_ADS_AUTHUSER ?? '0';
const SUGGEST_LIMIT = clampInt(process.env.GOOGLE_ADS_SUGGEST_LIMIT, 10, 1, 30);
const CREATIVES_LIMIT = clampInt(process.env.GOOGLE_ADS_CREATIVES_LIMIT, 5, 1, 40);
const FETCH_DELAY_MS = clampInt(process.env.GOOGLE_ADS_FETCH_DELAY_MS, 600, 0, 10_000);
const TIMEOUT_MS = clampInt(process.env.GOOGLE_ADS_TIMEOUT_MS, 20_000, 2_000, 60_000);
const CREATIVE_LOOKUPS_PER_ADV = clampInt(process.env.GOOGLE_ADS_CREATIVE_LOOKUPS_PER_ADV, 2, 0, 10);
const SEND_REGION = process.env.GOOGLE_ADS_SEND_REGION === '1';

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const FETCH_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-same-domain': '1',
  origin: BASE,
  referer: `${BASE}/`,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface GoogleAdsAdvertiser {
  advertiser_id: string;
  name: string;
  /** Verified/associated domain if one could be lifted from the suggestion. */
  domain: string | null;
  /** Advertiser location (ISO2) if present — an informational HQ hint. */
  region: string | null;
  /** Which keyword surfaced this advertiser. */
  matchedKeyword: string;
}

export interface GoogleAdsCreativeRef {
  advertiser_id: string;
  creative_id: string;
  format: 'text' | 'image' | 'video' | null;
}

export interface DiscoverResult {
  advertisers: GoogleAdsAdvertiser[];
  keywordsSearched: number;
  requestsMade: number;
  blocked: boolean;
  notes: string[];
}

export interface DestinationResult {
  landingUrl: string | null;
  format: 'text' | 'image' | 'video' | null;
  creativesSeen: number;
  note: string;
}

/** Shared, mutable cap on creative-detail lookups across a whole job. */
export interface LookupBudget {
  remaining(): number;
  tryConsume(): boolean;
}

export function makeLookupBudget(max: number): LookupBudget {
  let n = Math.max(0, Math.floor(max));
  return {
    remaining: () => n,
    tryConsume: () => (n > 0 ? (n--, true) : false),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ───────────────────────────────────────────────────────────────────────────

/** Strip the `)]}'` anti-JSON-hijacking prefix (and any leading junk) so the
 *  body can be JSON.parse'd. Returns the substring from the first `{` or `[`. */
export function stripAntiHijackPrefix(text: string): string {
  if (!text) return text;
  const objIdx = text.indexOf('{');
  const arrIdx = text.indexOf('[');
  let start = -1;
  if (objIdx === -1) start = arrIdx;
  else if (arrIdx === -1) start = objIdx;
  else start = Math.min(objIdx, arrIdx);
  return start > 0 ? text.slice(start) : text;
}

/** Parse an RPC response body. Returns null (never throws) on unparseable /
 *  challenge HTML so callers can degrade. */
export function parseRpcJson(text: string): unknown | null {
  const cleaned = stripAntiHijackPrefix(text);
  if (!cleaned || (cleaned[0] !== '{' && cleaned[0] !== '[')) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function looksLikeAdvertiserId(s: unknown): boolean {
  return typeof s === 'string' && /^AR\d{6,}$/i.test(s);
}

export function looksLikeCreativeId(s: unknown): boolean {
  return typeof s === 'string' && /^CR\d{6,}$/i.test(s);
}

const ISO2 = new Set([
  'US','GB','UK','CA','AU','NZ','IE','DE','FR','ES','IT','PT','NL','BE','CH','AT','SE','NO','DK','FI',
  'PL','CZ','SK','HU','RO','BG','GR','TR','RU','UA','RS','HR','SI','LT','LV','EE','IL','AE','SA','EG',
  'QA','KW','MA','ZA','NG','KE','GH','BR','MX','AR','CO','CL','PE','VE','JP','KR','CN','TW','HK','IN',
  'ID','MY','SG','TH','VN','PH','PK','BD','LK','JO','LB','IQ',
]);

export function isCountryCode(s: unknown): boolean {
  return typeof s === 'string' && s.length === 2 && ISO2.has(s.toUpperCase());
}

/** True if a bare string is a plausible registrable host (no spaces, has a dot
 *  and a 2-24 char alpha TLD). Rejects human names, sentences, and file paths. */
export function looksLikeDomain(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || /\s/.test(t) || t.includes('@')) return false;
  if (t.length > 253) return false;
  return /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/i.test(t);
}

const ASSET_HOST_RE =
  /(^|\.)(gstatic\.com|googleusercontent\.com|ggpht\.com|googlesyndication\.com|google\.com|googleapis\.com|youtube\.com|ytimg\.com|doubleclick\.net|google-analytics\.com|schema\.org|w3\.org)$/i;

/** Google click-wrappers expose the real destination in an `adurl`/`url`/`q`
 *  query param. Unwrap them; return the input unchanged if not a wrapper. */
export function unwrapGoogleClickUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isWrapper =
      host.endsWith('googleadservices.com') ||
      host.endsWith('doubleclick.net') ||
      host === 'www.google.com' ||
      host === 'google.com' ||
      u.pathname.includes('/aclk') ||
      u.pathname.includes('/pagead');
    if (!isWrapper) return url;
    for (const key of ['adurl', 'url', 'q', 'dest', 'ct_dest']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
    return url;
  } catch {
    return url;
  }
}

/** True for hosts/paths that are ad-serving assets (images, js, fonts), never
 *  a click destination. */
export function isAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (ASSET_HOST_RE.test(u.hostname)) return true;
    if (/\.(png|jpe?g|gif|webp|svg|mp4|webm|js|css|woff2?|ico)(\?|$)/i.test(u.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}

/** Recursively collect every string leaf in a parsed JSON value (depth-bounded). */
export function collectStrings(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 40 || out.length > 5000) return out;
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out, depth + 1);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) collectStrings(v, out, depth + 1);
  }
  return out;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Locate the primary result array in an RPC response: prefer top-level "1",
 *  else the first array-of-objects found by shallow scan. */
export function firstResultArray(json: unknown): unknown[] {
  const obj = asObj(json);
  if (obj && Array.isArray(obj['1'])) return obj['1'] as unknown[];
  if (Array.isArray(json)) return json as unknown[];
  // Shallow scan for the first array whose elements are objects.
  if (obj) {
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.some((e) => e && typeof e === 'object')) return v as unknown[];
    }
  }
  return [];
}

/**
 * Parse a SearchSuggestions response into advertisers. Documented shape:
 *   { "1": [ { "1": advertiserId, "12": name, … }, … ] }
 * Falls back to a recursive scan per item when the numeric keys have drifted.
 */
export function parseAdvertiserSuggestions(json: unknown, keyword: string): GoogleAdsAdvertiser[] {
  const arr = firstResultArray(json);
  const out: GoogleAdsAdvertiser[] = [];
  const seen = new Set<string>();

  for (const raw of arr) {
    const item = asObj(raw);
    if (!item) continue;

    // id: documented key "1", else deep scan for AR-id.
    let id = str(item['1']).trim();
    const strings = collectStrings(item);
    if (!looksLikeAdvertiserId(id)) {
      const found = strings.find(looksLikeAdvertiserId);
      if (found) id = found;
    }

    // name: documented key "12", else "2", else the longest human-ish string.
    let name = str(item['12']).trim() || str(item['2']).trim();
    if (!name) {
      name =
        strings
          .filter((s) => s !== id && !looksLikeAdvertiserId(s) && !looksLikeDomain(s) && s.length >= 2 && s.length <= 120)
          .sort((a, b) => b.length - a.length)[0] || '';
    }

    const domain = strings.map((s) => (looksLikeDomain(s) ? s.toLowerCase() : '')).find(Boolean) || null;
    // NOTE: we deliberately do NOT infer the advertiser region from a loose
    // deep-scan for a 2-letter ISO code — far too many non-region tokens
    // (language codes DE/IT/NO/IN, literals AR/CO) collide with country codes,
    // and this only feeds the informational `country` CSV column anyway (HQ
    // bucketing uses the RESOLVED HQ, not this field). Left null on purpose; the
    // pipeline falls back to the job's country. `isCountryCode` is retained as a
    // helper for any future, positionally-verified region field.
    const region = null;

    if (!id && !name) continue;
    const key = id || name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ advertiser_id: id, name, domain, region, matchedKeyword: keyword });
  }
  return out;
}

const FORMAT_MAP: Record<string, GoogleAdsCreativeRef['format']> = {
  '1': 'text',
  '2': 'image',
  '3': 'video',
};

/**
 * Parse a SearchCreatives response. Documented shape:
 *   { "1": [ { "1": advertiserId, "2": creativeId, "8": format }, … ], "2": nextToken }
 */
export function parseCreativesResponse(json: unknown): {
  creatives: GoogleAdsCreativeRef[];
  nextToken: string | null;
} {
  const arr = firstResultArray(json);
  const creatives: GoogleAdsCreativeRef[] = [];
  for (const raw of arr) {
    const item = asObj(raw);
    if (!item) continue;
    let creativeId = str(item['2']).trim();
    let advertiserId = str(item['1']).trim();
    if (!looksLikeCreativeId(creativeId)) {
      const found = collectStrings(item).find(looksLikeCreativeId);
      if (found) creativeId = found;
    }
    if (!looksLikeAdvertiserId(advertiserId)) {
      const found = collectStrings(item).find(looksLikeAdvertiserId);
      if (found) advertiserId = found;
    }
    if (!creativeId) continue;
    const fmtRaw = item['8'];
    const format = FORMAT_MAP[String(fmtRaw)] ?? null;
    creatives.push({ advertiser_id: advertiserId, creative_id: creativeId, format });
  }
  const obj = asObj(json);
  const nextToken = obj && typeof obj['2'] === 'string' && obj['2'] ? (obj['2'] as string) : null;
  return { creatives, nextToken };
}

/**
 * Pull the ad's click destination out of a GetCreativeById response: the first
 * non-Google, non-asset http(s) URL, with googleadservices/doubleclick click
 * wrappers unwrapped to their real `adurl`. Play/App-Store links win if present.
 */
export function extractDestinationUrl(json: unknown): string | null {
  const strings = collectStrings(json);
  const urls: string[] = [];
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    // Some fields embed the URL inside a longer string; pull explicit http(s).
    const m = s.match(/https?:\/\/[^\s"'<>\\]+/gi);
    if (m) urls.push(...m);
  }
  const cleaned = urls.map((u) => unwrapGoogleClickUrl(u)).filter((u) => /^https?:\/\//i.test(u));

  if (cleaned.length === 0) return null;

  // An app-store destination is an unambiguous mobile signal and always wins —
  // even though play.google.com shares the google.com suffix that the asset
  // filter otherwise rejects. The Play pattern MUST match the classifier's
  // PLAY_RE (`/store/apps/details`) so a non-listing Play link (developer /
  // collection page) does NOT win here and then get mislabeled cps_web
  // downstream — in that case the real website in the same creative should win.
  const isStore = (u: string) =>
    /play\.google\.com\/store\/apps\/details|apps\.apple\.com|itunes\.apple\.com/i.test(u);
  const store = cleaned.find(isStore);
  if (store) return store;

  // Otherwise drop ad-serving assets and Google-owned hosts, keep the first real host.
  const rest = cleaned.filter((u) => !isAssetUrl(u));
  const nonGoogle = rest.find((u) => {
    try {
      return !/(^|\.)google\.[a-z.]+$/i.test(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  return nonGoogle || rest[0] || null;
}

// ───────────────────────────────────────────────────────────────────────────
// Network layer
// ───────────────────────────────────────────────────────────────────────────

interface RpcOutcome {
  json: unknown | null;
  status: number;
  blocked: boolean;
  error: string | null;
}

async function rpcPost(
  method: string,
  payload: Record<string, unknown>,
  label: string,
  onLog?: LogFn,
): Promise<RpcOutcome> {
  const url = `${BASE}/anji/_/rpc/${method}?authuser=${encodeURIComponent(AUTHUSER)}`;
  const body = new URLSearchParams({ 'f.req': JSON.stringify(payload) }).toString();
  try {
    onLog?.('debug', `google-ads rpc ${label} → ${method}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: FETCH_HEADERS,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429 || res.status === 403) {
      onLog?.('warn', `google-ads: HTTP ${res.status} on ${label} — blocked/rate-limited (TLS fingerprint or geo)`);
      return { json: null, status: res.status, blocked: true, error: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      onLog?.('warn', `google-ads: HTTP ${res.status} on ${label}`);
      return { json: null, status: res.status, blocked: false, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const json = parseRpcJson(text);
    if (json === null) {
      // A 200 with unparseable body is almost always an HTML interstitial/challenge.
      onLog?.('warn', `google-ads: unparseable response on ${label} (challenge/HTML?) — treating as blocked`);
      return { json: null, status: res.status, blocked: true, error: 'unparseable body' };
    }
    return { json, status: res.status, blocked: false, error: null };
  } catch (err) {
    onLog?.('warn', `google-ads: request error on ${label}: ${(err as Error).message}`);
    return { json: null, status: 0, blocked: false, error: (err as Error).message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// High-level scrape operations
// ───────────────────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  region?: string | null; // informational; only sent when GOOGLE_ADS_SEND_REGION=1
  onLog?: LogFn;
  /** Called after each keyword so the pipeline can update job phase. */
  onProgress?: (done: number, total: number, foundSoFar: number) => void;
}

/**
 * Discover advertisers for a list of keywords via SearchSuggestions. Dedupes by
 * advertiser id across keywords (first keyword wins). Never throws — a blocked
 * or failing keyword is skipped and flagged.
 */
export async function discoverAdvertisers(
  keywords: string[],
  opts: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const onLog = opts.onLog;
  const out: DiscoverResult = {
    advertisers: [],
    keywordsSearched: 0,
    requestsMade: 0,
    blocked: false,
    notes: [],
  };
  const seen = new Set<string>();
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const payload: Record<string, unknown> = { '1': kw, '2': SUGGEST_LIMIT, '3': SUGGEST_LIMIT };
    const res = await rpcPost('SearchService/SearchSuggestions', payload, `suggest "${kw}"`, onLog);
    out.requestsMade++;
    out.keywordsSearched++;

    // A "failure" is any request that yielded no parseable result — a block
    // (403/429/challenge), a transport error (DNS/refused/timeout → status 0),
    // or a 5xx. All of these mean the endpoint is unreachable/hostile, so bail
    // early after a run of them rather than grinding through every keyword at
    // up to TIMEOUT_MS each. `out.blocked` is set only for real blocks so the
    // pipeline can tell "blocked" from "network down".
    if (!res.json) {
      consecutiveFailures++;
      if (res.blocked) out.blocked = true;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const kind = res.blocked ? 'blocks' : 'request failures';
        out.notes.push(
          `aborted after ${consecutiveFailures} consecutive ${kind} at keyword ${i + 1}/${keywords.length}`,
        );
        onLog?.('error', `google-ads: ${consecutiveFailures} consecutive ${kind} — aborting discovery early`);
        break;
      }
    } else {
      consecutiveFailures = 0;
    }

    const found = res.json ? parseAdvertiserSuggestions(res.json, kw) : [];
    let added = 0;
    for (const adv of found) {
      const key = adv.advertiser_id || adv.name.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.advertisers.push(adv);
      added++;
    }
    if (added > 0) onLog?.('debug', `google-ads: "${kw}" → +${added} advertisers (total ${out.advertisers.length})`);
    opts.onProgress?.(i + 1, keywords.length, out.advertisers.length);

    if (i < keywords.length - 1 && FETCH_DELAY_MS > 0) {
      await sleep(FETCH_DELAY_MS + Math.floor(FETCH_DELAY_MS * 0.5 * pseudoJitter(i)));
    }
  }

  return out;
}

// Deterministic pseudo-jitter in [0,1) that does not use Math.random (keeps the
// module import-safe under the workflow runtime and reproducible in tests).
function pseudoJitter(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export interface ResolveDestinationOptions {
  region?: string | null;
  lookupBudget?: LookupBudget;
  onLog?: LogFn;
}

/**
 * Resolve a single advertiser to a representative click destination.
 * Strategy (cheapest first):
 *   1. If creative lookups are enabled and budget remains, pull a page of the
 *      advertiser's creatives and read the destination of the first creative
 *      that yields one (this is the real click target — app store for mobile,
 *      website for web).
 *   2. Fall back to the advertiser's verified domain (→ https://domain).
 * Returns landingUrl=null when neither path yields anything.
 */
export async function resolveAdvertiserDestination(
  adv: GoogleAdsAdvertiser,
  opts: ResolveDestinationOptions = {},
): Promise<DestinationResult> {
  const onLog = opts.onLog;
  let creativesSeen = 0;
  let format: DestinationResult['format'] = null;

  // Only spend a SearchCreatives round-trip while the per-job creative-lookup
  // budget still has room — once it is exhausted every creative would be read
  // for free anyway, so fall straight through to the verified domain instead.
  if (adv.advertiser_id && CREATIVE_LOOKUPS_PER_ADV > 0 && opts.lookupBudget && opts.lookupBudget.remaining() > 0) {
    const creativesPayload: Record<string, unknown> = {
      '2': CREATIVES_LIMIT,
      '3': { '12': { '1': '', '2': true }, '13': { '1': [adv.advertiser_id] } },
      '7': { '1': 1 },
    };
    if (SEND_REGION && opts.region) {
      (creativesPayload['3'] as Record<string, unknown>)['8'] = opts.region;
    }
    const cres = await rpcPost(
      'SearchService/SearchCreatives',
      creativesPayload,
      `creatives ${adv.advertiser_id}`,
      onLog,
    );
    if (cres.json) {
      const { creatives } = parseCreativesResponse(cres.json);
      creativesSeen = creatives.length;
      let lookups = 0;
      for (const c of creatives) {
        if (lookups >= CREATIVE_LOOKUPS_PER_ADV) break;
        if (!opts.lookupBudget.tryConsume()) break;
        lookups++;
        const detailPayload: Record<string, unknown> = {
          '1': adv.advertiser_id,
          '2': c.creative_id,
          '5': { '1': 1 },
        };
        const dres = await rpcPost(
          'LookupService/GetCreativeById',
          detailPayload,
          `creative ${c.creative_id}`,
          onLog,
        );
        if (FETCH_DELAY_MS > 0) await sleep(FETCH_DELAY_MS);
        if (!dres.json) continue;
        const dest = extractDestinationUrl(dres.json);
        if (dest) {
          format = c.format;
          return { landingUrl: dest, format, creativesSeen, note: `creative:${c.format || 'unknown'}` };
        }
      }
    }
  }

  // Fallback: the verified advertiser domain.
  if (adv.domain && looksLikeDomain(adv.domain)) {
    return { landingUrl: `https://${adv.domain}`, format, creativesSeen, note: 'advertiser-domain' };
  }

  return { landingUrl: null, format, creativesSeen, note: 'no-destination' };
}

// ───────────────────────────────────────────────────────────────────────────
// Offline unit tests (no network). Run via `node dist/googleAdsScraper.js`.
// ───────────────────────────────────────────────────────────────────────────

export function runGoogleAdsScraperTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // stripAntiHijackPrefix / parseRpcJson
  check(stripAntiHijackPrefix(`)]}'\n{"1":[]}`) === '{"1":[]}', 'strips )]}\' prefix');
  check(stripAntiHijackPrefix('{"a":1}') === '{"a":1}', 'no prefix passthrough');
  check(parseRpcJson(`)]}'\n{"x":1}`) !== null, 'parseRpcJson handles prefixed body');
  check(parseRpcJson('<html>challenge</html>') === null, 'parseRpcJson rejects HTML challenge');
  check(parseRpcJson('') === null, 'parseRpcJson handles empty');

  // id / domain / country detectors
  check(looksLikeAdvertiserId('AR12345678901234567890'), 'AR-id detected');
  check(!looksLikeAdvertiserId('nike'), 'non-AR rejected as id');
  check(looksLikeCreativeId('CR98765432109876543210'), 'CR-id detected');
  check(looksLikeDomain('nike.com'), 'domain: nike.com');
  check(looksLikeDomain('sub.example.co.uk'), 'domain: multi-label');
  check(!looksLikeDomain('Nike, Inc.'), 'domain: reject human name');
  check(!looksLikeDomain('hello world'), 'domain: reject spaces');
  check(!looksLikeDomain('a@b.com'), 'domain: reject email');
  check(isCountryCode('US') && isCountryCode('br'), 'ISO2 detected (case-insensitive)');
  check(!isCountryCode('ZZ') && !isCountryCode('USA'), 'non-ISO2 / 3-letter rejected');

  // unwrapGoogleClickUrl
  check(
    unwrapGoogleClickUrl(
      'https://www.googleadservices.com/pagead/aclk?sa=L&ai=x&adurl=https%3A%2F%2Fwww.nike.com%2Fsale%3Fx%3D1',
    ) === 'https://www.nike.com/sale?x=1',
    'unwrap googleadservices adurl',
  );
  check(unwrapGoogleClickUrl('https://real.com/x') === 'https://real.com/x', 'non-wrapper passthrough');

  // isAssetUrl
  check(isAssetUrl('https://tpc.googlesyndication.com/x.png'), 'asset host blocked');
  check(isAssetUrl('https://cdn.example.com/a/b/c.jpg'), 'image path blocked');
  check(!isAssetUrl('https://www.nike.com/sale'), 'real destination not an asset');

  // parseAdvertiserSuggestions — documented shape + deep-scan fallbacks
  const suggestBody = `)]}'
{"1":[
  {"1":"AR01111111111111111111","12":"Nike, Inc.","5":{"2":"nike.com"},"9":"US"},
  {"1":"AR02222222222222222222","12":"Adidas AG"},
  {"12":"MysteryCo","7":{"3":"AR03333333333333333333"}}
]}`;
  const advs = parseAdvertiserSuggestions(parseRpcJson(suggestBody), 'shoes');
  check(advs.length === 3, `parses 3 advertisers (got ${advs.length})`);
  check(advs[0].advertiser_id === 'AR01111111111111111111', 'advertiser id from key "1"');
  check(advs[0].name === 'Nike, Inc.', 'advertiser name from key "12"');
  check(advs[0].domain === 'nike.com', 'domain lifted from nested field');
  check(advs[0].region === null, 'region left null (no loose ISO2 inference)');
  check(advs[0].matchedKeyword === 'shoes', 'matchedKeyword tagged');
  check(advs[2].advertiser_id === 'AR03333333333333333333', 'id recovered via deep scan when key "1" absent');

  // parseCreativesResponse
  const creativesBody = `)]}'
{"1":[
  {"1":"AR01111111111111111111","2":"CR11111111111111111111","8":2},
  {"1":"AR01111111111111111111","2":"CR22222222222222222222","8":3}
],"2":"NEXT_PAGE_TOKEN_ABC"}`;
  const parsedCreatives = parseCreativesResponse(parseRpcJson(creativesBody));
  check(parsedCreatives.creatives.length === 2, 'parses 2 creatives');
  check(parsedCreatives.creatives[0].creative_id === 'CR11111111111111111111', 'creative id from key "2"');
  check(parsedCreatives.creatives[0].format === 'image', 'format 2 → image');
  check(parsedCreatives.creatives[1].format === 'video', 'format 3 → video');
  check(parsedCreatives.nextToken === 'NEXT_PAGE_TOKEN_ABC', 'next page token from key "2"');

  // extractDestinationUrl — store link wins, wrapper unwrapped, assets skipped
  const detailWeb = `)]}'
{"1":"AR0","2":"CR0","5":{"a":"https://tpc.googlesyndication.com/simgad/123.png","b":"https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fshop.example.com%2Fpromo"}}`;
  check(extractDestinationUrl(parseRpcJson(detailWeb)) === 'https://shop.example.com/promo', 'destination: unwrap + skip asset');
  const detailStore = `)]}'
{"5":{"a":"https://tpc.googlesyndication.com/x.jpg","b":"https://play.google.com/store/apps/details?id=com.foo.bar&hl=en"}}`;
  check(
    extractDestinationUrl(parseRpcJson(detailStore)) === 'https://play.google.com/store/apps/details?id=com.foo.bar&hl=en',
    'destination: play store link preferred',
  );
  const detailNone = `)]}'\n{"5":{"a":"https://www.gstatic.com/x.png"}}`;
  check(extractDestinationUrl(parseRpcJson(detailNone)) === null, 'destination: null when only assets');

  // firstResultArray fallback
  check(firstResultArray({ '7': [{ a: 1 }] }).length === 1, 'firstResultArray finds array under drifted key');

  // makeLookupBudget
  const b = makeLookupBudget(2);
  check(b.tryConsume() && b.tryConsume() && !b.tryConsume(), 'lookup budget consumes exactly max');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('googleAdsScraper.js') || process.argv[1].endsWith('googleAdsScraper.ts'));
if (isMain) {
  const { passed, failed, failures } = runGoogleAdsScraperTests();
  console.log(`googleAdsScraper tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
