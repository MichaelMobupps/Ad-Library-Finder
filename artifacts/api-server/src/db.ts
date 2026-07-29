import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ensureStoreDiscoveryTables } from './storeDiscoveryDb.js';

export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'deferred' | 'cancelled';
export type JobSource = 'meta' | 'affplus' | 'appgoblin' | 'google_ads' | 'store_first';
export type JobPhase =
  | 'queued'
  | 'starting'
  | 'scraping'
  | 'classifying'
  | 'enriching'
  | 'building_csv'
  | 'hq_splitting'
  | 'done'
  | 'failed'
  | 'deferred'
  | 'cancelled';

export interface JobRow {
  id: string;
  product_type: ProductType;
  countries: string;
  status: JobStatus;
  csv_path: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  total_ads_scraped: number;
  total_advertisers: number;
  recipient_email: string | null;
  notification_status: string | null; // 'sent' | 'failed' | null
  created_by_user_id: string | null;
  source: JobSource; // 'meta' (default) | 'affplus' | 'appgoblin' | 'google_ads'
  /**
   * Optional JSON blob of source-specific parameters. Currently:
   *   - appgoblin:  {"category":"game_casino","adNetworkDomain":"appsflyer.com"}
   *   - google_ads: {"verticals":["igaming"],"languages":["en","es"],
   *                  "maxKeywords":40,"customKeywords":["..."],"region":"US"}
   * Meta and Affplus do not use this field.
   */
  source_params: string | null;
  phase: JobPhase | null; // coarse pipeline phase; null for old jobs (derived from status)
  phase_detail: string | null; // free-form descriptor, e.g. "scraping US / game" or "classifying 25/200"
  phase_updated_at: number | null;
  hq_zip_path: string | null; // path to per-HQ-country .zip bundle (mobile jobs + Google Ads web jobs)
  /**
   * Epoch ms before which the job must not run. Set when a job is deferred for
   * hitting the LLM daily cap; equals the next Asia/Jerusalem midnight. NULL for
   * jobs that have never been deferred.
   */
  run_after: number | null;
  /** 1 when the user pressed Stop. Pipelines poll this (jobControl.ts) and
   *  unwind, keeping partial results. 0 for normal jobs. */
  cancel_requested: number;
  /**
   * LIVE lead counter — updated by pipelines as leads land, so the UI can show
   * "how many leads so far" and a progress bar MID-RUN, not just in the logs.
   * On completion markJobCompleted syncs it to the final total_advertisers.
   */
  leads_found: number;
  /**
   * Overall progress 0..100 covering EVERY task the pipeline performs — each
   * pipeline reports its own weighted phase spans (charts, crawls, enrichment,
   * confirmation, CSV, HQ split, …), not just lead counts. Monotonic within a
   * run (setJobProgress takes MAX); reset to 0 by markJobRunning, pinned to 100
   * by markJobCompleted.
   */
  progress_pct: number;
}

export interface JobLogRow {
  id: number;
  job_id: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  ts: number;
}

export interface JobResultRow {
  id: number;
  job_id: string;
  advertiser_name: string;
  page_url: string | null;
  landing_url: string | null;
  classification: string | null;
  store_url: string | null;
  ad_text: string | null;
  country: string;
  created_at: number;
  /** App-store category label (game vs non-game enrichment). Null = not enriched. */
  app_category: string | null;
  /** 1=game, 0=non-game, null=unknown/unclassified (or non-mobile lead). */
  is_game: number | null;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  default_recipient: string | null;
  created_at: number;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface GmailTokenRow {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  gmail_email: string | null;
  updated_at: number;
}

const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'ad-library.sqlite');

let db: Database.Database;

