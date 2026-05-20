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
  `);

  // Idempotent additive migrations: add columns if missing (batch 2)
  const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
  const colNames = new Set(jobCols.map((c) => c.name));
  if (!colNames.has('recipient_email')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN recipient_email TEXT`);
  }
  if (!colNames.has('notification_status')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN notification_status TEXT`);
  }

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
}): JobRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, product_type, countries, status, created_at, total_ads_scraped, total_advertisers, recipient_email)
       VALUES (?, ?, ?, 'pending', ?, 0, 0, ?)`
    )
    .run(
      input.id,
      input.productType,
      JSON.stringify(input.countries),
      now,
      input.recipientEmail ?? null
    );
  return getJob(input.id)!;
}

export function getJob(id: string): JobRow | null {
  return (getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow) ?? null;
}

export function listJobs(): JobRow[] {
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
