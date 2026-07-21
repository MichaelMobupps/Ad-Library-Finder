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

import { ProxyAgent, type Dispatcher } from 'undici';
import { log } from './logger.js';

const BASE = (process.env.GOOGLE_ADS_BASE || 'https://adstransparency.google.com').replace(/\/$/, '');
const AUTHUSER = process.env.GOOGLE_ADS_AUTHUSER ?? '0';
const SUGGEST_LIMIT = clampInt(process.env.GOOGLE_ADS_SUGGEST_LIMIT, 10, 1, 30);
const CREATIVES_LIMIT = clampInt(process.env.GOOGLE_ADS_CREATIVES_LIMIT, 5, 1, 40);
// Base delay between requests. Google flags fast bursts from one IP, so this is
// deliberately generous and is throttled UP adaptively after any 429/403.
const FETCH_DELAY_MS = clampInt(process.env.GOOGLE_ADS_FETCH_DELAY_MS, 1_500, 0, 30_000);
const TIMEOUT_MS = clampInt(process.env.GOOGLE_ADS_TIMEOUT_MS, 20_000, 2_000, 60_000);
const CREATIVE_LOOKUPS_PER_ADV = clampInt(process.env.GOOGLE_ADS_CREATIVE_LOOKUPS_PER_ADV, 2, 0, 10);
const SEND_REGION = process.env.GOOGLE_ADS_SEND_REGION === '1';
// On a soft block (429/403/challenge) we retry a few times with exponential
// backoff before giving up on that request. A transient rate-limit window
// usually clears within one or two backoffs; a hard IP block will exhaust them
// and the caller degrades as before.
const MAX_RETRIES = clampInt(process.env.GOOGLE_ADS_MAX_RETRIES, 3, 0, 8);
const BACKOFF_BASE_MS = clampInt(process.env.GOOGLE_ADS_BACKOFF_BASE_MS, 4_000, 250, 60_000);
const BACKOFF_MAX_MS = clampInt(process.env.GOOGLE_ADS_BACKOFF_MAX_MS, 30_000, 1_000, 120_000);
// Warm a cookie session (GET the homepage once) so RPC calls carry Google's
// consent/NID cookies like a real visit — raises the flagging threshold.
// Read at call time (not import) so tests can toggle it.
const warmupEnabled = () => process.env.GOOGLE_ADS_WARMUP !== '0';

// ── Outbound proxy (residential / mobile egress) ──────────────────────────────
// From a datacenter IP Google hard-blocks the Transparency Center (429 on every
// request, warm-up GET included). The only real remedy is to egress from a
// less-flagged IP. GOOGLE_ADS_PROXY_URL routes JUST this scraper's requests
// through an http(s):// proxy (with optional user:pass@) — the rest of
// the server (OAuth, googleapis, Anthropic) keeps its normal direct egress.
// For rotating residential pools, point this at the provider's gateway endpoint
// (it rotates the exit IP per connection / sticky-session TTL on its side).
const PROXY_URL = (process.env.GOOGLE_ADS_PROXY_URL || '').trim();

/**
 * A single process-lifetime undici dispatcher bound to the proxy, or undefined
 * when no proxy is configured (→ normal direct fetch). Built lazily on first use
 * so a malformed URL degrades to a warning + direct egress instead of crashing
 * the module at import time.
 */
let proxyDispatcher: Dispatcher | null | undefined; // undefined = not yet built
function getProxyDispatcher(onLog?: LogFn): Dispatcher | undefined {
  if (!PROXY_URL) return undefined;
  if (proxyDispatcher !== undefined) return proxyDispatcher ?? undefined;
  try {
    // Per-request AbortSignal.timeout(TIMEOUT_MS) bounds the whole fetch (incl.
    // proxy connect), so no separate proxy timeout is needed here.
    proxyDispatcher = new ProxyAgent({ uri: PROXY_URL });
    onLog?.('info', `google-ads: routing via proxy ${redactProxy(PROXY_URL)}`);
  } catch (err) {
    proxyDispatcher = null; // don't retry a bad URL every request
    onLog?.('warn', `google-ads: GOOGLE_ADS_PROXY_URL is invalid (${(err as Error).message}) — using direct egress`);
  }
  return proxyDispatcher ?? undefined;
}

