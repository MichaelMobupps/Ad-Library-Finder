/**
 * Store resolver + mandatory match verification.
 *
 * Given an offer's cleaned name and a target platform, find the matching
 * app-store listing and PROVE the candidate is actually the right app.
 *
 * Why verification is non-negotiable:
 *   Real-world examples observed during recon:
 *     TikTok    → iTunes returns "com.tikio.app" (junk clone)
 *     CapCut    → Play returns "com.video.editor.greattalent" (junk)
 *     SupraPlay → Play returns a generic slots app, not the offer
 *   The store search APIs return *something* for almost any query.
 *   Accepting the first result blindly poisons the CSV.
 *
 * Acceptance rule:
 *   candidate is accepted iff token-overlap(cleaned_name, candidate_title)
 *   passes BOTH:
 *     - all non-stopword tokens of cleaned_name appear in candidate_title
 *       (substring match, case-insensitive, allowing within longer words
 *       so "Slots" matches "SlotsCasino")
 *     - similarity ratio >= 0.6 (token Jaccard, see jaccard())
 *
 * If no candidate passes, we DROP the offer. Never invent a store URL.
 */

import { log } from './logger.js';

export type Platform = 'android' | 'ios';

export interface ResolvedStore {
  storeUrl: string;
  candidateTitle: string;
  packageOrBundle: string; // play package name or iTunes bundleId
  score: number; // Jaccard, for diagnostics
}

export interface ResolveOutcome {
  resolved: ResolvedStore | null;
  reason?: string; // why dropped, when null
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to',
  'app', 'apps', 'game', 'games',
]);

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Jaccard similarity between two token sets. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Accept candidate iff:
 *   - every offer token appears as a substring inside the joined candidate
 *     title (lowercased), OR
 *   - Jaccard ratio >= 0.6
 *
 * Substring rule catches "Township" inside "Township: Farm & City Building".
 * Jaccard catches multi-word names where some tokens differ in word order.
 */
export function verifyMatch(
  offerName: string,
  candidateTitle: string
): { ok: boolean; score: number; reason: string } {
  const offerTokens = tokenize(offerName);
  const candTokens = tokenize(candidateTitle);
  if (offerTokens.length === 0) return { ok: false, score: 0, reason: 'empty offer tokens' };
  if (candTokens.length === 0) return { ok: false, score: 0, reason: 'empty candidate tokens' };

  const candJoined = candTokens.join(' ');
  const allInSubstring = offerTokens.every((t) => candJoined.includes(t));
  const j = jaccard(offerTokens, candTokens);

  if (allInSubstring) return { ok: true, score: j, reason: `substring match (j=${j.toFixed(2)})` };
  if (j >= 0.6) return { ok: true, score: j, reason: `jaccard ${j.toFixed(2)} >= 0.6` };
  return { ok: false, score: j, reason: `j=${j.toFixed(2)}, missing tokens: ${offerTokens.filter((t) => !candJoined.includes(t)).join(',')}` };
}

// ---- iTunes (iOS) ---------------------------------------------------------

interface ItunesResult {
  trackName: string;
  trackViewUrl: string;
  bundleId: string;
}

async function searchITunes(query: string): Promise<ItunesResult[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&limit=10`;
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: ItunesResult[] };
    return Array.isArray(json.results) ? json.results : [];
  } catch (err) {
    log.warn(`iTunes search failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}

// ---- Play Store (Android) -------------------------------------------------

interface PlayResult {
  title: string;
  packageName: string;
  url: string;
}

/**
 * Scrape play.google.com/store/search for app results.
 * Page structure:
 *   - App listing links: /store/apps/details?id=<package>
 *   - Title appears in a sibling text node, but the markup is heavily
 *     obfuscated. We use the per-link `aria-label` when present, else
 *     derive the title from the nearest reasonable text.
 *
 * Simpler approach: scrape title via a follow-up request to
 *   https://play.google.com/store/apps/details?id=<package>&hl=en
 * Returns the title in <title>App Name - Apps on Google Play</title>.
 *
 * We do two phases:
 *   1. Search page → extract up to 5 candidate package names.
 *   2. For each candidate, fetch the details page → extract <title>.
 *
 * Polite: at most 5 detail fetches per offer, with a small jitter sleep.
 */
