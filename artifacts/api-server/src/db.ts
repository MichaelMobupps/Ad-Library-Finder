import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'deferred';
export type JobSource = 'meta' | 'affplus' | 'appgoblin' | 'google_ads';
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
  | 'deferred';

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

  // Garbage-collect expired sessions on startup
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());

  // On startup, mark any 'running' jobs as failed (process restarted mid-job).
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

export function getNextPendingJob(): JobRow | null {
  // A job is runnable when it is freshly pending, or it was deferred for the LLM
  // daily cap and its run_after (next Asia/Jerusalem midnight) has passed. The
  // deferred job becomes eligible on its own once the clock crosses midnight, so
  // no scheduler process is needed. Oldest first across both states.
  return (getDb()
    .prepare(
      `SELECT * FROM jobs
        WHERE status = 'pending'
           OR (status = 'deferred' AND (run_after IS NULL OR run_after <= ?))
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(Date.now()) as JobRow) ?? null;
}

export function markJobRunning(id: string) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='running', started_at=?, phase='starting', phase_detail='launching browser', phase_updated_at=? WHERE id = ?`
    )
    .run(now, now, id);
}

export function markJobCompleted(id: string, csvPath: string, counts: { ads: number; advertisers: number }) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='completed', csv_path=?, completed_at=?, total_ads_scraped=?, total_advertisers=?, phase='done', phase_detail='complete', phase_updated_at=? WHERE id = ?`
    )
    .run(csvPath, now, counts.ads, counts.advertisers, now, id);
}

export function markJobFailed(id: string, error: string) {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE jobs SET status='failed', error=?, completed_at=?, phase='failed', phase_detail=?, phase_updated_at=? WHERE id = ?`
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
      `UPDATE jobs SET status='deferred', run_after=?, phase='deferred', phase_detail=?, phase_updated_at=? WHERE id = ?`
    )
    .run(runAfter, detail.slice(0, 200), now, id);
}

export function setJobPhase(id: string, phase: JobPhase, detail?: string | null) {
  const now = Date.now();
  getDb()
    .prepare(`UPDATE jobs SET phase=?, phase_detail=?, phase_updated_at=? WHERE id = ?`)
    .run(phase, detail ?? null, now, id);
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