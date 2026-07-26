import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import {
  createJob,
  getJob,
  listJobsForUser,
  listAllJobsWithUsers,
  requestJobCancel,
  getLogs,
  getResults,
  ProductType,
  JobSource,
} from './db.js';
import { buildCsv, normalizeMaxLeads, LEAD_LIMIT_CHOICES } from './csv.js';
import { RequestWithUser, requireAdmin, isAdminUser } from './auth.js';
import { fetchAppgoblinCategoryList } from './appgoblinScraper.js';
import {
  GOOGLE_ADS_VERTICALS,
  GOOGLE_ADS_LANGUAGES,
  keywordStats,
} from './googleAdsKeywords.js';
import {
  VERTICALS as STORE_VERTICALS,
  ALL_MARKETS as STORE_MARKETS,
  DEFAULT_ACTIVE_MARKETS,
  DEFAULT_ACTIVE_VERTICALS,
  VERTICAL_IDS as STORE_VERTICAL_IDS,
  PLAY_CHARTS,
  APPLE_CHARTS,
  TAIL_MIN_INSTALLS,
  TAIL_MAX_INSTALLS,
} from './storeDiscoveryConfig.js';
import {
  listPublishersByScore,
  discoveredCountsBySource,
  countDiscoveredApps,
  countEnrichedApps,
  countInBandApps,
  countPublishers,
  countConfirmedPublishers,
  type PublisherRow,
} from './storeDiscoveryDb.js';
import { publisherViewCsv } from './storeLeads.js';

export const jobsRouter: Router = Router();

const STORE_VERTICAL_ID_SET = new Set(STORE_VERTICAL_IDS);
const STORE_MARKET_SET = new Set(STORE_MARKETS as readonly string[]);