export async function initDb() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      product_type TEXT NOT NULL,
      countries TEXT NOT NULL,
      status TEXT NOT NULL,
      csv_path TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      total_ads_scraped INTEGER NOT NULL DEFAULT 0,
      total_advertisers INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, ts);

    CREATE TABLE IF NOT EXISTS job_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      advertiser_name TEXT NOT NULL,
      page_url TEXT,
      landing_url TEXT,
      classification TEXT,
      store_url TEXT,
      ad_text TEXT,
      country TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_results_job ON job_results(job_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      default_recipient TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_tokens (
      user_id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      gmail_email TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS llm_spend (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      spend_day TEXT NOT NULL,        -- Asia/Jerusalem calendar day 'YYYY-MM-DD'
      source TEXT NOT NULL,           -- which call site spent (classifier | hq-resolver | web-resolver)
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      web_searches INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_spend_day ON llm_spend(spend_day);
  `);

  // Idempotent additive migrations on jobs
  const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
  const colNames = new Set(jobCols.map((c) => c.name));
  if (!colNames.has('recipient_email')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN recipient_email TEXT`);
  }
  if (!colNames.has('notification_status')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN notification_status TEXT`);
  }
  if (!colNames.has('created_by_user_id')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN created_by_user_id TEXT`);
  }
  if (!colNames.has('source')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'meta'`);
  }
  if (!colNames.has('source_params')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN source_params TEXT`);
  }
  if (!colNames.has('phase')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN phase TEXT`);
  }
  if (!colNames.has('phase_detail')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN phase_detail TEXT`);
  }
  if (!colNames.has('phase_updated_at')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN phase_updated_at INTEGER`);
  }
  if (!colNames.has('hq_zip_path')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN hq_zip_path TEXT`);
  }
  if (!colNames.has('run_after')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN run_after INTEGER`);
  }
  if (!colNames.has('cancel_requested')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`);
  }
  if (!colNames.has('leads_found')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN leads_found INTEGER NOT NULL DEFAULT 0`);
    // Backfill finished jobs so old rows don't show 0 leads next to a non-zero total.
    db.exec(`UPDATE jobs SET leads_found = total_advertisers WHERE total_advertisers > 0`);
  }
  if (!colNames.has('progress_pct')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN progress_pct REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE jobs SET progress_pct = 100 WHERE status = 'completed'`);
  }

  // Idempotent additive migrations on job_results: app-category enrichment
  // (game vs non-game) for GATC mobile leads. Nullable, so every other pipeline
  // (Meta / Affplus / AppGoblin) is unaffected — the columns simply stay NULL.
  const resultCols = db.prepare(`PRAGMA table_info(job_results)`).all() as Array<{ name: string }>;
  const resultColNames = new Set(resultCols.map((c) => c.name));
  if (!resultColNames.has('app_category')) {
    db.exec(`ALTER TABLE job_results ADD COLUMN app_category TEXT`);
  }
  if (!resultColNames.has('is_game')) {
    db.exec(`ALTER TABLE job_results ADD COLUMN is_game INTEGER`); // 1=game, 0=non-game, NULL=unknown
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(created_by_user_id)`);

  // Store-first discovery tables (discovered_apps, store_app_detail, publishers).
  // Created here so they exist before the queue or the /publishers route runs.
  ensureStoreDiscoveryTables();

  // Garbage-collect expired sessions on startup
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());

  // On startup, settle jobs that were 'running' when the process died. A job
  // whose user had ALREADY pressed Stop resolves to 'cancelled' (that is what
  // the pipeline would have done had it lived to poll the flag); the rest are
  // failures. Order matters: the cancelled sweep must run first or the failed
  // sweep would claim its rows.
  db.prepare(
    `UPDATE jobs SET status='cancelled', phase='cancelled', phase_detail='stopped by user (server restarted before finalize)', completed_at=? WHERE status='running' AND cancel_requested=1`
  ).run(Date.now());
  db.prepare(
    `UPDATE jobs SET status='failed', phase='failed', error='process restarted mid-job', completed_at=? WHERE status='running'`
  ).run(Date.now());
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// ---------- Job helpers ----------

export function createJob(input: {
  id: string;
  productType: ProductType;
  countries: string[];
  recipientEmail?: string | null;
  createdByUserId: string;
  source?: JobSource;
  sourceParams?: Record<string, unknown> | null;
}): JobRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, product_type, countries, status, created_at, total_ads_scraped, total_advertisers, recipient_email, created_by_user_id, source, source_params, phase, phase_detail, phase_updated_at)
       VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?, ?, ?, 'queued', 'waiting for worker', ?)`
    )
    .run(
      input.id,
      input.productType,
      JSON.stringify(input.countries),
      now,
      input.recipientEmail ?? null,
      input.createdByUserId,
      input.source ?? 'meta',
      input.sourceParams ? JSON.stringify(input.sourceParams) : null,
      now
    );
  return getJob(input.id)!;
}

