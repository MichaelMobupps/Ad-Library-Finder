import Anthropic from '@anthropic-ai/sdk';
import { log } from './logger.js';

export type Classification =
  | 'mobile_google_play'
  | 'mobile_app_store'
  | 'cps_web'
  | 'unknown';

export interface ClassifyResult {
  classification: Classification;
  store_url: string | null; // Set for mobile_*; null otherwise
}

// Known MMP tracker domains. Any landing URL on these is mobile.
// Add new ones here when you encounter them.
const MMP_TRACKER_DOMAINS = [
  'onelink.me',          // AppsFlyer
  'app.link',            // Branch
  'app.appsflyer.com',   // AppsFlyer
  'bnc.lt',              // Branch (legacy)
  'adj.st',              // Adjust
  'sng.link',            // Singular
  'singular.link',       // Singular
  'tenjin.io',           // Tenjin
  'kochava.com',         // Kochava
  'appsflyer.com',       // AppsFlyer (root)
];

const PLAY_RE = /^https?:\/\/(play\.google\.com\/store\/apps\/details)/i;
const APPSTORE_RE = /^https?:\/\/(apps|itunes)\.apple\.com\//i;

export async function classify(landingUrl: string | null, adText: string | null): Promise<ClassifyResult> {
  if (!landingUrl) return { classification: 'unknown', store_url: null };

  // 1. Direct app store URL
  if (PLAY_RE.test(landingUrl)) {
    return { classification: 'mobile_google_play', store_url: canonicalPlayUrl(landingUrl) };
  }
  if (APPSTORE_RE.test(landingUrl)) {
    return { classification: 'mobile_app_store', store_url: canonicalAppStoreUrl(landingUrl) };
  }

  // 2. Known MMP tracker — follow redirects to find the store URL
  if (isMmpTracker(landingUrl)) {
    const resolved = await resolveRedirects(landingUrl);
    if (resolved) {
      if (PLAY_RE.test(resolved)) return { classification: 'mobile_google_play', store_url: canonicalPlayUrl(resolved) };
      if (APPSTORE_RE.test(resolved)) return { classification: 'mobile_app_store', store_url: canonicalAppStoreUrl(resolved) };
    }
    // It's a tracker so we know it's mobile, but couldn't resolve the store URL.
    // Mark as mobile with the tracker URL itself as a fallback preview.
    return { classification: 'mobile_google_play', store_url: landingUrl };
  }

  // 3. Heuristic: e-commerce / SaaS / lead-gen URLs that look clearly web
  if (looksClearlyWeb(landingUrl)) {
    return { classification: 'cps_web', store_url: null };
  }

  // 4. Ambiguous — LLM with adaptive thinking
  return await llmClassify(landingUrl, adText);
}

function isMmpTracker(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return MMP_TRACKER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function looksClearlyWeb(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Anything ending in these TLDs/subdomains is almost certainly a web product
    const webHints = ['shopify.com', 'webflow.io', 'squarespace.com', 'wixsite.com'];
    if (webHints.some((h) => host.endsWith(h))) return true;
    // Common path patterns
    const pathname = new URL(url).pathname.toLowerCase();
    const ecomHints = ['/products/', '/collections/', '/cart', '/checkout', '/shop'];
    if (ecomHints.some((p) => pathname.includes(p))) return true;
    return false;
  } catch {
    return false;
  }
}

function canonicalPlayUrl(url: string): string {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('id');
    if (id) return `https://play.google.com/store/apps/details?id=${id}`;
    return url;
  } catch {
    return url;
  }
}

function canonicalAppStoreUrl(url: string): string {
  // Strip query params (preserve country/app path)
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

async function resolveRedirects(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      },
    });
    return res.url || null;
  } catch (err) {
    log.warn(`redirect resolution failed for ${url}`, (err as Error).message);
    return null;
  }
}

// ---------- LLM fallback ----------

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    client = new Anthropic({ apiKey });
  }
  return client;
}

async function llmClassify(landingUrl: string, adText: string | null): Promise<ClassifyResult> {
  const prompt = `You are classifying a Facebook ad's landing destination.

LANDING URL: ${landingUrl}
AD TEXT (first 800 chars): ${(adText || '').slice(0, 800) || '(none)'}

Classify into exactly one category:
- "mobile_google_play" — the destination is or will redirect to a Google Play app listing
- "mobile_app_store" — the destination is or will redirect to an Apple App Store listing
- "cps_web" — the destination is a website (e-commerce, SaaS, lead-gen, service signup, content site)
- "unknown" — cannot determine

If mobile_*, return the store URL if visible from the landing URL or ad text. If not visible, return null.

Respond ONLY with this JSON shape, no preamble, no markdown:
{"classification": "<one of the four>", "store_url": "<url or null>"}`;

  try {
    const res = await getClient().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      thinking: { type: 'enabled', budget_tokens: 3000 },
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = res.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { classification: 'unknown', store_url: null };
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { classification: Classification; store_url: string | null };

    // Defensive: ensure category is valid
    const valid: Classification[] = ['mobile_google_play', 'mobile_app_store', 'cps_web', 'unknown'];
    if (!valid.includes(parsed.classification)) {
      return { classification: 'unknown', store_url: null };
    }
    return parsed;
  } catch (err) {
    log.error(`LLM classify failed for ${landingUrl}`, (err as Error).message);
    return { classification: 'unknown', store_url: null };
  }
}
