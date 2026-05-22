import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type JobSource = 'meta' | 'affplus';

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
  source: JobSource; // 'meta' (default) | 'affplus'
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

  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(created_by_user_id)`);

  // Garbage-collect expired sessions on startup
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());

  // On startup, mark any 'running' jobs as failed (process restarted mid-job).
  db.prepare(
    `UPDATE jobs SET status='failed', error='process restarted mid-job', completed_at=? WHERE status='running'`
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
}): JobRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, product_type, countries, status, created_at, total_ads_scraped, total_advertisers, recipient_email, created_by_user_id, source)
       VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?, ?)`
    )
    .run(
      input.id,
      input.productType,
      JSON.stringify(input.countries),
      now,
      input.recipientEmail ?? null,
      input.createdByUserId,
      input.source ?? 'meta'
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
  return (getDb()
    .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`)
    .get() as JobRow) ?? null;
}

export function markJobRunning(id: string) {
  getDb()
    .prepare(`UPDATE jobs SET status='running', started_at=? WHERE id = ?`)
    .run(Date.now(), id);
}

export function markJobCompleted(id: string, csvPath: string, counts: { ads: number; advertisers: number }) {
  getDb()
    .prepare(
      `UPDATE jobs SET status='completed', csv_path=?, completed_at=?, total_ads_scraped=?, total_advertisers=? WHERE id = ?`
    )
    .run(csvPath, Date.now(), counts.ads, counts.advertisers, id);
}

export function markJobFailed(id: string, error: string) {
  getDb()
    .prepare(`UPDATE jobs SET status='failed', error=?, completed_at=? WHERE id = ?`)
    .run(error, Date.now(), id);
}

export function setJobNotificationStatus(id: string, status: 'sent' | 'failed') {
  getDb().prepare(`UPDATE jobs SET notification_status=? WHERE id = ?`).run(status, id);
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