export function getJob(id: string): JobRow | null {
  return (getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow) ?? null;
}

export function listJobsForUser(userId: string): JobRow[] {
  return getDb()
    .prepare(`SELECT * FROM jobs WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT 200`)
    .all(userId) as JobRow[];
}

export function listAllJobs(): JobRow[] {
  return getDb().prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`).all() as JobRow[];
}

export type ActivityJobRow = JobRow & { creator_email: string | null; creator_name: string | null };

/** All jobs across ALL users with the creator's identity — the admin Activity view. */
export function listAllJobsWithUsers(limit = 200): ActivityJobRow[] {
  return getDb()
    .prepare(
      `SELECT jobs.*, users.email AS creator_email, users.name AS creator_name
         FROM jobs LEFT JOIN users ON users.id = jobs.created_by_user_id
        ORDER BY jobs.created_at DESC LIMIT ?`,
    )
    .all(limit) as ActivityJobRow[];
}

/**
 * The runnable candidates for the CONCURRENT dispatcher, oldest first: fresh
 * pending jobs plus deferred jobs whose Jerusalem-midnight run_after has
 * passed, never anything the user already stopped. The dispatcher applies the
 * per-user / per-cap policies on top of this list.
 */
export function listRunnableJobs(limit = 50): JobRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM jobs
        WHERE cancel_requested = 0
          AND (status = 'pending'
           OR (status = 'deferred' AND (run_after IS NULL OR run_after <= ?)))
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(Date.now(), limit) as JobRow[];
}

// Terminal-state guards ("AND status ..."): the queue watchdog can settle a
// wedged job's row to 'failed' while its zombie pipeline promise is still
// pending. If that zombie later wakes up (its browser was killed under it), its
// terminal writes must be no-ops — a settled job is never resurrected or
// flipped. Every transition below states which prior states may take it.

export function markJobRunning(id: string) {
  const now = Date.now();
  // leads_found and progress_pct reset to 0: a deferred/resumed job replays
  // from the top (pipelines clear/skip their partials), so stale counters from
  // the prior attempt would overstate progress until the first live update.
  // Guard: never resurrects a job stopped between dispatch and this write.
  getDb()
    .prepare(
      `UPDATE jobs SET status='running', started_at=?, leads_found=0, progress_pct=0, phase='starting', phase_detail='launching browser', phase_updated_at=? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .run(now, now, id);
}

export function markJobCompleted(id: string, csvPath: string, counts: { ads: number; advertisers: number }) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='completed', csv_path=?, completed_at=?, total_ads_scraped=?, total_advertisers=?, leads_found=?, progress_pct=100, phase='done', phase_detail='complete', phase_updated_at=? WHERE id = ? AND status='running'`
    )
    .run(csvPath, now, counts.ads, counts.advertisers, counts.advertisers, now, id);
}

/**
 * Report overall run progress (0..100 across ALL of the pipeline's tasks).
 * Monotonic via MAX(): concurrent per-store streams update out of order and a
 * lower estimate must never walk the bar backwards.
 */
export function setJobProgress(id: string, pct: number) {
  const clamped = Math.max(0, Math.min(100, pct));
  getDb()
    .prepare(
      `UPDATE jobs SET progress_pct = MAX(progress_pct, ?) WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .run(clamped, id);
}

/**
 * Re-queue a stopped (or failed) job under its SAME id. The queue picks it up
 * like any pending job; each pipeline's replay-safety decides what "resume"
 * means: store_first continues exactly where it left off (its rotation stamps,
 * enrichment cache and publisher corpus are durable), meta skips already-
 * classified rows, the others replay from the top with deduped results.
 * Returns false when the job isn't in a resumable state.
 */
