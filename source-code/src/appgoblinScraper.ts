/**
 * AppGoblin scraper — discovers apps by category and/or ad-network using
 * appgoblin.info's /__data.json endpoints. Plain fetch, no browser.
 *
 * Two discovery axes:
 *
 *   1. CATEGORY-ONLY job:
 *        - Fetch /companies/types/ad-networks/<category>/__data.json
 *          → ranked list of ad-network companies operating in this category.
 *        - For each top-N company, fetch /companies/<domain>/__data.json
 *          → top-10 iOS + top-10 Android apps (=20 apps per company).
 *        - Dedupe by store_id.
 *
 *   2. CATEGORY + AD-NETWORK FILTER job:
 *        - If the operator picked a SPECIFIC ad-network domain (e.g.
 *          "appsflyer.com"), skip the category-discovery step and go
 *          directly to /companies/<adNetwork>/__data.json. The result is
 *          "apps using <ad-network>". Category is informational only here
 *          (the company's top-apps list isn't category-scoped at the API
 *          layer; the category-name itself is recorded in the job log).
 *
 * All AppGoblin pages are SvelteKit-rendered; appending /__data.json to any
 * page URL returns the page's resolved data. Free, no key.
 *
 * Bounded politely: at most COMPANIES_PER_JOB company-pages fetched per
 * job, with a small delay between fetches.
 */

import { log } from './logger.js';
import {
  decodePayload,
  extractCompanyApps,
  extractCategoryCompanies,
  extractCategoryList,
  type SvelteKitDataPayload,
  type AppgoblinApp,
  type AppgoblinCompany,
  type AppgoblinCategory,
} from './appgoblinDecoder.js';

const BASE = 'https://appgoblin.info';
const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/javascript,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Default budgets. Operator can override via env in extreme cases.
const COMPANIES_PER_JOB = Number(process.env.APPGOBLIN_COMPANIES_PER_JOB) || 10;
const FETCH_DELAY_MS = Number(process.env.APPGOBLIN_FETCH_DELAY_MS) || 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AppgoblinScrapeOptions {
  /** AppGoblin category slug, e.g. "game_casino". Required for category-only mode. */
  category?: string | null;
  /** Optional ad-network filter. When set as a DOMAIN (e.g. "appsflyer.com"),
   * the scraper jumps straight to that company page and returns its top apps
   * — i.e. "apps using <ad-network>". The category, if also set, is captured
   * in the job log for the operator's reference. */
  adNetworkDomain?: string | null;
  /** Max number of company pages to fetch in a category-mode job. */
  companiesLimit?: number;
  onLog?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
}

export interface AppgoblinScrapeResult {
  apps: AppgoblinApp[];
  companiesFetched: number;
  blocked: boolean;
  notes: string[];
}

