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

export const jobsRouter: Router = Router();

interface CreateJobBody {
  countries: string[];
  productTypes: ProductType[];
  recipientEmail?: string | null;
  source?: JobSource;
}

// POST /api/jobs
jobsRouter.post('/', (req: Request<{}, {}, CreateJobBody>, res: Response) => {
  const user = (req as RequestWithUser).user!;
  const { countries, productTypes, recipientEmail, source } = req.body;

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
    if (source !== 'meta' && source !== 'affplus') {
      return res.status(400).json({ error: `invalid source: ${source}` });
    }
    jobSource = source;
  }

  // Affplus only produces mobile-targeted output today; reject CPS for affplus.
  if (jobSource === 'affplus' && productTypes.some((pt) => pt !== 'mobile')) {
    return res.status(400).json({ error: 'affplus source supports productType=mobile only' });
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
    });
  });

  res.json({ jobs: created });
});

jobsRouter.get('/', (req, res) => {
  const user = (req as RequestWithUser).user!;
  res.json({ jobs: listJobsForUser(user.id) });
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