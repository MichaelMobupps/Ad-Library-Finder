/**
 * Affplus listing scraper.
 *
 * The Affplus search page (https://www.affplus.com/search?platforms=Android,
 * &platforms=iOS) is server-rendered. Each results page renders ~29-31 offer
 * "hits" in the markup, regardless of how many infinite-scroll loads the JS
 * would otherwise perform.
 *
 * Pagination is via `&page=N` (1-indexed). Geo filter via `&geos=<ISO2>` —
 * tested manually in recon and confirmed working.
 *
 * Card markup (verified by inspect on 2026-05-22):
 *
 *   <div class="hit ...">
 *     <a href="/o/<slug>" class="otitle ...">  <-- offer name + slug
 *       NAME (whitespace-padded)
 *     </a>
 *     <a href="/n/<network-slug>"><span ...>NETWORK</span></a>
 *     <span class="flex items-center mr-3 font-semibold ...">  <-- vertical/format tag
 *       <svg>...</svg>
 *       TAG_TEXT
 *     </span>
 *     ... (multiple of those per card; one per vertical/format)
 *     <span class="oc font-semibold">GEO</span>  <-- ISO2 country code
 *   </div>
 *
 * Skip list (drop the offer entirely): if ANY vertical tag matches Adult,
 * Dating, Cam, Nutra, Sweepstake (case-insensitive). These are not target
 * verticals for the mobile pipeline.
 */

import { log } from './logger.js';

export interface AffplusOffer {
  name: string;
  slug: string; // "/o/<slug>" → just <slug>
  network: string;
  verticals: string[];
  geo: string | null;
}

export type Platform = 'Android' | 'iOS' | 'Web';

/**
 * Affplus has no "Web" platform tag. Its desktop/web inventory is filtered with
 * `platforms=Desktop` (the device axis), so the web/CPS path maps the internal
 * 'Web' platform to this wire value. Recon note: the Desktop slice is narrow
 * (~1.8k offers); the broader web-CPS inventory is vertical-tagged
 * (CPS / Insurance / Finance / Ecommerce) and device-agnostic, so Desktop alone
 * under-collects. Vertical-seeded listing is the documented next step if volume
 * is short — see the handoff. One named constant keeps that swap to one line.
 */
