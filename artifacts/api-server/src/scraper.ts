import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { log } from './logger.js';
import { browserSpawnEnv, browserExecutablePath } from './browserSetup.js';

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
  //
  // Pass executablePath explicitly so we use the binary that browserSetup.ts
  // resolved AND patchelf'd at startup. Without this, Playwright's auto-
  // discovery can pick a different (unpatched, or missing) location based
  // on PLAYWRIGHT_BROWSERS_PATH state — in deploy contexts this has been
  // seen to fall through to ~/.cache/ms-playwright/ which is empty.
  const executablePath = browserExecutablePath();
  if (executablePath) {
    log.info(`scraper: launching chromium at ${executablePath}`);
  } else {
    log.warn('scraper: no resolved chromium path, falling back to Playwright auto-discovery');
  }
  sharedBrowser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    env: browserSpawnEnv(),
    ...(executablePath ? { executablePath } : {}),
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
 * Extract ad cards from the Ad Library DOM.
 *
 * Card structure (verified live 2026-05-20 against US "mobile game" query):
 *
 *   - Each card is the smallest DOM ancestor that contains BOTH a
 *     "Library ID: <digits>" leaf AND a "Sponsored" leaf (~150-200
 *     descendant elements).
 *
 *   - Advertiser name + page URL: first <a> in the card whose href is
 *     of the form facebook.com/<page-id-or-handle>/ (NOT a
 *     /ads/library/?view_all_page_id=... link, which sometimes is also
 *     present but isn't always the primary). Its visible text is the
 *     advertiser name.
 *
 *   - Store URL (CRITICAL): the card holds an <a> whose href is
 *     `https://l.facebook.com/l.php?u=<url-encoded store URL>&h=...`.
 *     The `u` parameter decodes to a real play.google.com or
 *     itunes.apple.com / apps.apple.com URL. This is what the previous
 *     extractor missed — it rejected anything containing "facebook.com"
 *     before checking the redirect form, so the store URL never flowed
 *     through to the classifier and every mobile row was dropped at
 *     CSV time.
 *
 *   - Ad copy: a leaf text node inside the card, longer than 30 chars
 *     and not matching the metadata-block patterns (Library ID, dates,
 *     platform labels, durations, "Sponsored", "Active", etc.).
 *
 * Dedup by Library ID. Cards without an advertiser name are skipped.
 */
async function extractAdsFromDom(page: Page, country: string): Promise<RawAd[]> {
  // The page.evaluate is passed as a STRING to avoid tsx codegen helpers
  // (__name, etc.) being injected into the compiled function body — those
  // helpers reference module-scope vars that don't exist in the page context
  // and cause a ReferenceError at runtime.
  return await page.evaluate(
    `(({ cc }) => {
      function decodeFbRedirect(href) {
        try {
          const u = new URL(href);
          if (u.hostname === 'l.facebook.com' || u.hostname.endsWith('.l.facebook.com')) {
            const real = u.searchParams.get('u');
            if (real) return decodeURIComponent(real);
          }
          return href;
        } catch {
          return href;
        }
      }
      function isStoreUrl(href) {
        return /play\\.google\\.com\\/store\\/apps\\/details/i.test(href)
          || /itunes\\.apple\\.com\\/app/i.test(href)
          || /apps\\.apple\\.com\\//i.test(href);
      }
      function isPageUrl(href) {
        try {
          const u = new URL(href);
          if (u.hostname !== 'www.facebook.com' && u.hostname !== 'facebook.com') return false;
          if (u.pathname.startsWith('/ads/')) return false;
          if (u.pathname.startsWith('/l.php')) return false;
          // /<single-segment>/ shape (numeric page id or handle)
          return /^\\/[^\\/]+\\/?$/.test(u.pathname);
        } catch {
          return false;
        }
      }

      const META_RES = [
        /^Library ID:/,
        /^Started running/,
        /^Platforms$/,
        /^Sponsored$/,
        /^Active$/,
        /^Inactive$/,
        /^\\d+\\s+ads?$/,
        /^See summary details$/,
        /^Open Drop-down$/,
        /^Open$/,
        /^Like$/,
        /^Comment$/,
        /^Share$/,
        /^\\d+:\\d+$/,
        /^\\/$/,
        /^​$/,
        /^This ad has multiple versions/,
      ];
      function isMetaText(t) {
        for (const re of META_RES) if (re.test(t)) return true;
        return false;
      }

      // 1) Find all "Library ID:" leaf texts.
      const allElts = Array.from(document.querySelectorAll('*'));
      const libIdLeaves = [];
      for (const e of allElts) {
        if (e.children.length !== 0) continue;
        const t = e.textContent || '';
        if (/Library ID:\\s*\\d+/.test(t)) libIdLeaves.push(e);
      }

      // 2) Climb each leaf to the smallest ancestor that ALSO contains "Sponsored".
      //    Dedup by Library ID.
      const cardByLibId = new Map();
      for (const leaf of libIdLeaves) {
        const m = (leaf.textContent || '').match(/Library ID:\\s*(\\d+)/);
        if (!m) continue;
        const libId = m[1];
        if (cardByLibId.has(libId)) continue;

        let cur = leaf;
        let card = null;
        for (let depth = 0; depth < 30 && cur.parentElement; depth++) {
          cur = cur.parentElement;
          if (cur === document.body) break;
          const t = cur.textContent || '';
          if (/Sponsored/.test(t)) { card = cur; break; }
        }
        if (card) cardByLibId.set(libId, card);
      }

      // 3) Extract per-card fields.
      const results = [];
      for (const card of cardByLibId.values()) {
        const anchors = Array.from(card.querySelectorAll('a[href]'));

        // advertiser_name + page_url: first anchor pointing at facebook.com/<id-or-handle>/
        // with non-empty visible text.
        let advertiser_name = null;
        let page_url = null;
        for (const a of anchors) {
          if (!isPageUrl(a.href)) continue;
          const text = (a.textContent || '').trim();
          if (text.length === 0 || text.length > 120) continue;
          if (isMetaText(text)) continue;
          advertiser_name = text;
          page_url = a.href;
          break;
        }
        // Fallback: view_all_page_id anchor (older Meta surfaces)
        if (!advertiser_name) {
          for (const a of anchors) {
            if (!a.href.includes('view_all_page_id=')) continue;
            const text = (a.textContent || '').trim();
            if (text.length === 0 || text.length > 120) continue;
            if (isMetaText(text)) continue;
            advertiser_name = text;
            page_url = a.href;
            break;
          }
        }
        if (!advertiser_name) continue;

        // landing_url: prefer store URL (decoded via l.facebook.com redirect),
        // fall back to first non-facebook external link.
        let landing_url = null;
        for (const a of anchors) {
          const decoded = decodeFbRedirect(a.href);
          if (isStoreUrl(decoded)) { landing_url = decoded; break; }
        }
        if (!landing_url) {
          for (const a of anchors) {
            const decoded = decodeFbRedirect(a.href);
            if (!decoded) continue;
            if (decoded.startsWith('javascript:')) continue;
            if (decoded.startsWith('mailto:')) continue;
            // Skip facebook.com internal links (page profile, ad library, etc.)
            try {
              const h = new URL(decoded).hostname;
              if (/(^|\\.)facebook\\.com$/.test(h)) continue;
              if (/(^|\\.)fb\\.com$/.test(h)) continue;
            } catch { continue; }
            landing_url = decoded;
            break;
          }
        }

        // ad_text: longest non-meta leaf >= 30 chars.
        let ad_text = null;
        let longest = '';
        for (const e of Array.from(card.querySelectorAll('*'))) {
          if (e.children.length !== 0) continue;
          const t = (e.textContent || '').trim();
          if (t.length < 30) continue;
          if (isMetaText(t)) continue;
          if (/^https?:\\/\\//.test(t)) continue;
          if (t.length > longest.length) longest = t;
        }
        if (longest.length >= 30) ad_text = longest.slice(0, 1500);

        results.push({
          advertiser_name,
          page_url,
          landing_url,
          ad_text,
          country: cc,
        });
      }

      return results;
    })({ cc: ${JSON.stringify(country)} })`
  ) as RawAd[];
}