export function resumeJob(id: string): boolean {
  const job = getJob(id);
  if (!job) return false;
  if (job.status !== 'cancelled' && job.status !== 'failed') return false;
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='pending', cancel_requested=0, error=NULL, completed_at=NULL, run_after=NULL,
              phase='queued', phase_detail='resumed — waiting for worker', phase_updated_at=? WHERE id = ?`
    )
    .run(now, id);
  return true;
}

/**
 * Terminal state for a user-stopped job. Partial results are KEPT: csv_path (when
 * the pipeline flushed one), job_results rows and leads_found all stay, so a
 * stopped job still delivers everything it found up to the stop.
 */
export function markJobCancelled(id: string, detail: string, csvPath?: string | null) {
  const now = Date.now();
  if (csvPath) {
    // Unguarded on purpose: pointing csv_path at a partial export is useful
    // even when the watchdog already failed the job.
    getDb().prepare(`UPDATE jobs SET csv_path=? WHERE id = ?`).run(csvPath, id);
  }
  getDb()
    .prepare(
      `UPDATE jobs SET status='cancelled', completed_at=?, phase='cancelled', phase_detail=?, phase_updated_at=? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .run(now, detail.slice(0, 200), now, id);
}

/**
 * Flag a job to stop. If the worker hasn't started it (pending, or deferred and
 * parked until midnight), it is cancelled on the spot — there is nothing to
 * unwind. A running job keeps status 'running' until its pipeline polls the flag
 * (jobControl.throwIfCancelled) and finalizes with markJobCancelled.
 * Returns false when the job is already terminal.
 */
export function requestJobCancel(id: string): boolean {
  const job = getJob(id);
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return false;
  getDb().prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ?`).run(id);
  if (job.status === 'pending' || job.status === 'deferred') {
    markJobCancelled(id, 'stopped by user before start');
  } else {
    const now = Date.now();
    getDb()
      .prepare(`UPDATE jobs SET phase_detail=?, phase_updated_at=? WHERE id = ?`)
      .run('stopping — finishing current step…', now, id);
  }
  return true;
}

/** Live "leads so far" counter — cheap single-column update, called mid-run. */
export function setJobLeadsFound(id: string, n: number) {
  getDb()
    .prepare(`UPDATE jobs SET leads_found = ? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`)
    .run(n, id);
}

export function markJobFailed(id: string, error: string) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='failed', error=?, completed_at=?, phase='failed', phase_detail=?, phase_updated_at=? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .run(error, now, error.slice(0, 200), now, id);
}

/**
 * Defer a job that hit the LLM daily cap mid-run. The job keeps its partial
 * results in job_results and becomes runnable again once `runAfter` (the next
 * Asia/Jerusalem midnight) passes. This is distinct from markJobFailed: a
 * deferred job is not terminal and is not emailed as a failure.
 */
export function deferJob(id: string, runAfter: number, detail: string) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='deferred', run_after=?, phase='deferred', phase_detail=?, phase_updated_at=? WHERE id = ? AND status='running'`
    )
    .run(runAfter, detail.slice(0, 200), now, id);
}

export function setJobPhase(id: string, phase: JobPhase, detail?: string | null) {
  const now = Date.now();
  // Guard: a watchdog-failed job's zombie pipeline must not make the row look
  // alive again by stamping fresh phases onto it.
  getDb()
    .prepare(
      `UPDATE jobs SET phase=?, phase_detail=?, phase_updated_at=? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .run(phase, detail ?? null, now, id);
}

/**
 * Most recent liveness signal for a job: the newer of its phase heartbeat and
 * its last job_logs row (long phases — HQ split, store resolve — log without
 * changing phase). The queue watchdog uses this to detect wedged jobs.
 */
export function jobHeartbeatAt(id: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(COALESCE(phase_updated_at, started_at, created_at),
                  COALESCE((SELECT MAX(ts) FROM job_logs WHERE job_id = jobs.id), 0)) AS beat
         FROM jobs WHERE id = ?`
    )
    .get(id) as { beat: number | null } | undefined;
  return row?.beat ?? null;
}