/**
 * Throw when GOOGLE_ADS_PROXY_URL is SET but unusable — an unfilled template
 * placeholder (HOST/PORT/USER/PASS) or a string that doesn't parse as a URL.
 * Without this gate the scraper silently falls back to direct egress from the
 * datacenter IP, Google penalty-boxes it, and the job "completes" with 0 ads —
 * a config error masquerading as an empty market (observed in production).
 * Unset stays valid (deliberate direct egress). Placeholder tokens are checked
 * as whole uppercase words, so real hostnames/credentials can't false-positive;
 * this also catches the .env.example form USER:PASS@…, which parses fine but
 * would send literal placeholder credentials. Message < 200 chars so the
 * dashboard phase_detail slice shows it whole.
 */
export function assertProxyUrlUsable(): void {
  if (!PROXY_URL) return; // unset = deliberate direct egress
  const placeholder = /\b(HOST|PORT|USER|PASS|PASSWORD)\b/.test(PROXY_URL);
  let parses = true;
  try {
    new URL(PROXY_URL);
  } catch {
    parses = false;
  }
  if (placeholder || !parses) {
    throw new Error(
      `GOOGLE_ADS_PROXY_URL is set but unusable (${placeholder ? 'unfilled placeholder tokens' : 'not a valid URL'}) — ` +
        `fix the host:port in Secrets, or unset it to egress direct.`,
    );
  }
}

/** Hide credentials in a proxy URL before logging it. */
function redactProxy(u: string): string {
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return u.replace(/\/\/[^@/]+@/, '//***@');
  }
}

/**
 * Attach the proxy dispatcher to a fetch init when one is configured. The DOM
 * `RequestInit` type has no `dispatcher` field (it's a Node/undici extension),
 * so the assignment is cast locally — this is the one supported way to proxy the
 * global fetch on Node 20.
 */
function withProxy(init: RequestInit, onLog?: LogFn): RequestInit {
  const d = getProxyDispatcher(onLog);
  if (d) (init as { dispatcher?: Dispatcher }).dispatcher = d;
  return init;
}

/** True when an outbound proxy is configured for the scraper. */
export function isProxyConfigured(): boolean {
  return !!PROXY_URL;
}

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
// Session state: a lightweight cookie jar + adaptive throttle. Both are module
// scoped and shared across a job's requests so the client behaves like one
// continuous visit (better reputation) and slows itself down once Google starts
// pushing back.
// ───────────────────────────────────────────────────────────────────────────

const cookieJar = new Map<string, string>();
let warmedUp = false;
/** Multiplied into the inter-request delay; ratchets up after each block. */
let throttleFactor = 1;

function cookieHeader(): string {
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Merge a response's Set-Cookie(s) into the jar (name=value only). */
function absorbSetCookie(res: Response): void {
  try {
    const getter = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const cookies = typeof getter === 'function' ? getter.call(res.headers) : [];
    for (const c of cookies) {
      const first = c.split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) cookieJar.set(name, value);
    }
  } catch {
    /* headers.getSetCookie unsupported — cookies are a nice-to-have, skip */
  }
}

function baseHeaders(withCookie: boolean): Record<string, string> {
  const h: Record<string, string> = { ...FETCH_HEADERS };
  if (withCookie) {
    const ck = cookieHeader();
    if (ck) h['cookie'] = ck;
  }
  return h;
}

