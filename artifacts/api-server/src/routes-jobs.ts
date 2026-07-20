import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import {
  createJob,
  getJob,
  listJobsForUser,
  getLogs,
  ProductType,
  JobSource,
} from './db.js';
import { RequestWithUser } from './auth.js';
import { fetchAppgoblinCategoryList } from './appgoblinScraper.js';
import {
  GOOGLE_ADS_VERTICALS,
  GOOGLE_ADS_LANGUAGES,
  keywordStats,
} from './googleAdsKeywords.js';

export const jobsRouter: Router = Router();

interface GoogleAdsBody {
  verticals?: string[] | null;
  languages?: string[] | null;
  maxKeywords?: number | null;
  customKeywords?: string[] | null;
  region?: string | null;
}

interface CreateJobBody {
  countries: string[];
  productTypes: ProductType[];
  recipientEmail?: string | null;
  source?: JobSource;
  /** AppGoblin discovery params (only used when source='appgoblin'). */
  appgoblinCategory?: string | null;
  appgoblinAdNetwork?: string | null;
  /** Google Ads Transparency discovery params (only used when source='google_ads'). */
  googleAds?: GoogleAdsBody | null;
}

const KNOWN_VERTICAL_IDS = new Set(GOOGLE_ADS_VERTICALS.map((v) => v.id));
const KNOWN_LANG_CODES = new Set(GOOGLE_ADS_LANGUAGES.map((l) => l.code));

// POST /api/jobs
jobsRouter.post('/', (req: Request<{}, {}, CreateJobBody>, res: Response) => {
  const user = (req as RequestWithUser).user!;
  const { countries, productTypes, recipientEmail, source, appgoblinCategory, appgoblinAdNetwork, googleAds } = req.body;

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
    if (source !== 'meta' && source !== 'affplus' && source !== 'appgoblin' && source !== 'google_ads') {
      return res.status(400).json({ error: `invalid source: ${source}` });
    }
    jobSource = source;
  }

  // AppGoblin is mobile-only. Affplus and Google Ads support cps (web) too.
  if (jobSource === 'appgoblin' && productTypes.some((pt) => pt !== 'mobile')) {
    return res.status(400).json({ error: `${jobSource} source supports productType=mobile only` });
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