export function setJobNotificationStatus(id: string, status: 'sent' | 'failed') {
  getDb().prepare(`UPDATE jobs SET notification_status=? WHERE id = ?`).run(status, id);
}

export function setJobHqZipPath(id: string, zipPath: string | null) {
  getDb().prepare(`UPDATE jobs SET hq_zip_path=? WHERE id = ?`).run(zipPath, id);
}

/**
 * Point job.csv_path at a file BEFORE the job finishes. Pipelines that flush a
 * partial CSV incrementally call this on the first flush so the download route
 * (which 404s while csv_path is null) can serve the growing file — and so a job
 * that is later blocked, interrupted, or marked failed still leaves everything
 * scraped so far downloadable. markJobCompleted overwrites it with the same
 * path at the end; markJobFailed leaves it intact.
 */
export function setJobCsvPath(id: string, csvPath: string) {
  getDb().prepare(`UPDATE jobs SET csv_path=? WHERE id = ?`).run(csvPath, id);
}

// ---------- Log helpers ----------

export function appendLog(jobId: string, level: JobLogRow['level'], message: string) {
  getDb()
    .prepare(`INSERT INTO job_logs (job_id, level, message, ts) VALUES (?, ?, ?, ?)`)
    .run(jobId, level, message, Date.now());
}

export function getLogs(jobId: string): JobLogRow[] {
  return getDb().prepare(`SELECT * FROM job_logs WHERE job_id = ? ORDER BY ts ASC`).all(jobId) as JobLogRow[];
}

// ---------- Result helpers ----------

/**
 * Identity of every lead already in the Leadfinder store, for cross-job dedupe.
 *
 * Returns the raw advertiser names plus every URL that can carry a brand domain.
 * NOTE: job_results has no email column, so an email-level dedupe against history
 * is not possible here — callers dedupe on email only WITHIN the current batch and
 * fall back to domain, then normalized name, against this history.
 */
export function existingLeadIdentities(): { names: string[]; urls: string[] } {
  const rows = getDb()
    .prepare(`SELECT advertiser_name, landing_url, page_url, store_url FROM job_results`)
    .all() as Array<{ advertiser_name: string; landing_url: string | null; page_url: string | null; store_url: string | null }>;
  const names: string[] = [];
  const urls: string[] = [];
  for (const r of rows) {
    if (r.advertiser_name) names.push(r.advertiser_name);
    // ONLY landing_url — the advertiser's own destination. store_url and page_url
    // are PLATFORM urls by construction (play.google.com; facebook.com/<page> for
    // meta, affplus.com/o/<slug>, appgoblin.info/companies/…, adstransparency…),
    // so feeding them to a domain-based dedupe would drop every unrelated
    // publisher whose store website happens to be a Facebook page.
    if (r.landing_url) urls.push(r.landing_url);
  }
  return { names, urls };
}

