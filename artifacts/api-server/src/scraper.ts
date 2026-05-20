import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { log } from './logger.js';
import { browserSpawnEnv } from './browserSetup.js';

export interface RawAd {
  advertiser_name: string;
  page_url: string | null;
  landing_url: string | null;
  ad_text: string | null;
  country: string;
}

const ACTION_DELAY = Number(process.env.SCRAPE_ACTION_DELAY_MS) || 2500;
const MAX_PAGES = Number(process.env.MAX_PAGES_PER_QUERY) || 5;

function jitter(baseMs: number): number {
  // ±50% random
  return Math.round(baseMs * (0.5 + Math.random()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildAdLibraryUrl(country: string, keyword: string): string {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: country.toUpperCase(),
    q: keyword,
    search_type: 'keyword_unordered',
    media_type: 'all',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  // Pass env explicitly so the LD_LIBRARY_PATH we set in browserSetup.ts
  // reaches the chromium child process. Node's default child env is
  // process.env, but being explicit here defends against any Playwright
  // internal env scrubbing.
  sharedBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    env: browserSpawnEnv(),
  });
  return sharedBrowser;
}

export async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  // Strip the most obvious automation tell
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return ctx;
}

/**
 * Scrape the Ad Library for one (country, keyword) pair.
 * Returns deduped raw ads (advertiser-level dedup happens upstream in the queue).
 */
export async function scrapeQuery(
  country: string,
  keyword: string,
  onLog: (msg: string) => void
): Promise<RawAd[]> {
  const ctx = await newContext();
  const page = await ctx.newPage();
  const url = buildAdLibraryUrl(country, keyword);

  const results: RawAd[] = [];

  try {
    onLog(`open ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(jitter(ACTION_DELAY));

    // Dismiss any cookie/login overlays
    await dismissOverlays(page);

    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      await sleep(jitter(ACTION_DELAY));

      const adsOnPage = await extractAdsFromDom(page, country);
      onLog(`page ${pageIdx + 1}: ${adsOnPage.length} ads`);
      results.push(...adsOnPage);

      // Scroll for more
      const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await sleep(jitter(ACTION_DELAY));
      const afterHeight = await page.evaluate(() => document.body.scrollHeight);
      if (afterHeight <= beforeHeight) {
        onLog(`page ${pageIdx + 1}: no more results, stopping`);
        break;
      }
    }
  } catch (err) {
    log.error(`scrape failed for ${country}/${keyword}`, err);
    onLog(`error: ${(err as Error).message}`);
  } finally {
    await ctx.close();
  }

  return results;
}

async function dismissOverlays(page: Page) {
  try {
    // Common cookie-accept buttons on Meta surfaces
    const candidates = [
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept all")',
      'div[aria-label="Allow all cookies"]',
      'div[aria-label="Decline optional cookies"]',
    ];
    for (const sel of candidates) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Extracts ad cards from the current Ad Library DOM.
 * NOTE: Meta's class names are obfuscated and change. This selector strategy
 * targets stable structural cues: each ad card is a child of a result list
 * container, has an "Library ID" label, and a link to fbclid-tracked landing.
 *
 * If this breaks, the right fix is to update the selectors in this single fn.
 */
async function extractAdsFromDom(page: Page, country: string): Promise<RawAd[]> {
  return await page.evaluate((cc: string) => {
    function getAdvertiserName(card: Element): string | null {
      // Advertiser name is usually an <a> with bold text near the top of the card
      const candidates = card.querySelectorAll('a[role="link"] span');
      for (const span of Array.from(candidates)) {
        const t = (span.textContent || '').trim();
        if (t.length > 0 && t.length < 80 && !t.startsWith('Library ID') && !t.includes('Sponsored')) {
          return t;
        }
      }
      return null;
    }
    function getPageUrl(card: Element): string | null {
      const a = card.querySelector('a[href*="/ads/library/?view_all_page_id="]') as HTMLAnchorElement | null;
      return a?.href || null;
    }
    function getLandingUrl(card: Element): string | null {
      // CTA link — usually has rel="nofollow" and target="_blank"
      const links = card.querySelectorAll('a[href]') as NodeListOf<HTMLAnchorElement>;
      for (const a of Array.from(links)) {
        const href = a.href || '';
        if (
          href &&
          !href.includes('facebook.com') &&
          !href.startsWith('javascript:') &&
          !href.startsWith('mailto:')
        ) {
          return href;
        }
        // Facebook wraps external links in l.facebook.com redirect — capture the underlying u param
        if (href.includes('l.facebook.com/l.php')) {
          try {
            const u = new URL(href).searchParams.get('u');
            if (u) return decodeURIComponent(u);
          } catch {
            /* ignore */
          }
        }
      }
      return null;
    }
    function getAdText(card: Element): string | null {
      // Ad copy is in a div with role="presentation" or the longest text node
      const textNodes = Array.from(card.querySelectorAll('div')).map((d) => (d.textContent || '').trim());
      const longest = textNodes.sort((a, b) => b.length - a.length)[0];
      return longest && longest.length > 30 ? longest.slice(0, 1200) : null;
    }

    // Cards: divs containing the text "Library ID"
    const allDivs = Array.from(document.querySelectorAll('div'));
    const cards = allDivs.filter((d) => {
      const t = d.textContent || '';
      return /Library ID:\s*\d/.test(t) && d.querySelectorAll('div').length < 200;
    });

    // Dedup: pick the smallest containing card for each Library ID
    const byId = new Map<string, Element>();
    for (const c of cards) {
      const m = (c.textContent || '').match(/Library ID:\s*(\d+)/);
      if (!m) continue;
      const id = m[1];
      const existing = byId.get(id);
      if (!existing || c.querySelectorAll('div').length < existing.querySelectorAll('div').length) {
        byId.set(id, c);
      }
    }

    const results: RawAd[] = [];
    for (const card of byId.values()) {
      const advertiser_name = getAdvertiserName(card);
      if (!advertiser_name) continue;
      results.push({
        advertiser_name,
        page_url: getPageUrl(card),
        landing_url: getLandingUrl(card),
        ad_text: getAdText(card),
        country: cc,
      });
    }
    return results;
  }, country);
}