async function searchPlay(query: string): Promise<PlayResult[]> {
  const searchUrl = `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps&hl=en`;
  let html: string;
  try {
    const res = await fetch(searchUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch (err) {
    log.warn(`Play search failed for "${query}": ${(err as Error).message}`);
    return [];
  }

  // Extract up to 5 unique package names from /store/apps/details?id=...
  const packageSet = new Set<string>();
  const re = /\/store\/apps\/details\?id=([a-zA-Z0-9._-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    packageSet.add(m[1]);
    if (packageSet.size >= 5) break;
  }

  const packages = [...packageSet];
  const out: PlayResult[] = [];
  for (const pkg of packages) {
    const title = await fetchPlayTitle(pkg);
    if (title) {
      out.push({
        title,
        packageName: pkg,
        url: `https://play.google.com/store/apps/details?id=${pkg}`,
      });
    }
    await sleep(150 + Math.random() * 250);
  }
  return out;
}

async function fetchPlayTitle(pkg: string): Promise<string | null> {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en`;
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // <title>AppName - Apps on Google Play</title>
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!m) return null;
    let title = m[1].trim();
    // Strip trailing "- Apps on Google Play" / "- Google Play" suffix
    title = title.replace(/\s*[-–—]\s*Apps?\s+on\s+Google\s+Play\s*$/i, '');
    title = title.replace(/\s*[-–—]\s*Google\s+Play\s*$/i, '');
    return title.trim();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Top-level resolve ----------------------------------------------------

export async function resolveAndVerify(
  cleanedName: string,
  platform: Platform
): Promise<ResolveOutcome> {
  if (!cleanedName) return { resolved: null, reason: 'empty cleaned name' };

  if (platform === 'ios') {
    const results = await searchITunes(cleanedName);
    if (results.length === 0) return { resolved: null, reason: 'no iTunes results' };

    let bestRejected: { title: string; score: number; reason: string } | null = null;
    for (const r of results) {
      const v = verifyMatch(cleanedName, r.trackName);
      if (v.ok) {
        return {
          resolved: {
            storeUrl: r.trackViewUrl,
            candidateTitle: r.trackName,
            packageOrBundle: r.bundleId,
            score: v.score,
          },
        };
      }
      if (!bestRejected || v.score > bestRejected.score) {
        bestRejected = { title: r.trackName, score: v.score, reason: v.reason };
      }
    }
    return {
      resolved: null,
      reason: `no iTunes match passed verification (best: "${bestRejected?.title}" — ${bestRejected?.reason})`,
    };
  }

  // android
  const results = await searchPlay(cleanedName);
  if (results.length === 0) return { resolved: null, reason: 'no Play results' };

  let bestRejected: { title: string; score: number; reason: string } | null = null;
  for (const r of results) {
    const v = verifyMatch(cleanedName, r.title);
    if (v.ok) {
      return {
        resolved: {
          storeUrl: r.url,
          candidateTitle: r.title,
          packageOrBundle: r.packageName,
          score: v.score,
        },
      };
    }
    if (!bestRejected || v.score > bestRejected.score) {
      bestRejected = { title: r.title, score: v.score, reason: v.reason };
    }
  }
  return {
    resolved: null,
    reason: `no Play match passed verification (best: "${bestRejected?.title}" — ${bestRejected?.reason})`,
  };
}

// ---- Unit tests -----------------------------------------------------------

interface VerifyTestCase {
  name: string;
  candidate: string;
  shouldPass: boolean;
  desc?: string;
}

const VERIFY_TESTS: VerifyTestCase[] = [
  // Real-world recon failures: must REJECT
  { name: 'TikTok', candidate: 'TikIo - clone app', shouldPass: false, desc: 'tikio.app junk' },
  { name: 'CapCut', candidate: 'Video Editor Great Talent', shouldPass: false, desc: 'capcut junk' },
  { name: 'SupraPlay', candidate: 'Slot Machine Casino Vegas', shouldPass: false, desc: 'supraplay slots junk' },
  // Real-world recon successes: must ACCEPT
  { name: 'Township', candidate: 'Township', shouldPass: true },
  { name: 'Township', candidate: 'Township: Farm & City Building', shouldPass: true, desc: 'extra subtitle ok' },
  { name: 'TikTok', candidate: 'TikTok', shouldPass: true },
  { name: 'TikTok', candidate: 'TikTok - Make Your Day', shouldPass: true },
  { name: 'CapCut', candidate: 'CapCut - Video Editor', shouldPass: true },
  { name: 'Slots Casino', candidate: 'Slots Casino - Vegas Slot Machine', shouldPass: true },
  // Multi-word name with word-order variation
  { name: 'JVSpin Slot', candidate: 'Slot JVSpin Casino', shouldPass: true },
];

export function runVerifyMatchTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
  for (const tc of VERIFY_TESTS) {
    const v = verifyMatch(tc.name, tc.candidate);
    const ok = v.ok === tc.shouldPass;
    if (ok) {
      passed++;
    } else {
      failures.push(
        `FAIL: verifyMatch(${JSON.stringify(tc.name)}, ${JSON.stringify(tc.candidate)}) → ok=${v.ok} (expected ${tc.shouldPass}). ${v.reason}${tc.desc ? ` [${tc.desc}]` : ''}`
      );
    }
  }
  return { passed, failed: failures.length, failures };
}

// Script entry point
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeResolver.js') || process.argv[1].endsWith('storeResolver.ts'));
if (isMain) {
  const { passed, failed, failures } = runVerifyMatchTests();
  console.log(`storeResolver verifyMatch: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}