function jsonArr(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The spec step 15 filters (vertical, market, source, is_game, confirmed-only,
 * has-email-only, plus a free-text search), applied server-side over the WHOLE
 * publishers table. This is the single implementation for both the table and the
 * CSV export, so the download always matches the view. Unknown/absent params
 * mean "no filter".
 */
function filterPublishers(rows: PublisherRow[], q: Request['query']): PublisherRow[] {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const vertical = str(q.vertical);
  const market = str(q.market).toLowerCase();
  const source = str(q.source);
  const game = str(q.game); // 'games' | 'non-games' | ''
  const confirmedOnly = str(q.confirmed) === '1';
  const emailOnly = str(q.email) === '1';
  const search = str(q.q).toLowerCase();
  if (!vertical && !market && !source && !game && !confirmedOnly && !emailOnly && !search) return rows;

  return rows.filter((p) => {
    if (vertical && !jsonArr(p.verticals).includes(vertical)) return false;
    if (market) {
      const seen = jsonArr(p.countries_seen);
      const markets = seen.length ? seen : jsonArr(p.countries_charted);
      if (!markets.includes(market)) return false;
    }
    if (source) {
      let mix: Record<string, number> = {};
      try {
        mix = JSON.parse(p.source_mix) as Record<string, number>;
      } catch { /* treat as empty */ }
      if (!((mix[source] || 0) > 0)) return false;
    }
    if (game === 'games' && p.is_game_publisher !== 1) return false;
    if (game === 'non-games' && p.is_game_publisher === 1) return false;
    if (confirmedOnly && p.confirmed_advertiser !== 1) return false;
    if (emailOnly && !p.email) return false;
    if (search) {
      const hay = `${p.name} ${p.email || ''} ${p.website || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/** Shape a publishers row for the dashboard table (parse JSON, booleans). */
function publisherToDto(p: PublisherRow) {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    website: p.website,
    previewUrl: p.preview_url,
    previewTitle: p.preview_title,
    verticals: jsonArr(p.verticals),
    // Markets = every country the publisher's apps were SIGHTED in. Using only
    // countries_charted left tail-only publishers with an empty list, so the
    // Markets column showed "—" and any market filter silently dropped them.
    markets: jsonArr(p.countries_seen).length ? jsonArr(p.countries_seen) : jsonArr(p.countries_charted),
    marketsCharted: jsonArr(p.countries_charted),
    sourceMix: (() => {
      try {
        return JSON.parse(p.source_mix) as Record<string, number>;
      } catch {
        return {};
      }
    })(),
    chartedAppCount: p.charted_app_count,
    appCount: p.app_count,
    bestRank: p.best_rank,
    bothStores: p.both_stores === 1,
    inBand: p.in_band === 1,
    isCharted: p.is_charted === 1,
    gatcAdsCount: p.gatc_ads_count,
    gatcAdvertiserId: p.gatc_advertiser_id,
    metaActiveAds: p.meta_active_ads,
    confirmed: p.confirmed_advertiser === 1,
    isGame: p.is_game_publisher === 1,
    score: p.score,
  };
}

/**
 * Rows shipped to the Publishers table in one response. The table is polled every
 * 10s, so the payload has to be bounded — but `publishers` is a SHARED corpus
 * that no run ever prunes (one finance/us smoke alone rolled up 1,629 rows), so
 * a fixed page IS reachable in normal use.
 *
 * The cap is therefore applied LAST, after filtering and counting: the filters
 * and both totals below are computed over the FULL table. Filtering the capped
 * page instead made a filter answer "no publishers match" for publishers that
 * exist just below the cut by score, and made the header report the page size as
 * the total while the funnel widget on the same screen reported the real
 * countPublishers().
 */
const PUBLISHERS_PAGE_LIMIT = 5000;

interface PublishersPage {
  publishers: ReturnType<typeof publisherToDto>[];
  /** Publishers matching the active filters, across the whole table. */
  total: number;
  /** Publishers in the whole table, filters ignored — the honest grand total. */
  totalUnfiltered: number;
  /**
   * Options for the vertical/market dropdowns, derived from the UNFILTERED set:
   * built from the returned rows they would collapse to whatever is selected,
   * leaving no way back to the other values.
   */
  facets: { verticals: string[]; markets: string[] };
}

function buildPublishersPage(all: PublisherRow[], q: Request['query']): PublishersPage {
  const matched = filterPublishers(all, q);
  const verticals = new Set<string>();
  const markets = new Set<string>();
  for (const p of all) {
    for (const v of jsonArr(p.verticals)) if (v) verticals.add(v);
    // Same markets definition as publisherToDto: sighted countries, falling back
    // to charted ones, so the dropdown can never offer a value that filters to 0.
    const seen = jsonArr(p.countries_seen);
    for (const m of seen.length ? seen : jsonArr(p.countries_charted)) if (m) markets.add(m);
  }
  return {
    publishers: matched.slice(0, PUBLISHERS_PAGE_LIMIT).map(publisherToDto),
    total: matched.length,
    totalUnfiltered: all.length,
    facets: { verticals: [...verticals].sort(), markets: [...markets].sort() },
  };
}

interface GoogleAdsBody {
  verticals?: string[] | null;
  languages?: string[] | null;
  maxKeywords?: number | null;
  customKeywords?: string[] | null;
  region?: string | null;
}

interface StoreFirstBody {
  verticals?: string[] | null;
  markets?: string[] | null;
  similarMaxAppsPerRun?: number | null;
  searchTermsLimit?: number | null;
  confirmationMaxApiCalls?: number | null;
}

interface CreateJobBody {
  countries: string[];
  productTypes: ProductType[];
  /** Cap on exported leads (20/50/100); absent/null = as many as found. */
  maxLeads?: number | null;
  recipientEmail?: string | null;
  source?: JobSource;
  /** AppGoblin discovery params (only used when source='appgoblin'). */
  appgoblinCategory?: string | null;
  appgoblinAdNetwork?: string | null;
  /** Google Ads Transparency discovery params (only used when source='google_ads'). */
  googleAds?: GoogleAdsBody | null;
  /** Store-first discovery params (only used when source='store_first'). */
  storeFirst?: StoreFirstBody | null;
}

const KNOWN_VERTICAL_IDS = new Set(GOOGLE_ADS_VERTICALS.map((v) => v.id));
const KNOWN_LANG_CODES = new Set(GOOGLE_ADS_LANGUAGES.map((l) => l.code));

// POST /api/jobs
jobsRouter.post('/', (req: Request<{}, {}, CreateJobBody>, res: Response) => {
  const user = (req as RequestWithUser).user!;
  const { countries, productTypes, recipientEmail, source, appgoblinCategory, appgoblinAdNetwork, googleAds, storeFirst, maxLeads } = req.body;

  if (!Array.isArray(countries) || countries.length === 0) {
    return res.status(400).json({ error: 'countries[] required' });
  }
  if (!Array.isArray(productTypes) || productTypes.length === 0) {
    return res.status(400).json({ error: 'productTypes[] required' });
  }
  for (const pt of productTypes) {
    if (pt !== 'mobile' && pt !== 'cps') {
      return res.status(400).json({ error: `invalid productType: ${pt}` });
    }
  }
  const normCountries = countries.map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (normCountries.some((c) => c.length !== 2)) {
    return res.status(400).json({ error: 'country codes must be ISO 2-letter (e.g. US, BR, IN)' });
  }

  // Source: default to 'meta' to preserve existing behavior.
  let jobSource: JobSource = 'meta';
  if (source !== undefined) {
    if (
      source !== 'meta' &&
      source !== 'affplus' &&
      source !== 'appgoblin' &&
      source !== 'google_ads' &&
      source !== 'store_first'
    ) {
      return res.status(400).json({ error: `invalid source: ${source}` });
    }
    jobSource = source;
  }

  // AppGoblin and store-first are mobile-only. Affplus supports cps (web) too.
  if ((jobSource === 'appgoblin' || jobSource === 'store_first') && productTypes.some((pt) => pt !== 'mobile')) {
    return res.status(400).json({ error: `${jobSource} source supports productType=mobile only` });
  }
  // Google Ads Transparency is CPS-ONLY. Its advertiser search matches advertiser
  // names and verified domains, which resolves web/CPS advertisers well and
  // structurally cannot enumerate app advertisers — the reason mobile discovery
  // moved to the stores. The store_first source ("Google Ads - Mobile") is the
  // mobile path and runs its own transparency confirmation, so a GATC mobile job
  // is now strictly a slower, worse duplicate of it.
  if (jobSource === 'google_ads' && productTypes.some((pt) => pt !== 'cps')) {
    return res.status(400).json({
      error: 'google_ads source supports productType=cps only — use the "Google Ads - Mobile" source for apps',
    });
  }

  // AppGoblin needs at least one discovery axis.
  let sourceParams: Record<string, unknown> | null = null;
  if (jobSource === 'appgoblin') {
    const cat = (appgoblinCategory || '').trim() || null;
    const adn = (appgoblinAdNetwork || '').trim() || null;
    if (!cat && !adn) {
      return res.status(400).json({
        error: 'appgoblin jobs require appgoblinCategory and/or appgoblinAdNetwork',
      });
    }
    // Validate slug shapes loosely — AppGoblin slugs are [a-z0-9_], domains are
    // lower-case dotted hosts.
    if (cat && !/^[a-z0-9_]+$/.test(cat)) {
      return res.status(400).json({ error: 'appgoblinCategory must be lowercase letters/digits/underscores' });
    }
    if (adn && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(adn.toLowerCase())) {
      return res.status(400).json({ error: 'appgoblinAdNetwork must be a domain like "appsflyer.com"' });
    }
    sourceParams = {
      category: cat,
      adNetworkDomain: adn ? adn.toLowerCase() : null,
    };
  }

  // Google Ads Transparency discovery params. All fields optional — an empty
  // body runs the default multilingual keyword sample across all verticals.
  if (jobSource === 'google_ads') {
    const ga = googleAds || {};

    let verticals: string[] | null = null;
    if (Array.isArray(ga.verticals) && ga.verticals.length > 0) {
      verticals = ga.verticals.map((v) => String(v).trim()).filter(Boolean);
      const bad = verticals.find((v) => !KNOWN_VERTICAL_IDS.has(v));
      if (bad) return res.status(400).json({ error: `unknown google-ads vertical: ${bad}` });
    }

    let languages: string[] | null = null;
    if (Array.isArray(ga.languages) && ga.languages.length > 0) {
      languages = ga.languages.map((l) => String(l).trim()).filter(Boolean);
      const bad = languages.find((l) => !KNOWN_LANG_CODES.has(l));
      if (bad) return res.status(400).json({ error: `unknown google-ads language: ${bad}` });
    }

    let maxKeywords: number | null = null;
    if (ga.maxKeywords != null) {
      const n = Number(ga.maxKeywords);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ error: 'maxKeywords must be a positive integer' });
      }
      maxKeywords = Math.min(500, Math.floor(n)); // hard cap: 500 keywords/job
    }

    let customKeywords: string[] | null = null;
    if (Array.isArray(ga.customKeywords) && ga.customKeywords.length > 0) {
      const seen = new Set<string>();
      customKeywords = [];
      for (const raw of ga.customKeywords) {
        const k = String(raw).trim().slice(0, 100);
        if (!k) continue;
        const key = k.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        customKeywords.push(k);
        if (customKeywords.length >= 500) break; // hard cap
      }
      if (customKeywords.length === 0) customKeywords = null;
    }

    let region: string | null = null;
    if (ga.region != null && String(ga.region).trim()) {
      region = String(ga.region).trim().slice(0, 8);
    }

    sourceParams = { verticals, languages, maxKeywords, customKeywords, region };
  }

  // Store-first discovery params. All optional — an empty body runs the default
  // vertical (finance) across the default markets (us,gb,de).
  if (jobSource === 'store_first') {
    const sf = storeFirst || {};

    let verticals: string[] | null = null;
    if (Array.isArray(sf.verticals) && sf.verticals.length > 0) {
      verticals = sf.verticals.map((v) => String(v).trim()).filter(Boolean);
      const bad = verticals.find((v) => !STORE_VERTICAL_ID_SET.has(v));
      if (bad) return res.status(400).json({ error: `unknown store vertical: ${bad}` });
    }

    let markets: string[] | null = null;
    if (Array.isArray(sf.markets) && sf.markets.length > 0) {
      markets = sf.markets.map((m) => String(m).trim().toLowerCase()).filter(Boolean);
      const bad = markets.find((m) => !STORE_MARKET_SET.has(m));
      if (bad) return res.status(400).json({ error: `unknown store market: ${bad}` });
    }

    const posInt = (v: unknown, max: number): number | null => {
      if (v == null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.min(max, Math.floor(n));
    };

    sourceParams = {
      verticals,
      markets,
      similarMaxAppsPerRun: posInt(sf.similarMaxAppsPerRun, 50_000),
      searchTermsLimit: posInt(sf.searchTermsLimit, 15),
      confirmationMaxApiCalls: posInt(sf.confirmationMaxApiCalls, 10_000),
    };
  }

  // Operator-chosen lead cap (20/50/100, or absent = as many as found). Supported
  // by the two sources that routinely return hundreds of leads; stored on
  // sourceParams so each pipeline reads it the same way. Invalid/0/negative
  // normalizes to null (uncapped) rather than to an empty export.
  const leadCap = normalizeMaxLeads(maxLeads);
  if (leadCap != null && (jobSource === 'google_ads' || jobSource === 'store_first')) {
    sourceParams = { ...(sourceParams || {}), maxLeads: leadCap };
  }

  let recipient: string | null = null;
  if (recipientEmail && typeof recipientEmail === 'string') {
    const t = recipientEmail.trim();
    if (t && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
      return res.status(400).json({ error: 'invalid recipientEmail format' });
    }
    recipient = t || null;
  }

  const created = productTypes.map((pt) => {
    const id = `job_${nanoid(10)}`;
    return createJob({
      id,
      productType: pt,
      countries: normCountries,
      recipientEmail: recipient,
      createdByUserId: user.id,
      source: jobSource,
      sourceParams,
    });
  });

  res.json({ jobs: created });
});

jobsRouter.get('/', (req, res) => {
  const user = (req as RequestWithUser).user!;
  res.json({ jobs: listJobsForUser(user.id) });
});

// GET /api/jobs/activity — ADMIN ONLY: every user's jobs (running + history) with
// the creator's identity, for the Activity view. Defined BEFORE /:id so Express
// does not match "activity" as a job id.
jobsRouter.get('/activity', requireAdmin, (_req: Request, res: Response) => {
  res.json({ jobs: listAllJobsWithUsers(200) });
});

// POST /api/jobs/:id/stop — request a mid-run stop. The job's owner can stop
// their own job; an admin can stop anyone's. Partial results are kept: a pending
// job cancels instantly, a running one finishes its current step and finalizes
// with whatever it scraped so far.
jobsRouter.post('/:id/stop', (req, res) => {
  const user = (req as RequestWithUser).user!;
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.created_by_user_id && job.created_by_user_id !== user.id && !isAdminUser(user)) {
    return res.status(404).json({ error: 'not found' });
  }
  const ok = requestJobCancel(job.id);
  if (!ok) {
    return res.status(409).json({ error: `job is already ${job.status} — nothing to stop` });
  }
  res.json({ job: getJob(job.id) });
});

// GET /api/jobs/appgoblin-categories — list the real AppGoblin category slugs.
// Cached for 1h in the scraper module. Returns [{id,name,android,ios,total_apps}].
// Defined BEFORE /:id so Express does not match "appgoblin-categories" as an id.
jobsRouter.get('/appgoblin-categories', async (_req: Request, res: Response) => {
  try {
    const cats = await fetchAppgoblinCategoryList();
    res.json({ categories: cats });
  } catch (err) {
    res.status(502).json({ error: `appgoblin category fetch failed: ${(err as Error).message}` });
  }
});

// GET /api/jobs/google-ads-verticals — vertical + language metadata and the
// exemplar-bank size for the New Job form. Static (no network). Defined BEFORE
// /:id so Express does not match it as an id.
jobsRouter.get('/google-ads-verticals', (_req: Request, res: Response) => {
  const stats = keywordStats();
  res.json({
    verticals: GOOGLE_ADS_VERTICALS,
    languages: GOOGLE_ADS_LANGUAGES,
    stats: { total: stats.total, languages: stats.languages, verticals: stats.verticals },
  });
});

// GET /api/jobs/store-first-config — verticals + markets metadata and defaults
// for the New Job form's store-first panel. Static (no network). Before /:id.
jobsRouter.get('/store-first-config', (_req: Request, res: Response) => {
  res.json({
    verticals: STORE_VERTICALS.map((v) => ({ id: v.id, label: v.label })),
    markets: STORE_MARKETS,
    defaults: { verticals: DEFAULT_ACTIVE_VERTICALS, markets: DEFAULT_ACTIVE_MARKETS },
    charts: { play: PLAY_CHARTS, apple: APPLE_CHARTS },
    leadLimits: LEAD_LIMIT_CHOICES,
    installBand: { min: TAIL_MIN_INSTALLS, max: TAIL_MAX_INSTALLS },
  });
});

// GET /api/jobs/publishers — the primary store-first view data: the publisher
// table (score desc) plus the discovery-funnel widget counts. Before /:id so it
// isn't matched as an id.
//
// NOTE — visibility: this is GLOBAL, unlike /api/jobs and /api/jobs/:id which are
// scoped to created_by_user_id. That is deliberate: discovered_apps /
// store_app_detail / publishers are a SHARED corpus with no owner column, and the
// whole point is that every run enriches one accumulating graph (the enrichment
// cache, the publisher merge and the lead dedupe all depend on it being shared).
// ADMIN-ONLY since the UI simplification: the Publishers view is an admin tool,
// so the data endpoints behind it are locked to admins too (requireAdmin).
//
// Filters arrive as query params and are applied to the FULL table by
// buildPublishersPage; `publishers` is the capped top slice of the matches,
// `total`/`totalUnfiltered` are the real counts. Callers that pass no params
// still get the top PUBLISHERS_PAGE_LIMIT rows by score, as before.
jobsRouter.get('/publishers', requireAdmin, (req: Request, res: Response) => {
  const page = buildPublishersPage(listPublishersByScore(1_000_000), req.query);
  res.json({
    ...page,
    funnel: {
      bySource: discoveredCountsBySource(),
      totalApps: countDiscoveredApps(),
      enriched: countEnrichedApps(),
      inBand: countInBandApps(TAIL_MIN_INSTALLS, TAIL_MAX_INSTALLS),
      publishers: countPublishers(),
      confirmed: countConfirmedPublishers(),
    },
  });
});

// GET /api/jobs/publishers.csv — Prospector export of the publisher table
// (score desc), honouring the same filter query params as the Publishers view.
jobsRouter.get('/publishers.csv', requireAdmin, (req: Request, res: Response) => {
  // Deliberately NO dedupe of any kind here — neither the lead-history seed (the
  // pipeline persists everything it exports into job_results, so seeding history
  // would make this download empty) nor the batch dedupe (two distinct publisher
  // rows legitimately share a contact email; both render in the table). This
  // endpoint exports the table the operator is LOOKING AT — filters applied,
  // nothing silently dropped — while the pipeline's own export is the
  // "new since last run" feed that does dedupe. Streamed from memory: no file,
  // so downloads no longer accumulate orphans under csv-output/.
  const rows = filterPublishers(listPublishersByScore(1_000_000), req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="store_first-publishers.csv"');
  res.send(publisherViewCsv(rows));
});

jobsRouter.get('/:id', (req, res) => {
  const user = (req as RequestWithUser).user!;
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.created_by_user_id && job.created_by_user_id !== user.id) {
    return res.status(404).json({ error: 'not found' });
  }
  const logs = getLogs(req.params.id);
  res.json({ job, logs });
});

jobsRouter.get('/:id/csv', (req, res) => {
  const user = (req as RequestWithUser).user!;
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.created_by_user_id && job.created_by_user_id !== user.id) {
    return res.status(404).json({ error: 'not found' });
  }

  // ?product=cps|mobile — export the job's results under the OTHER product
  // filter. Recovery path for e.g. a mobile google_ads job that discovered web
  // (cps_web) leads: those rows are stored in job_results but excluded from the
  // mobile CSV; this rebuilds a CSV from the stored rows without re-scraping.
  const override = String(req.query.product || '').toLowerCase();
  if (override && (override === 'cps' || override === 'mobile') && override !== job.product_type) {
    const results = getResults(job.id);
    if (results.length === 0) {
      return res.status(404).json({ error: 'no stored results to export' });
    }
    const { path: p, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: override as ProductType,
      results,
    });
    if (rowsWritten === 0) {
      return res.status(404).json({ error: `no ${override} rows in this job's results` });
    }
    const fname = path.basename(p);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return createReadStream(p).pipe(res);
  }

  if (!job.csv_path || !existsSync(job.csv_path)) {
    return res.status(404).json({ error: 'CSV not yet ready' });
  }
  const fname = path.basename(job.csv_path);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  createReadStream(job.csv_path).pipe(res);
});

// Per-HQ-country .xlsx bundle (mobile jobs only). The orchestrator sets
// hq_zip_path after the CSV has been written and HQ resolution succeeded.
jobsRouter.get('/:id/hq-zip', (req, res) => {
  const user = (req as RequestWithUser).user!;
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.created_by_user_id && job.created_by_user_id !== user.id) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!job.hq_zip_path || !existsSync(job.hq_zip_path)) {
    return res.status(404).json({ error: 'HQ-split zip not yet ready' });
  }
  const fname = path.basename(job.hq_zip_path);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  createReadStream(job.hq_zip_path).pipe(res);
});

