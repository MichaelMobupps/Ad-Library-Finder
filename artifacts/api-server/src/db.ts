import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

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

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

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
}): JobRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, product_type, countries, status, created_at, total_ads_scraped, total_advertisers, recipient_email, created_by_user_id)
       VALUES (?, ?, ?, 'pending', ?, 0, 0, ?, ?)`
    )
    .run(
      input.id,
      input.productType,
      JSON.stringify(input.countries),
      now,
      input.recipientEmail ?? null,
      input.createdByUserId
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

export function insertResult(r: Omit<JobResultRow, 'id' | 'created_at'>) {
  getDb()
    .prepare(
      `INSERT INTO job_results (job_id, advertiser_name, page_url, landing_url, classification, store_url, ad_text, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      r.job_id,
      r.advertiser_name,
      r.page_url,
      r.landing_url,
      r.classification,
      r.store_url,
      r.ad_text,
      r.country,
      Date.now()
    );
}

export function getResults(jobId: string): JobResultRow[] {
  return getDb().prepare(`SELECT * FROM job_results WHERE job_id = ?`).all(jobId) as JobResultRow[];
}

// ---------- User helpers ----------

export function upsertUserByEmail(email: string, name: string | null): UserRow {
  const normalized = email.toLowerCase().trim();
  const existing = getDb().prepare(`SELECT * FROM users WHERE email = ?`).get(normalized) as UserRow | undefined;
  if (existing) {
    if (name && name !== existing.name) {
      getDb().prepare(`UPDATE users SET name = ? WHERE id = ?`).run(name, existing.id);
    }
    return getUserById(existing.id)!;
  }
  const id = `usr_${cryptoRandom(12)}`;
  getDb()
    .prepare(`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, normalized, name, Date.now());
  return getUserById(id)!;
}

export function getUserById(id: string): UserRow | null {
  return (getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow) ?? null;
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
  // Use node:crypto without importing top-level (keep this file synchronous-init friendly).
  // We do an explicit require so initDb itself doesn't depend on ESM-only crypto.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return randomBytes(bytes).toString('hex');
}