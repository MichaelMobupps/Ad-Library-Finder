/**
 * Store-page input fetcher. Given a resolved store URL (iTunes or Play),
 * return the publisher/developer name, website, category, description, and
 * (for Play) the developer's support email + legal entity name. This is the
 * input fed into hqResolver.resolveHq().
 *
 * Two paths:
 *   - iTunes (iOS):  lookup API at https://itunes.apple.com/lookup?id=<id>
 *                    returns JSON with sellerName, sellerUrl, primaryGenreName,
 *                    description, artistName.
 *   - Play  (Android): scrape the public details page at
 *                    https://play.google.com/store/apps/details?id=<pkg>&hl=en
 *
 * Play scraping note: Google's response is heavily server-rendered with
 * scattered JSON-in-HTML blobs. We parse for a handful of stable markers:
 *   - <title>App Name - Apps on Google Play</title>
 *   - itemprop="name" → app name (fallback)
 *   - <a href="/store/apps/developer?id=…"><span>Developer Name</span></a>
 *     → publisher name (the URL-encoded id is also our fallback)
 *   - <a href="/store/apps/category/COMMUNICATION" aria-label="Communication">
 *     → category (via aria-label)
 *   - "About the developer" section → legal entity name + email
 *   - meta og:description / meta description → description
 *
 * If Play starts blocking us (HTTP 429/403, or a "consent" interstitial), the
 * caller logs and continues with whatever fields could be extracted; missing
 * fields fall back to whatever the hqResolver LLM can do with just the app name.
 */

import { log } from './logger.js';

export interface StorePageInfo {
  appName: string;
  publisherName: string;
  developerWebsite: string;
  developerEmail: string;
  legalName: string;
  category: string;
  description: string;
  storeUrl: string;
  platform: 'ios' | 'android' | 'unknown';
  /** True iff the fetch returned at least appName + publisherName. */
  ok: boolean;
  /** Why we returned a degraded record, if any. */
  fetchNote: string;
}

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─────────────────────────────────────────────────────────────
// iTunes
// ─────────────────────────────────────────────────────────────

/** Extract the numeric track id from an apps.apple.com or itunes.apple.com URL. */
export function parseITunesTrackId(url: string): string | null {
  const m = url.match(/\/id(\d+)/);
  return m ? m[1] : null;
}

interface ItunesLookupResult {
  trackName?: string;
  artistName?: string;
  sellerName?: string;
  sellerUrl?: string;
  primaryGenreName?: string;
  description?: string;
}

export async function fetchITunesPage(url: string): Promise<StorePageInfo> {
  const trackId = parseITunesTrackId(url);
  if (!trackId) {
    return degraded(url, 'ios', 'iTunes URL missing /id<digits> segment');
  }
  const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}`;
  try {
    const res = await fetch(lookupUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return degraded(url, 'ios', `iTunes lookup HTTP ${res.status}`);
    }
    const json = (await res.json()) as { results?: ItunesLookupResult[] };
    if (!json.results || json.results.length === 0) {
      return degraded(url, 'ios', 'iTunes lookup returned 0 results');
    }
    const r = json.results[0];
    const publisher = r.sellerName || r.artistName || '';
    return {
      appName: r.trackName || '',
      publisherName: publisher,
      developerWebsite: r.sellerUrl || '',
      developerEmail: '',
      legalName: r.sellerName || '',
      category: r.primaryGenreName || '',
      description: r.description || '',
      storeUrl: url,
      platform: 'ios',
      ok: !!(r.trackName && publisher),
      fetchNote: '',
    };
  } catch (err) {
    return degraded(url, 'ios', `iTunes fetch error: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Play
// ─────────────────────────────────────────────────────────────

/** Extract the package name from a play.google.com URL. */
export function parsePlayPackage(url: string): string | null {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id');
    return id || null;
  } catch {
    return null;
  }
}