const WEB_PLATFORM = 'Desktop';

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const SKIP_VERTICALS = new Set([
  // Original skip-list (non-mobile-app verticals).
  'adult', 'dating', 'cam', 'cams', 'nutra', 'sweepstake', 'sweepstakes',
  // Operator-requested extensions — Affplus mostly returns these for the
  // mobile path even though they have no Play/App Store app.
  'ecommerce', 'e-commerce',
  'ctc', 'ctp',
  'dropship', 'dropshipping',
  'leadgen', 'lead-gen', 'lead generation', 'leads',
  'survey', 'surveys',
  'finance', 'crypto', 'forex', 'trading',
  'cps',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildSearchUrl(platform: Platform, page: number, geo?: string | null): string {
  const params = new URLSearchParams();
  params.set('platforms', platform === 'Web' ? WEB_PLATFORM : platform);
  if (geo) params.set('geos', geo.toUpperCase());
  if (page > 1) params.set('page', String(page));
  return `https://www.affplus.com/search?${params.toString()}`;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log.warn(`affplus fetch ${url} → ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    log.warn(`affplus fetch ${url} failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Extract `<div class="hit ...">` substrings from a search page. Returns each
 * card's raw HTML chunk for downstream regex extraction.
 */
function splitCards(html: string): string[] {
  const cards: string[] = [];
  const openRe = /<div class="hit [^"]*">/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) starts.push(m.index);
  if (starts.length === 0) return cards;
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i];
    const b = i + 1 < starts.length ? starts[i + 1] : Math.min(starts[i] + 8000, html.length);
    cards.push(html.slice(a, b));
  }
  return cards;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

export function parseCard(cardHtml: string): AffplusOffer | null {
  // Name + slug
  const slugMatch = cardHtml.match(/<a\s+href="\/o\/([a-z0-9-]+)"[^>]*class="otitle[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (!slugMatch) return null;
  const slug = slugMatch[1];
  const rawName = decodeHtmlEntities(stripTags(slugMatch[2])).replace(/\s+/g, ' ').trim();
  if (!rawName) return null;

  // Network — first <a href="/n/..."> inside the card
  let network = '';
  const netMatch = cardHtml.match(/<a\s+href="\/n\/[a-z0-9-]+"[^>]*>([\s\S]*?)<\/a>/i);
  if (netMatch) network = decodeHtmlEntities(stripTags(netMatch[1])).replace(/\s+/g, ' ').trim();

  // Verticals / format tags — each `<span class="flex items-center mr-3 font-semibold hover:text-green-500">`
  const verticals: string[] = [];
  const tagRe = /<span\s+class="flex items-center mr-3 font-semibold hover:text-green-500"[^>]*>([\s\S]*?)<\/span>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(cardHtml)) !== null) {
    const txt = decodeHtmlEntities(stripTags(tm[1])).replace(/\s+/g, ' ').trim();
    if (txt) verticals.push(txt);
  }

  // Geo — <span class="oc font-semibold">CC</span>
  let geo: string | null = null;
  const geoMatch = cardHtml.match(/<span\s+class="oc[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  if (geoMatch) {
    const g = decodeHtmlEntities(stripTags(geoMatch[1])).replace(/\s+/g, ' ').trim();
    if (g) geo = g.toUpperCase();
  }

  return { name: rawName, slug, network, verticals, geo };
}

export function shouldSkip(offer: AffplusOffer): boolean {
  for (const v of offer.verticals) {
    if (SKIP_VERTICALS.has(v.toLowerCase())) return true;
  }
  return false;
}

export interface ListingResult {
  offers: AffplusOffer[]; // post-skip-list
  skippedCount: number;
  pagesFetched: number;
}

/**
 * Fetch and parse one platform listing, paginating up to `maxPages` pages
 * at human pace (jittered delay between pages).
 *
 * onLog receives status messages for the job log.
 */
export async function listOffers(opts: {
  platform: Platform;
  geo?: string | null;
  maxPages?: number;
  onLog?: (msg: string) => void;
}): Promise<ListingResult> {
  const platform = opts.platform;
  const geo = opts.geo || null;
  const maxPages = opts.maxPages ?? 3;
  const log_ = opts.onLog ?? (() => {});

  // The mobile skip-list drops exactly the verticals the web/CPS path wants
  // (crypto, forex, finance, ecommerce, leadgen, survey, cps, ...). In Web mode
  // it is bypassed; webPolicy.verticalDecision + the resolver are the filters.
  const isWeb = platform === 'Web';

  const allOffers: AffplusOffer[] = [];
  let skippedCount = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSearchUrl(platform, page, geo);
    log_(`affplus: GET ${url}`);
    const html = await fetchHtml(url);
    if (!html) {
      log_(`affplus: page ${page} fetch failed, stopping`);
      break;
    }
    pagesFetched++;
    const cards = splitCards(html);
    log_(`affplus: page ${page} → ${cards.length} cards`);

    let acceptedOnPage = 0;
    let skippedOnPage = 0;
    for (const c of cards) {
      const offer = parseCard(c);
      if (!offer) continue;
      if (!isWeb && shouldSkip(offer)) {
        skippedCount++;
        skippedOnPage++;
        continue;
      }
      allOffers.push(offer);
      acceptedOnPage++;
    }
    log_(`affplus: page ${page} → +${acceptedOnPage} kept, ${skippedOnPage} skipped (skip-list)`);

    // Stop early if a page has fewer than ~10 cards (likely end of results).
    if (cards.length < 10) {
      log_(`affplus: page ${page} thin (${cards.length} cards), stopping pagination`);
      break;
    }

    // Human pace between pages
    if (page < maxPages) await sleep(1500 + Math.random() * 1500);
  }

  return { offers: allOffers, skippedCount, pagesFetched };
}