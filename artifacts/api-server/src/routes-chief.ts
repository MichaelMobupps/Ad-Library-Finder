/**
 * The `/api/chief` mount — the machine seam the Chief commands this app through.
 *
 * Mounted with basePath() exactly like every other `/api` route, so it serves at
 * `/api/chief/*` today and at `/leadfinder/api/chief/*` the moment BASE_PATH is
 * set, with no second registration and no legacy rule to keep in step.
 *
 * STATUS-CODE ORDER, which is the contract C-3.3b is written against:
 *
 *   400 / 413   malformed or oversize JSON — raised by the app-level body
 *               parser BEFORE this router is reached, therefore before auth.
 *               Converted to JSON by chiefBodyErrorHandler (below), which is
 *               scoped to this mount so no human path's error shape moves.
 *   401         no token, malformed header, wrong token, or unset secret —
 *               one indistinguishable answer, ahead of every routing decision
 *               including 404. An unauthenticated caller cannot learn whether a
 *               path, or a job, exists.
 *   404         the path is not one of ours, or names a job this principal does
 *               not own. A human's job is answered exactly like a missing one.
 *   415         the body is not application/json.
 *   400         the body or the query failed validation.
 *   503         a database read failed. Never a fabricated value in its place.
 *   200 / 201   success. 201 the first time a command creates a job, 200 when
 *               an already-seen external_id returns the existing one.
 *
 * SAFETY: nothing here starts, cancels or executes a job. A commanded job is
 * inserted `pending` exactly as a human's is and is picked up — or not — by the
 * ordinary queue processor, which a test boot never starts.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { getResults } from './db.js';
import { selectExportRows } from './csv.js';
import { jerusalemDay } from './llmBudget.js';
import {
  acceptingJobs,
  activeJobCount,
  createCommandedJob,
  externalIdForJob,
  getChiefJob,
  isTerminalState,
  jobLeadCount,
  jobToChiefDto,
  noStore,
  pageLeads,
  parsePagination,
  requireChiefToken,
  spendTodayUsd,
  validateCreateBody,
} from './chief.js';
import { log } from './logger.js';

export const chiefRouter: Router = Router();

/** A machine surface answers with no-store on every path, success or failure. */
chiefRouter.use((_req: Request, res: Response, next: NextFunction) => {
  noStore(res);
  next();
});

/**
 * THE gate, first thing on the mount. Everything below it — including the
 * terminal 404 — is unreachable without the token, which is what makes "401
 * precedes 404" a property of the stack rather than of each handler.
 */
chiefRouter.use(requireChiefToken);

const notFound = (res: Response) => res.status(404).json({ error: 'not found' });

/**
 * A read that failed is 503, never 500 and never a plausible-looking empty
 * answer. The distinction matters to a machine: 503 means "ask again", 500
 * means "this is a bug, stop asking". Nothing about the failure is returned —
 * the sqlite message goes to the log.
 */
const unavailable = (res: Response, what: string, err: unknown) => {
  log.error(`chief ${what}: a read failed — ${(err as Error).message}`);
  return res.status(503).json({ error: 'temporarily unavailable' });
};

// ── GET /api/chief/status ────────────────────────────────────────────────────
// Liveness plus the three facts the Chief schedules against. Every value is
// read; none is asserted. A failed read is a 503, never a plausible zero.
chiefRouter.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({
      app: 'leadfinder',
      ok: true,
      accepting_jobs: acceptingJobs(),
      active_jobs: activeJobCount(),
      spend_today_usd: spendTodayUsd(jerusalemDay()),
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    // The message is a sqlite error, never a secret — the token is not read
    // here and is not in scope. Still logged rather than returned.
    log.error(`chief status: a read failed — ${(err as Error).message}`);
    res.status(503).json({ error: 'status unavailable' });
  }
});

// ── POST /api/chief/jobs ─────────────────────────────────────────────────────
// Create a discovery job, or hand back the one this external_id already names.
chiefRouter.post('/jobs', (req: Request, res: Response) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type: application/json required' });
  }

  const parsed = validateCreateBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  // The same predicate /status reports, so the flag can never promise something
  // this path refuses. Today it is false only when the database is unreadable.
  try {
    if (!acceptingJobs()) {
      return res.status(503).json({ error: 'not accepting jobs' });
    }
  } catch (err) {
    log.error(`chief create: acceptance read failed — ${(err as Error).message}`);
    return res.status(503).json({ error: 'not accepting jobs' });
  }

  try {
    const { job, created } = createCommandedJob(parsed.value);
    return res
      .status(created ? 201 : 200)
      .json({ created, job: jobToChiefDto(job, parsed.value.external_id) });
  } catch (err) {
    log.error(`chief create: ${(err as Error).message}`);
    return res.status(500).json({ error: 'could not create job' });
  }
});