/**
 * GET the Transparency Center homepage once to collect consent/NID cookies so
 * subsequent RPC calls look like they came from a real page visit. Best-effort:
 * any failure just means we proceed cookieless (still works from a fresh IP).
 * Returns { blocked: true } when the homepage itself answered 429/403 — the
 * strongest possible signal that this egress IP is in Google's penalty box
 * (discovery uses it to probe once and abort instead of grinding retries).
 */
export async function warmUpSession(onLog?: LogFn): Promise<{ blocked: boolean }> {
  if (warmedUp || !warmupEnabled()) {
    warmedUp = true;
    return { blocked: false };
  }
  warmedUp = true;
  try {
    const res = await fetch(`${BASE}/?region=anywhere`, withProxy({
      method: 'GET',
      headers: {
        'user-agent': FETCH_HEADERS['user-agent'],
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': FETCH_HEADERS['accept-language'],
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, onLog));
    absorbSetCookie(res);
    // Drain body so the socket is released promptly.
    await res.text().catch(() => '');
    onLog?.('debug', `google-ads: warm-up GET → ${res.status}, ${cookieJar.size} cookie(s)`);
    return { blocked: res.status === 429 || res.status === 403 };
  } catch (err) {
    onLog?.('debug', `google-ads: warm-up skipped (${(err as Error).message})`);
    return { blocked: false };
  }
}

/** Reset session state — used by tests and any caller that wants a clean slate.
 *  Deliberately does NOT clear the hard-block cooldown latch: that models the
 *  EGRESS IP's standing with Google, which survives job boundaries. */
export function resetGoogleAdsSession(): void {
  cookieJar.clear();
  warmedUp = false;
  throttleFactor = 1;
}

// ── Hard-block cooldown latch ────────────────────────────────────────────────
// Once this host/proxy IP is proven hard-blocked (warm-up + probe both 429, or
// N consecutive hard-blocked keywords), further google_ads scraping within the
// cooldown window is pointless AND harmful: every request renews Google's
// penalty. The latch makes subsequent jobs abort INSTANTLY (zero requests)
// until the window passes. Process-local by design (a redeploy resets it).
let lastHardBlockAt = 0;

/** Milliseconds of cooldown remaining, 0 when clear. Env read at call time so
 *  tests can flip GOOGLE_ADS_COOLDOWN_MS; default 15 min, 0 disables. */
export function googleAdsCooldownRemainingMs(): number {
  const windowMs = clampInt(process.env.GOOGLE_ADS_COOLDOWN_MS, 900_000, 0, 86_400_000);
  if (windowMs <= 0 || lastHardBlockAt === 0) return 0;
  const left = lastHardBlockAt + windowMs - Date.now();
  return left > 0 ? left : 0;
}

function noteHardBlock(): void {
  lastHardBlockAt = Date.now();
}

/**
 * Disambiguate "Google penalty box" from "the proxy itself is throttling" after
 * a confirmed hard block: fire ONE GET through the same proxy at a neutral
 * NON-Google URL. It never touches Google, so it cannot renew the penalty.
 *  - neutral URL → 2xx/3xx  ⇒ proxy egress healthy ⇒ the 429s are GOOGLE's
 *    penalty on this exit IP (wait it out / rotate the exit IP);
 *  - neutral URL → 429      ⇒ the PROXY PROVIDER is rate-limiting the account
 *    (quota/bandwidth) — the "Google" 429s may never have reached Google;
 *  - request fails           ⇒ proxy became unreachable mid-job.
 * No-op without a proxy (a direct-egress 429 can only be Google). Best-effort:
 * never throws.
 */
async function probeEgressHealth(onLog?: LogFn): Promise<void> {
  if (!PROXY_URL) return;
  const url = (process.env.GOOGLE_ADS_PROXY_HEALTH_URL || 'https://example.com/').trim();
  try {
    const res = await fetch(url, withProxy({
      method: 'GET',
      headers: { 'user-agent': FETCH_HEADERS['user-agent'], accept: '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, onLog));
    await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 400) {
      onLog?.(
        'warn',
        `google-ads: egress check ${url} → ${res.status} via proxy — proxy is HEALTHY, so the 429s are GOOGLE's penalty on this exit IP. Remedy: quiet window or a different/rotating exit IP.`,
      );
    } else if (res.status === 429) {
      onLog?.(
        'error',
        `google-ads: egress check ${url} → 429 via proxy — the PROXY PROVIDER is rate-limiting this account (quota/bandwidth/connection cap), NOT Google. Check the proxy plan/dashboard.`,
      );
    } else {
      onLog?.(
        'warn',
        `google-ads: egress check ${url} → HTTP ${res.status} via proxy — proxy reachable but unhealthy; check the provider.`,
      );
    }
  } catch (err) {
    onLog?.(
      'error',
      `google-ads: egress check through the proxy FAILED (${(err as Error).message}) — the proxy went unreachable mid-job; verify credentials/whitelist/uptime with the provider.`,
    );
  }
}

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
  /** True when the creative RPCs for this advertiser were soft-blocked (429/403/
   *  challenge). Lets the pipeline trip a circuit breaker instead of grinding
   *  through retries for every remaining advertiser. */
  blocked: boolean;
  /** True when a SearchCreatives RPC was actually issued for this advertiser
   *  (i.e. the creative endpoint was probed). The circuit breaker counts blocks
   *  ONLY over these — an advertiser resolved from its domain without touching
   *  the creative endpoint is neutral and must not reset the breaker. */
  attemptedCreativeLookup: boolean;
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
 * Parse a SearchSuggestions response into leads. The CURRENT (2026) response
 * shape returns a mix of two entry kinds inside the top-level "1" array:
 *
 *   advertiser:  { "1": { "1": name, "2": "AR…id", "3": "US"(region), "5": true } }
 *   domain:      { "2": { "1": "example.com" } }
 *
 * Both are real leads. An advertiser is a named account (id + name + region);
 * a domain suggestion is a verified advertiser WEBSITE that matched the keyword
 * — which for a CPS pull is exactly the lead we want, so we emit it as a
 * domain-only advertiser (no id, name = domain, domain set) and let the resolver
 * turn it straight into https://domain.
 *
 * Robust to field drift: we read the documented positions first, then fall back
 * to a recursive scan (AR-id anywhere, region = the first positionally-nested
 * ISO2, first registrable host = domain). Older flat shapes still parse.
 */
export function parseAdvertiserSuggestions(json: unknown, keyword: string): GoogleAdsAdvertiser[] {
  const arr = firstResultArray(json);
  const out: GoogleAdsAdvertiser[] = [];
  const seen = new Set<string>();

  const emit = (adv: GoogleAdsAdvertiser) => {
    const key = adv.advertiser_id || (adv.domain ? `d:${adv.domain}` : adv.name.toLowerCase());
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(adv);
  };

  for (const raw of arr) {
    const item = asObj(raw);
    if (!item) continue;

    // Nested advertiser object lives under key "1"; domain object under "2".
    const advObj = asObj(item['1']);
    const domObj = asObj(item['2']);
    const strings = collectStrings(item);

    // ── Advertiser id: nested "2", else any AR-id in the subtree. ──
    let id = '';
    if (advObj && looksLikeAdvertiserId(str(advObj['2']))) id = str(advObj['2']).trim();
    if (!id) {
      const found = strings.find(looksLikeAdvertiserId);
      if (found) id = found;
    }

    if (id) {
      // Named advertiser account.
      let name = advObj ? str(advObj['1']).trim() : '';
      if (!name) name = str(item['12']).trim();
      if (!name) {
        name =
          strings
            .filter((s) => s !== id && !looksLikeAdvertiserId(s) && !looksLikeDomain(s) && s.length >= 2 && s.length <= 120)
            .sort((a, b) => b.length - a.length)[0] || '';
      }
      // Region is now positionally reliable: advertiser["3"] is an ISO2 country.
      let region: string | null = null;
      const r = advObj ? str(advObj['3']).trim().toUpperCase() : '';
      if (isCountryCode(r)) region = r;
      const domain = strings.map((s) => (looksLikeDomain(s) ? s.toLowerCase() : '')).find(Boolean) || null;
      emit({ advertiser_id: id, name, domain, region, matchedKeyword: keyword });
      continue;
    }

    // ── Domain-only suggestion → website lead. ──
    let domain = '';
    if (domObj && looksLikeDomain(str(domObj['1']))) domain = str(domObj['1']).trim().toLowerCase();
    if (!domain) {
      const found = strings.find((s) => looksLikeDomain(s));
      if (found) domain = found.toLowerCase();
    }
    if (domain) {
      emit({ advertiser_id: '', name: domain, domain, region: null, matchedKeyword: keyword });
      continue;
    }

    // ── Last resort: a bare human-ish name with no id/domain (rare). ──
    const name =
      strings
        .filter((s) => !looksLikeAdvertiserId(s) && !looksLikeDomain(s) && s.length >= 2 && s.length <= 120)
        .sort((a, b) => b.length - a.length)[0] || '';
    if (name) emit({ advertiser_id: '', name, domain: null, region: null, matchedKeyword: keyword });
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
    // Format code: current shape uses key "4"; older payloads used "8". Try both.
    const fmtRaw = item['4'] ?? item['8'];
    const format = FORMAT_MAP[String(fmtRaw)] ?? null;
    creatives.push({ advertiser_id: advertiserId, creative_id: creativeId, format });
  }
  // Next-page token: top-level "2" (older) or "3" (current) if it's an opaque string.
  const obj = asObj(json);
  const tok2 = obj && typeof obj['2'] === 'string' ? (obj['2'] as string) : '';
  const tok3 = obj && typeof obj['3'] === 'string' ? (obj['3'] as string) : '';
  const nextToken = tok2 || tok3 || null;
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

/** One physical RPC attempt (no retry). Separated so the retry loop stays clean. */
async function rpcPostOnce(
  url: string,
  body: string,
  label: string,
  onLog?: LogFn,
): Promise<RpcOutcome> {
  try {
    const res = await fetch(url, withProxy({
      method: 'POST',
      headers: baseHeaders(true),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, onLog));
    absorbSetCookie(res);
    if (res.status === 429 || res.status === 403) {
      // Drain so the connection is reusable.
      await res.text().catch(() => '');
      return { json: null, status: res.status, blocked: true, error: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      await res.text().catch(() => '');
      onLog?.('warn', `google-ads: HTTP ${res.status} on ${label}`);
      return { json: null, status: res.status, blocked: false, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const json = parseRpcJson(text);
    if (json === null) {
      // A 200 with unparseable body is almost always an HTML interstitial/challenge
      // (e.g. the google.com/sorry CAPTCHA) — treat as a soft block so we back off.
      return { json: null, status: res.status, blocked: true, error: 'unparseable body' };
    }
    return { json, status: res.status, blocked: false, error: null };
  } catch (err) {
    return { json: null, status: 0, blocked: false, error: (err as Error).message };
  }
}

function backoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * Math.pow(2, attempt);
  const capped = Math.min(BACKOFF_MAX_MS, raw);
  // Deterministic jitter in [0.5,1.0)*capped so retries de-synchronise without Math.random.
  return Math.floor(capped * (0.5 + 0.5 * pseudoJitter(attempt + 1)));
}

/**
 * POST an RPC with a shared cookie session and exponential-backoff retry on soft
 * blocks (429/403/challenge). Never throws — returns the last outcome. A block
 * ratchets the module throttle so the NEXT request (and this one's retries) wait
 * longer, which is the single most effective way to get un-flagged mid-job.
 */
async function rpcPost(
  method: string,
  payload: Record<string, unknown>,
  label: string,
  onLog?: LogFn,
  opts?: { maxRetries?: number },
): Promise<RpcOutcome> {
  const url = `${BASE}/anji/_/rpc/${method}?authuser=${encodeURIComponent(AUTHUSER)}`;
  const body = new URLSearchParams({ 'f.req': JSON.stringify(payload) }).toString();
  onLog?.('debug', `google-ads rpc ${label} → ${method}`);
  const maxRetries = opts?.maxRetries ?? MAX_RETRIES;

  let last: RpcOutcome = { json: null, status: 0, blocked: false, error: 'no attempt' };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await rpcPostOnce(url, body, label, onLog);
    if (last.json) {
      // A clean success gently relaxes the throttle back toward baseline.
      if (throttleFactor > 1) throttleFactor = Math.max(1, throttleFactor - 0.5);
      return last;
    }
    // Non-block transport errors (DNS/refused/timeout) or 5xx: one quick retry, no ratchet.
    const retriable = last.blocked || last.status === 0 || last.status >= 500;
    if (!retriable || attempt === maxRetries) break;
    if (last.blocked) {
      throttleFactor = Math.min(8, throttleFactor + 1); // slow everything down
      const wait = backoffMs(attempt);
      onLog?.(
        'warn',
        `google-ads: soft block on ${label} (${last.error}) — backoff ${Math.round(wait / 1000)}s, retry ${attempt + 1}/${maxRetries}`,
      );
      await sleep(wait);
    } else {
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS);
      onLog?.('debug', `google-ads: transient error on ${label} (${last.error}) — retry ${attempt + 1}/${maxRetries} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  if (last.blocked) {
    onLog?.('warn', `google-ads: HTTP ${last.status || '—'} on ${label} — blocked/rate-limited after ${maxRetries} retries (IP flagged, geo, or challenge)`);
  } else if (last.error) {
    onLog?.('warn', `google-ads: request error on ${label}: ${last.error}`);
  }
  return last;
}

// ───────────────────────────────────────────────────────────────────────────
// High-level scrape operations
// ───────────────────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  region?: string | null; // informational; only sent when GOOGLE_ADS_SEND_REGION=1
  onLog?: LogFn;
  /** Called after each keyword so the pipeline can update job phase. */
  onProgress?: (done: number, total: number, foundSoFar: number) => void;
  /**
   * Streaming hook: invoked (awaited) for EACH newly-discovered unique advertiser,
   * the moment it is found — before the next keyword is searched. The pipeline
   * uses this to resolve + persist + flush each lead in real time, so partial
   * results are saved continuously and a mid-scrape block/kill loses nothing.
   * Discovery pacing naturally interleaves with the awaited work here.
   */
  onAdvertiser?: (adv: GoogleAdsAdvertiser) => Promise<void>;
  /** Polled before each keyword; return true to stop discovery early (e.g. the
   *  pipeline hit its per-job advertiser cap). */
  shouldStop?: () => boolean;
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
  // Abort discovery after this many consecutive hard-failed keywords. Each
  // "failure" already survived the full retry/backoff ladder, so 2 in a row
  // means the endpoint is really refusing this IP — stop fast and let the
  // pipeline present everything found so far (leads are streamed/saved as
  // discovered, so an early abort loses nothing).
  const MAX_CONSECUTIVE_FAILURES = clampInt(process.env.GOOGLE_ADS_DISCOVERY_ABORT_AFTER, 2, 1, 20);

  if (PROXY_URL) {
    onLog?.('info', `google-ads: outbound proxy configured (${redactProxy(PROXY_URL)})`);
  } else {
    onLog?.('info', 'google-ads: no proxy — egressing from the host IP directly (set GOOGLE_ADS_PROXY_URL if this IP is rate-limited)');
  }

  // Cooldown gate: if this egress IP was recently proven hard-blocked, do not
  // send a single request — every request would renew Google's penalty and
  // push recovery further away. Abort instantly with a clear operator message.
  const coolLeft = googleAdsCooldownRemainingMs();
  if (coolLeft > 0) {
    const mins = Math.ceil(coolLeft / 60_000);
    out.blocked = true;
    out.notes.push(`cooldown active — no requests sent (${mins} min left)`);
    onLog?.(
      'warn',
      `google-ads: COOLDOWN ACTIVE — this egress IP was hard-blocked by Google recently. ` +
        `Skipping ALL scraping for another ~${mins} min so the penalty can expire. ` +
        `Re-running sooner only extends the block. (Tune via GOOGLE_ADS_COOLDOWN_MS.)`,
    );
    return out;
  }

  // Warm a cookie session first so the very first RPC already carries Google's
  // consent/NID cookies (best-effort; a fresh IP works without it too). A 429
  // on the homepage itself ⇒ penalty box: switch to probe mode (one cheap
  // keyword attempt, no retry ladder) instead of grinding backoffs.
  const warm = await warmUpSession(onLog);
  const probeMode = warm.blocked;
  if (probeMode) {
    onLog?.('warn', 'google-ads: warm-up got 429 — IP looks penalty-boxed; probing ONE keyword without retries before giving up');
  }

  for (let i = 0; i < keywords.length; i++) {
    if (opts.shouldStop?.()) {
      onLog?.('info', `google-ads: discovery stopped early by caller at keyword ${i + 1}/${keywords.length}`);
      break;
    }
    const kw = keywords[i];
    const payload: Record<string, unknown> = { '1': kw, '2': SUGGEST_LIMIT, '3': SUGGEST_LIMIT };
    // Probe mode (warm-up already 429'd): first keyword gets ONE attempt, no
    // retry ladder — if it is blocked too, the IP is definitively in the
    // penalty box and grinding backoffs would only renew it.
    const res = await rpcPost(
      'SearchService/SearchSuggestions',
      payload,
      `suggest "${kw}"`,
      onLog,
      probeMode && i === 0 ? { maxRetries: 0 } : undefined,
    );
    out.requestsMade++;
    out.keywordsSearched++;

    if (probeMode && i === 0 && res.blocked) {
      out.blocked = true;
      noteHardBlock();
      out.notes.push('IP penalty-boxed (warm-up AND probe keyword both 429) — aborted with no retry storm; cooldown started');
      onLog?.(
        'error',
        'google-ads: PENALTY BOX CONFIRMED (warm-up 429 + probe keyword 429). Aborting instantly — ' +
          'no retries, no further requests. Cooldown started: new google_ads jobs will refuse to scrape ' +
          'until it passes. Wait it out (or switch the proxy exit IP) before re-running.',
      );
      // One neutral-URL request (never Google) to tell the operator WHO 429'd.
      await probeEgressHealth(onLog);
      break;
    }

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
        if (res.blocked) {
          noteHardBlock();
          // One neutral-URL request (never Google) to tell the operator WHO 429'd.
          await probeEgressHealth(onLog);
        }
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
      // Stream each NEW advertiser to the caller immediately so it can resolve +
      // persist + flush in real time (partial results survive a later block/kill).
      if (opts.onAdvertiser) {
        try {
          await opts.onAdvertiser(adv);
        } catch (err) {
          onLog?.('warn', `google-ads: onAdvertiser hook threw for "${adv.name}" (non-fatal): ${(err as Error).message}`);
        }
      }
      if (opts.shouldStop?.()) break;
    }
    if (added > 0) onLog?.('debug', `google-ads: "${kw}" → +${added} advertisers (total ${out.advertisers.length})`);
    opts.onProgress?.(i + 1, keywords.length, out.advertisers.length);

    if (i < keywords.length - 1 && FETCH_DELAY_MS > 0) {
      // Adaptive pace: base delay + jitter, scaled by the throttle factor which
      // rises after any soft block (see rpcPost) and eases back on success.
      const base = FETCH_DELAY_MS * throttleFactor;
      await sleep(Math.floor(base + base * 0.5 * pseudoJitter(i)));
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
  /** Skip the SearchCreatives/GetCreativeById round-trips entirely and resolve
   *  from the verified domain only (no network). Set by the pipeline's circuit
   *  breaker once the creative endpoint starts hard-blocking. */
  skipCreativeLookups?: boolean;
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
  let sawBlock = false;
  let attemptedCreativeLookup = false;

  // Only spend a SearchCreatives round-trip while the per-job creative-lookup
  // budget still has room — once it is exhausted every creative would be read
  // for free anyway, so fall straight through to the verified domain instead.
  if (
    !opts.skipCreativeLookups &&
    adv.advertiser_id &&
    CREATIVE_LOOKUPS_PER_ADV > 0 &&
    opts.lookupBudget &&
    opts.lookupBudget.remaining() > 0
  ) {
    attemptedCreativeLookup = true;
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
    if (cres.blocked) sawBlock = true;
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
        if (dres.blocked) sawBlock = true;
        if (FETCH_DELAY_MS > 0) await sleep(FETCH_DELAY_MS);
        if (!dres.json) continue;
        const dest = extractDestinationUrl(dres.json);
        if (dest) {
          format = c.format;
          return { landingUrl: dest, format, creativesSeen, note: `creative:${c.format || 'unknown'}`, blocked: sawBlock, attemptedCreativeLookup };
        }
      }
    }
  }

  // Fallback: the verified advertiser domain.
  if (adv.domain && looksLikeDomain(adv.domain)) {
    return { landingUrl: `https://${adv.domain}`, format, creativesSeen, note: 'advertiser-domain', blocked: sawBlock, attemptedCreativeLookup };
  }

  return { landingUrl: null, format, creativesSeen, note: 'no-destination', blocked: sawBlock, attemptedCreativeLookup };
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

  // parseAdvertiserSuggestions — CURRENT (2026) nested shape + domain-only leads
  const suggestNested = `)]}'
{"1":[
  {"1":{"1":"HelloFresh SE","2":"AR17410177287600472065","3":"DE","5":true}},
  {"1":{"1":"Yummy Food Delivery","2":"AR14547402811097743361","3":"RO"}},
  {"2":{"1":"hellofresh.ca"}},
  {"2":{"1":"hellofresh.de"}}
],"3":"NEXTTOKEN"}`;
  const nested = parseAdvertiserSuggestions(parseRpcJson(suggestNested), 'hellofresh');
  check(nested.length === 4, `nested: 2 advertisers + 2 domain leads (got ${nested.length})`);
  const advN = nested.find((a) => a.advertiser_id === 'AR17410177287600472065');
  check(!!advN && advN.name === 'HelloFresh SE', 'nested: advertiser name from adv["1"]');
  check(!!advN && advN.region === 'DE', 'nested: region from adv["3"] (positionally reliable)');
  const domLead = nested.find((a) => !a.advertiser_id && a.domain === 'hellofresh.ca');
  check(!!domLead && domLead.name === 'hellofresh.ca', 'nested: domain-only suggestion → website lead');
  check(nested.filter((a) => a.domain && !a.advertiser_id).length === 2, 'nested: both domain suggestions kept');

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

  // parseCreativesResponse — CURRENT shape: format key "4", token key "3"
  const creativesNew = `)]}'
{"1":[{"1":"AR01111111111111111111","2":"CR33333333333333333333","4":2,"12":"Advertiser"}],"3":"NEXT2"}`;
  const pcNew = parseCreativesResponse(parseRpcJson(creativesNew));
  check(pcNew.creatives.length === 1 && pcNew.creatives[0].format === 'image', 'creatives: format from key "4"');
  check(pcNew.nextToken === 'NEXT2', 'creatives: next token from key "3"');

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
