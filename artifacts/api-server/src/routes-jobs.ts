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

export const jobsRouter: Router = Router();

interface CreateJobBody {
  countries: string[];
  productTypes: ProductType[];
  recipientEmail?: string | null;
  source?: JobSource;
  /** AppGoblin discovery params (only used when source='appgoblin'). */
  appgoblinCategory?: string | null;
  appgoblinAdNetwork?: string | null;
}

// POST /api/jobs
jobsRouter.post('/', (req: Request<{}, {}, CreateJobBody>, res: Response) => {
  const user = (req as RequestWithUser).user!;
  const { countries, productTypes, recipientEmail, source, appgoblinCategory, appgoblinAdNetwork } = req.body;

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
    if (source !== 'meta' && source !== 'affplus' && source !== 'appgoblin') {
      return res.status(400).json({ error: `invalid source: ${source}` });
    }
    jobSource = source;
  }

  // AppGoblin is mobile-only. Affplus now supports cps (web) as well as mobile.
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