// ── offline tests (no network, no DB — pure row shaping) ─────────────────────

export function runRoutesJobsTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  const mk = (o: Partial<PublisherRow>): PublisherRow => ({
    id: 0, merge_key: 'k', name: 'N', play_developer_id: null, apple_seller_name: null, website: null,
    email: null, countries_charted: '[]', countries_seen: '[]', verticals: '[]', charted_app_count: 0,
    app_count: 1, best_rank: null, both_stores: 0, in_band: 0, source_mix: '{}', gatc_advertiser_id: null,
    gatc_ads_count: null, meta_active_ads: null, confirmed_advertiser: 0, is_game_publisher: 0, is_charted: 0,
    preview_url: null, preview_title: null, score: 0, last_confirm_at: null, created_at: 0, updated_at: 0,
    ...o,
  });

  // A table BIGGER than one page, score-desc as listPublishersByScore returns it.
  // Only the very last row (lowest score, below the cap) is a finance publisher
  // in gb — the shape that used to be invisible: the route capped first, so the
  // view never received this row and every filter over it answered "no match".
  const last = PUBLISHERS_PAGE_LIMIT + 1;
  const rows: PublisherRow[] = Array.from({ length: last }, (_, i) =>
    mk({
      id: i + 1,
      name: `Pub ${i + 1}`,
      score: last - i,
      verticals: i === last - 1 ? '["finance"]' : '["games"]',
      countries_seen: i === last - 1 ? '["gb"]' : '["us"]',
      email: i === last - 1 ? 'tail@example.com' : null,
    }),
  );

  const unfiltered = buildPublishersPage(rows, {});
  check(unfiltered.publishers.length === PUBLISHERS_PAGE_LIMIT, 'publishers: payload capped at the page limit');
  check(unfiltered.total === last, 'publishers: total counts the whole table, not the capped page');
  check(unfiltered.totalUnfiltered === last, 'publishers: totalUnfiltered counts the whole table');

  const finance = buildPublishersPage(rows, { vertical: 'finance' });
  check(finance.total === 1, 'publishers: filter matches a row that sits below the page cap');
  check(
    finance.publishers.length === 1 && finance.publishers[0].name === `Pub ${last}`,
    'publishers: the below-cap match is actually returned',
  );
  check(finance.totalUnfiltered === last, 'publishers: totalUnfiltered ignores the active filters');
  check(
    buildPublishersPage(rows, { market: 'gb', email: '1' }).total === 1,
    'publishers: market + has-email filters also see past the page cap',
  );
  check(
    buildPublishersPage(rows, { vertical: 'games' }).publishers.length === PUBLISHERS_PAGE_LIMIT &&
      buildPublishersPage(rows, { vertical: 'games' }).total === last - 1,
    'publishers: a match set larger than the page is capped but counted in full',
  );

  // Dropdown options come from the unfiltered set, so narrowing to one vertical
  // still offers the others (and every offered value matches something).
  check(
    finance.facets.verticals.join(',') === 'finance,games' && finance.facets.markets.join(',') === 'gb,us',
    'publishers: facets are derived from the unfiltered table',
  );

  // Charted-only publishers have no countries_seen; the market facet and filter
  // must fall back to countries_charted exactly like publisherToDto does.
  const chartedOnly = [mk({ id: 1, name: 'C', countries_charted: '["de"]' })];
  check(
    buildPublishersPage(chartedOnly, {}).facets.markets.join(',') === 'de' &&
      buildPublishersPage(chartedOnly, { market: 'de' }).total === 1,
    'publishers: markets fall back to countries_charted',
  );

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('routes-jobs.js') || process.argv[1].endsWith('routes-jobs.ts'));
if (isMain) {
  const { passed, failed, failures } = runRoutesJobsTests();
  console.log(`routes-jobs tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}