export function insertResult(input: {
  job_id: string;
  advertiser_name: string;
  page_url: string | null;
  landing_url: string | null;
  classification: string | null;
  store_url: string | null;
  ad_text: string | null;
  country: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO job_results (job_id, advertiser_name, page_url, landing_url, classification, store_url, ad_text, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.job_id,
      input.advertiser_name,
      input.page_url,
      input.landing_url,
      input.classification,
      input.store_url,
      input.ad_text,
      input.country,
      Date.now()
    );
}

export function getResults(jobId: string): JobResultRow[] {
  return getDb()
    .prepare(`SELECT * FROM job_results WHERE job_id = ? ORDER BY id ASC`)
    .all(jobId) as JobResultRow[];
}

/** Set the app-category enrichment fields on a single result row.
 *  is_game: true→1, false→0, null→NULL (unknown/unclassified). */
export function setResultCategory(resultId: number, appCategory: string | null, isGame: boolean | null): void {
  getDb()
    .prepare(`UPDATE job_results SET app_category = ?, is_game = ? WHERE id = ?`)
    .run(appCategory, isGame === null ? null : isGame ? 1 : 0, resultId);
}

/**
 * Delete all result rows for a job. Called at the start of the AppGoblin and
 * Affplus pipeline runs so that a job which was deferred for the LLM daily cap
 * and is now replaying does not duplicate rows it inserted on the prior run.
 * No-op on a fresh job (it has no rows yet). Meta does not use this: it keeps
 * prior rows and skips them via a landing_url guard, which also avoids paying
 * for its uncached classify calls a second time.
 */
export function clearJobResults(jobId: string) {
  getDb().prepare(`DELETE FROM job_results WHERE job_id = ?`).run(jobId);
}

// ---------- User helpers ----------

export function getUserByEmail(email: string): UserRow | null {
  return (getDb().prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow) ?? null;
}

export function getUserById(id: string): UserRow | null {
  return (getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow) ?? null;
}

export function upsertUser(input: { id?: string; email: string; name?: string | null }): UserRow {
  const existing = getUserByEmail(input.email);
  if (existing) {
    if (input.name && input.name !== existing.name) {
      getDb().prepare(`UPDATE users SET name = ? WHERE id = ?`).run(input.name, existing.id);
      return { ...existing, name: input.name };
    }
    return existing;
  }
  const id = input.id ?? `usr_${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, name, default_recipient, created_at) VALUES (?, ?, ?, NULL, ?)`
    )
    .run(id, input.email, input.name ?? null, now);
  return getUserById(id)!;
}

export function setUserDefaultRecipient(userId: string, recipient: string | null) {
  getDb().prepare(`UPDATE users SET default_recipient = ? WHERE id = ?`).run(recipient, userId);
}

// ---------- Session helpers ----------

export function createSession(userId: string, ttlMs: number): SessionRow {
  const token = cryptoRandom(40);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  getDb()
    .prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now, expiresAt);
  return { token, user_id: userId, created_at: now, expires_at: expiresAt };
}

export function getSessionUser(token: string): UserRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM sessions WHERE token = ?`)
    .get(token) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(token);
    return null;
  }
  return getUserById(row.user_id);
}

export function deleteSession(token: string) {
  getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// ---------- Gmail token helpers ----------

export function getGmailTokensForUser(userId: string): GmailTokenRow | null {
  return (getDb().prepare(`SELECT * FROM gmail_tokens WHERE user_id = ?`).get(userId) as GmailTokenRow) ?? null;
}

export function upsertGmailTokens(input: {
  userId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  gmailEmail?: string | null;
}) {
  const existing = getGmailTokensForUser(input.userId);
  const now = Date.now();
  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO gmail_tokens (user_id, access_token, refresh_token, expires_at, gmail_email, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.userId,
        input.accessToken ?? null,
        input.refreshToken ?? null,
        input.expiresAt ?? null,
        input.gmailEmail ?? null,
        now
      );
    return;
  }
  // Update only provided fields; preserve refresh_token if not given.
  const next = {
    access_token: input.accessToken ?? existing.access_token,
    refresh_token: input.refreshToken ?? existing.refresh_token,
    expires_at: input.expiresAt ?? existing.expires_at,
    gmail_email: input.gmailEmail ?? existing.gmail_email,
  };
  getDb()
    .prepare(
      `UPDATE gmail_tokens
       SET access_token = ?, refresh_token = ?, expires_at = ?, gmail_email = ?, updated_at = ?
       WHERE user_id = ?`
    )
    .run(next.access_token, next.refresh_token, next.expires_at, next.gmail_email, now, input.userId);
}

export function deleteGmailTokens(userId: string) {
  getDb().prepare(`DELETE FROM gmail_tokens WHERE user_id = ?`).run(userId);
}

// ---------- internal ----------

function cryptoRandom(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
// Backwards-compat alias used by routes-auth.ts
export function upsertUserByEmail(email: string, name?: string | null): UserRow {
  return upsertUser({ email, name });
}