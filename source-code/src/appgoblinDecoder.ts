/**
 * AppGoblin /__data.json decoder.
 *
 * AppGoblin is a SvelteKit site (appgoblin.info). EVERY page exposes its
 * fully-resolved server data as JSON by appending /__data.json to the page
 * URL. No account, no key, no rate-limit signaling. Effectively a free API.
 *
 * Wire format ("devalue"):
 *   {
 *     "type":"data",
 *     "nodes":[
 *       { "type":"data", "data":[<flat array>], "uses": {...} },
 *       ...one node per page layout level...
 *     ]
 *   }
 *
 * Inside each node.data array:
 *   - data[0] is the root value.
 *   - For objects/arrays: every value that is a number is an INDEX into
 *     the data array (deref via data[idx]).
 *   - Primitives (strings, real numbers, booleans, null) sit at their own
 *     index; objects/arrays sit at their own index too.
 *   - Negative numbers are sentinels: -1=undefined, -2=hole, -3=NaN,
 *     -4=+Inf, -5=-Inf, -6=-0.
 *
 * This decoder ignores devalue's typed-wrapper objects (Set, Map, Date,
 * RegExp, BigInt) — they don't appear in AppGoblin's payloads in practice
 * and would only show up as objects with sentinel keys. If we ever hit
 * one we just return it verbatim, which is safe enough.
 *
 * Two extractors are provided:
 *
 *   extractCompanyApps()  — for /companies/<domain>/__data.json. Returns
 *                           the top-10 iOS + top-10 Android apps for that
 *                           company (publisher OR ad-network).
 *
 *   extractCategoryCompanies()  — for /companies/types/ad-networks/<cat>/__data.json.
 *                           Returns the ranked list of ad-network companies
 *                           operating in that category. These domains are
 *                           the input to extractCompanyApps() in a category job.
 *
 *   extractCategoryList()  — extract the FULL list of real category slugs
 *                           from any AppGoblin page (it's embedded in every
 *                           page's appCats node). Used to populate the UI's
 *                           category picker without hardcoding.
 */

import { log } from './logger.js';

// ─── Devalue decoder ────────────────────────────────────────────────────

export function devalueParse(pool: unknown[]): unknown {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const seen = new Map<number, unknown>();
  function deref(idx: unknown): unknown {
    if (idx === -1) return undefined;
    if (idx === -2) return undefined; // hole
    if (idx === -3) return NaN;
    if (idx === -4) return Infinity;
    if (idx === -5) return -Infinity;
    if (idx === -6) return -0;
    if (typeof idx !== 'number') return idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= pool.length) return idx;
    if (seen.has(idx)) return seen.get(idx);
    const raw = pool[idx];
    if (raw === null) { seen.set(idx, null); return null; }
    if (typeof raw !== 'object') { seen.set(idx, raw); return raw; }
    if (Array.isArray(raw)) {
      const out: unknown[] = [];
      seen.set(idx, out);
      for (const v of raw) out.push(typeof v === 'number' ? deref(v) : v);
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(idx, out);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = typeof v === 'number' ? deref(v) : v;
    }
    return out;
  }
  return deref(0);
}

export interface SvelteKitDataPayload {
  type: string;
  nodes: Array<{ type?: string; data?: unknown[] } | null>;
}

/** Decode every data-bearing node in a /__data.json payload. */
export function decodePayload(payload: SvelteKitDataPayload): Array<Record<string, unknown> | null> {
  if (!payload || !Array.isArray(payload.nodes)) return [];
  return payload.nodes.map((node) => {
    if (!node || node.type !== 'data' || !Array.isArray(node.data)) return null;
    try {
      const root = devalueParse(node.data);
      return (root && typeof root === 'object' && !Array.isArray(root)) ? (root as Record<string, unknown>) : null;
    } catch (err) {
      log.warn(`appgoblinDecoder: node decode failed: ${(err as Error).message}`);
      return null;
    }
  });
}

/** Find the first decoded node containing a given top-level key. */
export function findNodeWithKey(
  nodes: Array<Record<string, unknown> | null>,
  key: string,
): Record<string, unknown> | null {
  for (const n of nodes) {
    if (n && key in n) return n;
  }
  return null;
}

// ─── App record types ───────────────────────────────────────────────────

export interface AppgoblinApp {
  company_domain: string;
  store: 'Apple App Store' | 'Google Play' | string;
  name: string;
  store_id: string;
  developer_name: string;
  icon_url_100?: string;
  rank?: number;
  installs_d30?: number;
  sdk?: boolean;
  publisher?: boolean;
  app_ads_direct?: boolean;
  rating?: number;
  installs?: number;
  rating_count?: number;
  store_link: string;
}