export async function fetchPlayPage(url: string): Promise<StorePageInfo> {
  const pkg = parsePlayPackage(url);
  if (!pkg) return degraded(url, 'android', 'Play URL missing ?id= param');

  const pageUrl = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
  let html: string;
  try {
    const res = await fetch(pageUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 || res.status === 403) {
      // Caller treats this as a blocking signal.
      return degraded(url, 'android', `Play HTTP ${res.status} (blocked/rate-limited)`);
    }
    if (!res.ok) {
      return degraded(url, 'android', `Play HTTP ${res.status}`);
    }
    html = await res.text();
  } catch (err) {
    return degraded(url, 'android', `Play fetch error: ${(err as Error).message}`);
  }

  return parsePlayHtml(html, url);
}

/**
 * Parse a Play details HTML page. Split out so we can unit-test against
 * fixture HTML without going to the network.
 */
export function parsePlayHtml(html: string, url: string): StorePageInfo {
  // ── App name ──
  let appName = '';
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    let t = titleMatch[1].trim();
    t = t.replace(/\s*[-–—]\s*Apps?\s+on\s+Google\s+Play\s*$/i, '');
    t = t.replace(/\s*[-–—]\s*Google\s+Play\s*$/i, '');
    appName = t.trim();
  }
  if (!appName) {
    const ip = html.match(/itemprop=["']name["'][^>]*>(?:<[^>]+>)*([^<]+)</i);
    if (ip) appName = decodeHtmlEntities(ip[1]).trim();
  }

  // ── Publisher name ──
  // Play markup: <a href="/store/apps/developer?id=Foo+Bar"><span>Foo Bar</span></a>
  // We match either "developer" or "dev" (legacy URL) and tolerate the
  // wrapping <span> via a non-greedy text-or-tag pattern.
  let publisherName = '';
  const devAnchorRe = /<a[^>]+href=["']\/store\/apps\/(?:developer|dev)\?id=([^"']+)["'][^>]*>(?:<[^>]+>)*([^<]+)</i;
  const devMatch = html.match(devAnchorRe);
  if (devMatch) {
    publisherName = decodeHtmlEntities(devMatch[2]).trim();
  }
  // Fallback: just the URL-encoded id from the href.
  if (!publisherName) {
    const devIdMatch = html.match(/\/store\/apps\/(?:developer|dev)\?id=([^"'&<>]+)/i);
    if (devIdMatch) publisherName = decodeURIComponent(devIdMatch[1]).replace(/\+/g, ' ').trim();
  }

  // ── Developer website (the support/marketing link on the listing) ──
  // We use the same heuristic as before: first non-Google/Apple/Play
  // external anchor.
  let developerWebsite = '';
  const allAnchors = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi)];
  for (const a of allAnchors) {
    const href = a[1];
    if (!isCandidateDevSite(href)) continue;
    developerWebsite = href;
    break;
  }

  // ── Developer email ──
  let developerEmail = '';
  const mailMatch = html.match(/mailto:([^"'<>?]+)/i);
  if (mailMatch) developerEmail = mailMatch[1].trim();
  // Also: "About the developer" block embeds the email as bare text.
  // <div class="Bne0R">About the developer</div><div class="HhKIQc"><div> LegalName </div><div> email@x </div>...
  if (!developerEmail) {
    const aboutMatch = html.match(/About the developer<\/div>\s*<div[^>]*>(?:\s|<[^>]+>)*<div[^>]*>\s*([^<]+?)\s*<\/div>\s*<div[^>]*>\s*([^<]+?)\s*<\/div>/i);
    if (aboutMatch) {
      const maybeEmail = aboutMatch[2].trim();
      if (maybeEmail.includes('@')) developerEmail = maybeEmail;
    }
  }

  // ── Legal entity name (separate from the marketing publisher) ──
  // "About the developer" → first div is the legal name.
  let legalName = '';
  const aboutMatch = html.match(/About the developer<\/div>\s*<div[^>]*>(?:\s|<[^>]+>)*<div[^>]*>\s*([^<]+?)\s*<\/div>/i);
  if (aboutMatch) {
    legalName = decodeHtmlEntities(aboutMatch[1]).trim();
  }

  // ── Category ──
  let category = '';
  // First try aria-label on the category anchor (most reliable).
  const catAriaRe = /<a[^>]+href=["']\/store\/apps\/category\/[A-Z_]+["'][^>]*aria-label=["']([^"']+)["']/i;
  const catAriaMatch = html.match(catAriaRe);
  if (catAriaMatch) category = decodeHtmlEntities(catAriaMatch[1]).trim();
  // Fallback: any <span> inside an itemprop="genre" element.
  if (!category) {
    const genreSpan = html.match(/itemprop=["']genre["'][^>]*>(?:[\s\S]*?)<span[^>]*>([^<]+)<\/span>/i);
    if (genreSpan) category = decodeHtmlEntities(genreSpan[1]).trim();
  }
  // Last resort: derive from the category URL path itself.
  if (!category) {
    const catPathMatch = html.match(/\/store\/apps\/category\/([A-Z_]+)/);
    if (catPathMatch) {
      const slug = catPathMatch[1].replace(/_/g, ' ').toLowerCase();
      category = slug.charAt(0).toUpperCase() + slug.slice(1);
    }
  }

  // ── Description ──
  let metaDescription = '';
  const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (metaMatch) metaDescription = decodeHtmlEntities(metaMatch[1]);

  let ogDescription = '';
  const ogMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch) ogDescription = decodeHtmlEntities(ogMatch[1]);

  const description = (ogDescription.length >= metaDescription.length ? ogDescription : metaDescription) || '';

  const ok = !!(appName && publisherName);
  return {
    appName,
    publisherName,
    developerWebsite,
    developerEmail,
    legalName,
    category,
    description,
    storeUrl: url,
    platform: 'android',
    ok,
    fetchNote: ok ? '' : 'Play page parsed but missing appName or publisherName',
  };
}

function isCandidateDevSite(href: string): boolean {
  const h = href.toLowerCase();
  const blocked = [
    'google.com',
    'google.co',
    'play.google.com',
    'support.google.com',
    'policies.google.com',
    'accounts.google.com',
    'gstatic.com',
    'youtube.com',
    'apps.apple.com',
    'itunes.apple.com',
    'apple.com',
  ];
  for (const b of blocked) {
    if (h.includes('//' + b) || h.includes('.' + b)) return false;
  }
  if (h.startsWith('javascript:') || h.startsWith('mailto:') || h.startsWith('#')) return false;
  return true;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────

export async function fetchStorePage(url: string): Promise<StorePageInfo> {
  if (!url) return degraded(url, 'unknown', 'empty URL');
  if (/^https?:\/\/(apps|itunes)\.apple\.com/i.test(url)) return fetchITunesPage(url);
  if (/^https?:\/\/play\.google\.com/i.test(url)) return fetchPlayPage(url);
  return degraded(url, 'unknown', 'not an iTunes or Play URL');
}

function degraded(url: string, platform: StorePageInfo['platform'], note: string): StorePageInfo {
  log.warn(`storePageFetcher: degraded result for ${url} — ${note}`);
  return {
    appName: '',
    publisherName: '',
    developerWebsite: '',
    developerEmail: '',
    legalName: '',
    category: '',
    description: '',
    storeUrl: url,
    platform,
    ok: false,
    fetchNote: note,
  };
}

// ─────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────

interface ParseTest {
  name: string;
  url: string;
  expected: string | null;
}

const ITUNES_PARSE_TESTS: ParseTest[] = [
  { name: 'standard apps.apple.com', url: 'https://apps.apple.com/us/app/whatsapp-messenger/id310633997', expected: '310633997' },
  { name: 'short form', url: 'https://apps.apple.com/app/id310633997', expected: '310633997' },
  { name: 'itunes.apple.com', url: 'https://itunes.apple.com/app/id310633997', expected: '310633997' },
  { name: 'with query', url: 'https://apps.apple.com/us/app/whatsapp/id310633997?platform=iphone', expected: '310633997' },
  { name: 'no id', url: 'https://apps.apple.com/us/app/whatsapp', expected: null },
];

const PLAY_PARSE_TESTS: ParseTest[] = [
  { name: 'standard', url: 'https://play.google.com/store/apps/details?id=com.whatsapp', expected: 'com.whatsapp' },
  { name: 'with hl', url: 'https://play.google.com/store/apps/details?id=com.whatsapp&hl=en', expected: 'com.whatsapp' },
  { name: 'no id', url: 'https://play.google.com/store/apps/details', expected: null },
];

// Synthetic Play HTML fixture mimicking the WhatsApp listing shape we observed.
const PLAY_HTML_FIXTURE = `
<html><head>
  <title>WhatsApp Messenger - Apps on Google Play</title>
  <meta name="description" content="Simple. Reliable. Private.">
  <meta property="og:description" content="Simple. Reliable. Private. Message and call privately.">
</head><body>
  <span itemprop="name">WhatsApp Messenger</span>
  <div class="Vbfug auoIOc"><a href="/store/apps/developer?id=WhatsApp+LLC"><span>WhatsApp LLC</span></a></div>
  <a href="/store/apps/category/COMMUNICATION" aria-label="Communication" jsname="hSRGPd"><span>Communication</span></a>
  <a href="https://www.whatsapp.com/">Visit website</a>
  <div class="Bne0R ">About the developer</div><div class="HhKIQc"><div> Meta Platforms, Inc. </div><div> android@support.whatsapp.com </div></div>
</body></html>
`;

interface PlayParseCase {
  field: keyof StorePageInfo;
  expected: string;
}

const PLAY_PARSE_CASES: PlayParseCase[] = [
  { field: 'appName', expected: 'WhatsApp Messenger' },
  { field: 'publisherName', expected: 'WhatsApp LLC' },
  { field: 'category', expected: 'Communication' },
  { field: 'legalName', expected: 'Meta Platforms, Inc.' },
  { field: 'developerEmail', expected: 'android@support.whatsapp.com' },
  { field: 'developerWebsite', expected: 'https://www.whatsapp.com/' },
];

export function runStorePageFetcherUnitTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
  for (const tc of ITUNES_PARSE_TESTS) {
    const got = parseITunesTrackId(tc.url);
    if (got === tc.expected) passed++;
    else failures.push(`iTunes ${tc.name}: got ${JSON.stringify(got)} expected ${JSON.stringify(tc.expected)}`);
  }
  for (const tc of PLAY_PARSE_TESTS) {
    const got = parsePlayPackage(tc.url);
    if (got === tc.expected) passed++;
    else failures.push(`Play ${tc.name}: got ${JSON.stringify(got)} expected ${JSON.stringify(tc.expected)}`);
  }

  // Play HTML parse fixture
  const parsed = parsePlayHtml(PLAY_HTML_FIXTURE, 'https://play.google.com/store/apps/details?id=com.whatsapp');
  for (const tc of PLAY_PARSE_CASES) {
    const got = String(parsed[tc.field] ?? '');
    if (got === tc.expected) passed++;
    else failures.push(`parsePlayHtml ${tc.field}: got ${JSON.stringify(got)} expected ${JSON.stringify(tc.expected)}`);
  }
  if (parsed.ok) passed++;
  else failures.push(`parsePlayHtml: ok was false (note: ${parsed.fetchNote})`);

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storePageFetcher.js') || process.argv[1].endsWith('storePageFetcher.ts'));
if (isMain) {
  const { passed, failed, failures } = runStorePageFetcherUnitTests();
  console.log(`storePageFetcher unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}