// ── GET /api/chief/jobs/:id ──────────────────────────────────────────────────
// State, live progress and timestamps. 404 for anything this principal does not
// own, so a human's job is indistinguishable from one that never existed.
// (handler params intentionally un-annotated: the Express 5 types infer
// `{ id: string }` from the route string, exactly as routes-jobs.ts relies on.)
chiefRouter.get('/jobs/:id', (req, res) => {
  try {
    const job = getChiefJob(req.params.id);
    if (!job) return notFound(res);
    return res.json({ job: jobToChiefDto(job, externalIdForJob(job.id)) });
  } catch (err) {
    return unavailable(res, 'job read', err);
  }
});

// ── GET /api/chief/jobs/:id/leads?offset=&limit= ─────────────────────────────
// The job's results, in the SAME selection the CSV and the emailed .xlsx carry:
// selectExportRows applied to the job's own product type and lead cap. Reading
// the raw job_results rows instead would hand the Chief every advertiser the
// classifier rejected, which is not what this app calls a lead.
//
// Ordering is job_results.id ASC (getResults), i.e. insertion order. Rows are
// only ever appended, so an offset stays meaningful across polls of a running
// job — which is why a partial read is allowed rather than refused. `final`
// says whether what came back can still change.
chiefRouter.get('/jobs/:id/leads', (req, res) => {
  let job;
  try {
    job = getChiefJob(req.params.id);
  } catch (err) {
    return unavailable(res, 'leads read', err);
  }
  if (!job) return notFound(res);

  const page = parsePagination(req.query as Record<string, unknown>);
  if (!page.ok) return res.status(400).json({ error: page.error });

  let rows;
  try {
    rows = selectExportRows(getResults(job.id), job.product_type, jobLeadCount(job));
  } catch (err) {
    return unavailable(res, 'leads read', err);
  }
  const slice = pageLeads(rows, page.offset, page.limit);

  return res.json({
    job_id: job.id,
    state: job.status,
    final: isTerminalState(job.status),
    total: rows.length,
    offset: page.offset,
    limit: page.limit,
    count: slice.leads.length,
    next_offset: slice.next_offset,
    has_more: slice.has_more,
    leads: slice.leads,
  });
});

/**
 * Terminal 404 for the mount. Without it an unknown chief path would fall
 * through to the SPA catch-all and answer `200 index.html` — the exact shape
 * that made a broken download link look like a working page (V1's finding).
 * Registered last, so it sits behind the token gate: an anonymous caller gets
 * 401 here too, and learns nothing about which paths exist.
 */
chiefRouter.use((_req: Request, res: Response) => notFound(res));

/**
 * Body-parser failures, as JSON, for THIS MOUNT ONLY.
 *
 * express.json() runs at app level, before any router, so a malformed or
 * oversize body is rejected before authentication — which is the ordering the
 * Chief's contract requires. What it is NOT is a JSON answer: Express's default
 * handler renders an HTML error page and echoes the parse message, which quotes
 * a fragment of the body back at the caller.
 *
 * Mounting this at basePath('/api/chief') fixes both for machine traffic while
 * leaving every human path on exactly the error shape it has always produced —
 * the DARK baseline pins those, and this order changes nothing a human sees.
 *
 * Registered in app.ts immediately after the router.
 */
export function chiefBodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(err);
  noStore(res);
  const type = (err as { type?: string } | null)?.type;
  const status = (err as { status?: number } | null)?.status;
  if (type === 'entity.too.large' || status === 413) {
    res.status(413).json({ error: 'request body too large' });
    return;
  }
  if (type === 'entity.parse.failed' || type === 'charset.unsupported' || type === 'encoding.unsupported') {
    // Fixed literal: the parser's own message quotes the body back.
    res.status(400).json({ error: 'malformed JSON body' });
    return;
  }
  log.error(`chief mount: unhandled error — ${(err as Error)?.message ?? String(err)}`);
  res.status(500).json({ error: 'internal error' });
}