export interface AppgoblinCompany {
  company_name: string;
  company_domain: string;
  parent_company_name?: string;
  parent_company_domain?: string;
  /** Combined "weight" across SDK/app-ads counts. Used to rank. */
  totalAppCount: number;
}

export interface AppgoblinCategory {
  id: string;
  name: string;
  type: string;
  android: number;
  ios: number;
  total_apps: number;
}

// ─── Extractors ─────────────────────────────────────────────────────────

/**
 * Extract apps from a decoded /companies/<domain>/__data.json payload.
 * Returns iOS apps followed by Android apps, all deduped by store_id.
 */
export function extractCompanyApps(payload: SvelteKitDataPayload): AppgoblinApp[] {
  const decoded = decodePayload(payload);
  const node = findNodeWithKey(decoded, 'companyTopApps');
  if (!node) return [];
  const tops = node.companyTopApps as { ios?: { apps?: unknown[] }; android?: { apps?: unknown[] } } | undefined;
  if (!tops) return [];

  const out: AppgoblinApp[] = [];
  const seen = new Set<string>();
  for (const platform of ['ios', 'android'] as const) {
    const apps = tops[platform]?.apps;
    if (!Array.isArray(apps)) continue;
    for (const raw of apps) {
      const app = coerceApp(raw);
      if (!app) continue;
      const key = `${app.store}|${app.store_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(app);
    }
  }
  return out;
}

/**
 * Extract the ranked company list from a decoded
 * /companies/types/ad-networks/<category>/__data.json payload. Sorted by
 * total app count desc (Google/AppsFlyer/Unity etc. at the top).
 */
export function extractCategoryCompanies(payload: SvelteKitDataPayload): AppgoblinCompany[] {
  const decoded = decodePayload(payload);
  const node = findNodeWithKey(decoded, 'companiesOverview');
  if (!node) return [];
  const overview = node.companiesOverview as { companies_overview?: unknown[] } | undefined;
  const rows = overview?.companies_overview;
  if (!Array.isArray(rows)) return [];

  const out: AppgoblinCompany[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.company_name === 'string' ? r.company_name : '';
    const domain = typeof r.company_domain === 'string' ? r.company_domain : '';
    if (!domain) continue;
    // Sum the app-count fields we care about. Some are null.
    const fields = [
      'apple_sdk_app_count',
      'google_sdk_app_count',
      'apple_app_ads_direct_app_count',
      'google_app_ads_direct_app_count',
      'apple_api_call_app_count',
      'google_api_call_app_count',
    ];
    let total = 0;
    for (const f of fields) {
      const v = r[f];
      if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    out.push({
      company_name: name,
      company_domain: domain,
      parent_company_name: typeof r.parent_company_name === 'string' ? r.parent_company_name : undefined,
      parent_company_domain: typeof r.parent_company_domain === 'string' ? r.parent_company_domain : undefined,
      totalAppCount: total,
    });
  }
  out.sort((a, b) => b.totalAppCount - a.totalAppCount);
  return out;
}

/**
 * Extract the AppGoblin category list (54 entries on the real site as of
 * the recon snapshot). Present on most pages as `appCats.categories`.
 */
export function extractCategoryList(payload: SvelteKitDataPayload): AppgoblinCategory[] {
  const decoded = decodePayload(payload);
  const node = findNodeWithKey(decoded, 'appCats');
  if (!node) return [];
  const obj = node.appCats as { categories?: unknown[] } | undefined;
  const cats = obj?.categories;
  if (!Array.isArray(cats)) return [];
  const out: AppgoblinCategory[] = [];
  for (const raw of cats) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    if (!id) continue;
    out.push({
      id,
      name: typeof r.name === 'string' ? r.name : id,
      type: typeof r.type === 'string' ? r.type : '',
      android: typeof r.android === 'number' ? r.android : 0,
      ios: typeof r.ios === 'number' ? r.ios : 0,
      total_apps: typeof r.total_apps === 'number' ? r.total_apps : 0,
    });
  }
  return out;
}

function coerceApp(raw: unknown): AppgoblinApp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const storeLink = typeof r.store_link === 'string' ? r.store_link : '';
  const storeId = typeof r.store_id === 'string' ? r.store_id : '';
  const name = typeof r.name === 'string' ? r.name : '';
  if (!storeLink || !storeId || !name) return null;
  return {
    company_domain: typeof r.company_domain === 'string' ? r.company_domain : '',
    store: typeof r.store === 'string' ? r.store : '',
    name,
    store_id: storeId,
    developer_name: typeof r.developer_name === 'string' ? r.developer_name : '',
    icon_url_100: typeof r.icon_url_100 === 'string' ? r.icon_url_100 : undefined,
    rank: typeof r.rank === 'number' ? r.rank : undefined,
    installs_d30: typeof r.installs_d30 === 'number' ? r.installs_d30 : undefined,
    sdk: typeof r.sdk === 'boolean' ? r.sdk : undefined,
    publisher: typeof r.publisher === 'boolean' ? r.publisher : undefined,
    app_ads_direct: typeof r.app_ads_direct === 'boolean' ? r.app_ads_direct : undefined,
    rating: typeof r.rating === 'number' ? r.rating : undefined,
    installs: typeof r.installs === 'number' ? r.installs : undefined,
    rating_count: typeof r.rating_count === 'number' ? r.rating_count : undefined,
    store_link: storeLink,
  };
}

// ─── Unit tests (run against committed fixtures) ────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.resolve('artifacts/api-server/fixtures');
const COMPANY_FIXTURE = path.join(FIXTURE_DIR, 'appgoblin_company_appsflyer.json');
const CATEGORY_FIXTURE = path.join(FIXTURE_DIR, 'appgoblin_category_game_casino.json');

export function runAppgoblinDecoderUnitTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  // Devalue smoke test on synthetic data
  {
    // pool: [{a:1,b:2}, "hello", 42]  → root is data[0] = {a: data[1]=...} but here we mean indices
    // Make a small mock: data[0]={x:1,y:2}, data[1]="alpha", data[2]={inner:3}, data[3]="beta"
    const pool: unknown[] = [
      { x: 1, y: 2 },        // 0: root
      'alpha',               // 1
      { inner: 3 },          // 2
      'beta',                // 3
    ];
    const got = devalueParse(pool);
    const expected = { x: 'alpha', y: { inner: 'beta' } };
    if (JSON.stringify(got) === JSON.stringify(expected)) passed++;
    else failures.push(`devalueParse mock: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  }

  // Cycles handled
  {
    // Self-reference: a={loop:a}
    const pool: unknown[] = [{ loop: 0 }];
    const got = devalueParse(pool) as { loop: unknown };
    if (got && got.loop === got) passed++;
    else failures.push(`devalueParse cycle: cycle not preserved`);
  }

  // Negative sentinels
  {
    const pool: unknown[] = [{ a: -1, b: -2, c: -3 }];
    const got = devalueParse(pool) as { a: unknown; b: unknown; c: unknown };
    if (got.a === undefined && got.b === undefined && Number.isNaN(got.c as number)) passed++;
    else failures.push(`devalueParse sentinels: got ${JSON.stringify(got)}`);
  }

  // Real fixtures (only if present)
  if (existsSync(COMPANY_FIXTURE)) {
    const payload = JSON.parse(readFileSync(COMPANY_FIXTURE, 'utf8')) as SvelteKitDataPayload;
    const apps = extractCompanyApps(payload);
    if (apps.length >= 10) passed++;
    else failures.push(`extractCompanyApps: got ${apps.length} apps (expected ≥10)`);

    if (apps.length > 0) {
      const a = apps[0];
      if (a.store_link && /apps\.apple\.com|play\.google\.com/.test(a.store_link)) passed++;
      else failures.push(`first app store_link malformed: ${a.store_link}`);
      if (a.store_id) passed++;
      else failures.push(`first app store_id empty`);
      if (a.developer_name) passed++;
      else failures.push(`first app developer_name empty`);
      if (a.company_domain) passed++;
      else failures.push(`first app company_domain empty`);
      if (a.name) passed++;
      else failures.push(`first app name empty`);
    }
  } else {
    failures.push(`company fixture missing: ${COMPANY_FIXTURE}`);
  }

  if (existsSync(CATEGORY_FIXTURE)) {
    const payload = JSON.parse(readFileSync(CATEGORY_FIXTURE, 'utf8')) as SvelteKitDataPayload;
    const companies = extractCategoryCompanies(payload);
    if (companies.length >= 50) passed++;
    else failures.push(`extractCategoryCompanies: got ${companies.length} (expected ≥50)`);
    const cats = extractCategoryList(payload);
    if (cats.length >= 40) passed++;
    else failures.push(`extractCategoryList: got ${cats.length} (expected ≥40 real categories)`);
    const hasGameCasino = cats.some((c) => c.id === 'game_casino');
    if (hasGameCasino) passed++;
    else failures.push(`extractCategoryList: 'game_casino' missing from category list`);
  } else {
    failures.push(`category fixture missing: ${CATEGORY_FIXTURE}`);
  }

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('appgoblinDecoder.js') || process.argv[1].endsWith('appgoblinDecoder.ts'));
if (isMain) {
  const { passed, failed, failures } = runAppgoblinDecoderUnitTests();
  console.log(`appgoblinDecoder unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}