async function fetchJson(url: string, label: string, onLog?: AppgoblinScrapeOptions['onLog']): Promise<SvelteKitDataPayload | null> {
  try {
    onLog?.('debug', `appgoblin fetch: ${label} → ${url}`);
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status === 403) {
      onLog?.('warn', `appgoblin: HTTP ${res.status} on ${label} — blocked/rate-limited`);
      return null;
    }
    if (!res.ok) {
      onLog?.('warn', `appgoblin: HTTP ${res.status} on ${label}`);
      return null;
    }
    const json = (await res.json()) as SvelteKitDataPayload;
    if (!json || !Array.isArray(json.nodes)) {
      onLog?.('warn', `appgoblin: payload at ${label} missing nodes`);
      return null;
    }
    return json;
  } catch (err) {
    onLog?.('warn', `appgoblin: fetch error on ${label}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch the AppGoblin category list. We pick the "all" overview page which
 * embeds appCats.categories. Returns the real, current category slugs —
 * never hardcoded beyond what the site exposes.
 *
 * Cached in-process so repeated New Job loads don't hit AppGoblin for every
 * mount.
 */
let categoryCache: AppgoblinCategory[] | null = null;
let categoryCacheAt = 0;
const CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export async function fetchAppgoblinCategoryList(
  onLog?: AppgoblinScrapeOptions['onLog'],
): Promise<AppgoblinCategory[]> {
  const now = Date.now();
  if (categoryCache && now - categoryCacheAt < CATEGORY_CACHE_TTL_MS) {
    return categoryCache;
  }
  // game_casino is a known-working page; its appCats list is the full real
  // list (any AppGoblin page embeds it). If this 404s in the future we can
  // pivot to /companies/types/ad-networks/all/__data.json.
  const url = `${BASE}/companies/types/ad-networks/game_casino/__data.json`;
  const payload = await fetchJson(url, 'category-list-seed', onLog);
  if (!payload) return [];
  const cats = extractCategoryList(payload);
  if (cats.length > 0) {
    categoryCache = cats;
    categoryCacheAt = now;
  }
  return cats;
}

/**
 * Main scrape entry point.
 */
export async function scrapeAppgoblin(opts: AppgoblinScrapeOptions): Promise<AppgoblinScrapeResult> {
  const onLog = opts.onLog;
  const out: AppgoblinScrapeResult = {
    apps: [],
    companiesFetched: 0,
    blocked: false,
    notes: [],
  };
  const seenIds = new Set<string>();

  // ── Path A: ad-network domain supplied → fetch that company directly ──
  if (opts.adNetworkDomain && opts.adNetworkDomain.trim()) {
    const domain = opts.adNetworkDomain.trim().toLowerCase();
    if (opts.category) {
      out.notes.push(`category=${opts.category} (informational; ad-network domain mode is API-wide)`);
      onLog?.('info', `appgoblin: ad-network mode for ${domain} (category ${opts.category} noted but API returns company-wide top apps)`);
    } else {
      onLog?.('info', `appgoblin: ad-network mode for ${domain}`);
    }
    const url = `${BASE}/companies/${encodeURIComponent(domain)}/__data.json`;
    const payload = await fetchJson(url, `company/${domain}`, onLog);
    if (!payload) {
      out.blocked = true;
      out.notes.push(`fetch failed for company/${domain}`);
      return out;
    }
    const apps = extractCompanyApps(payload);
    for (const a of apps) {
      const key = `${a.store}|${a.store_id}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      out.apps.push(a);
    }
    out.companiesFetched = 1;
    onLog?.('info', `appgoblin: ${domain} → ${out.apps.length} apps`);
    return out;
  }

  // ── Path B: category supplied → discover top companies, then iterate ──
  if (!opts.category || !opts.category.trim()) {
    throw new Error('AppGoblin scrape: either category or adNetworkDomain is required');
  }
  const cat = opts.category.trim();
  const limit = opts.companiesLimit ?? COMPANIES_PER_JOB;
  onLog?.('info', `appgoblin: category mode "${cat}", up to ${limit} top companies`);

  const catUrl = `${BASE}/companies/types/ad-networks/${encodeURIComponent(cat)}/__data.json`;
  const catPayload = await fetchJson(catUrl, `category/${cat}`, onLog);
  if (!catPayload) {
    out.blocked = true;
    out.notes.push(`fetch failed for category/${cat}`);
    return out;
  }
  const companies = extractCategoryCompanies(catPayload);
  if (companies.length === 0) {
    out.notes.push(`category "${cat}" returned 0 companies (check slug)`);
    return out;
  }
  onLog?.('info', `appgoblin: category "${cat}" → ${companies.length} total companies, fetching top ${limit}`);

  const top = companies.slice(0, limit);
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const url = `${BASE}/companies/${encodeURIComponent(c.company_domain)}/__data.json`;
    const payload = await fetchJson(url, `company/${c.company_domain}`, onLog);
    if (!payload) {
      out.blocked = true;
      out.notes.push(`fetch failed for company/${c.company_domain}`);
      continue;
    }
    const apps = extractCompanyApps(payload);
    let added = 0;
    for (const a of apps) {
      const key = `${a.store}|${a.store_id}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      out.apps.push(a);
      added++;
    }
    out.companiesFetched++;
    onLog?.('info', `appgoblin: ${c.company_domain} → +${added} new apps (total ${out.apps.length})`);
    if (i < top.length - 1) await sleep(FETCH_DELAY_MS + Math.random() * 300);
  }

  return out;
}

// Re-export the types so the pipeline can consume them.
export type { AppgoblinApp, AppgoblinCompany, AppgoblinCategory };
export { decodePayload };