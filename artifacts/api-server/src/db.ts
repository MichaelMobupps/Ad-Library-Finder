/**
 * Job / user / result storage.
 *
 * The ENGINE changed in order L-3.4g and nothing else about this module's
 * contract did: same tables, same column names, same row shapes, same helper
 * names. What moved is where the bytes live — from a `better-sqlite3` file on
 * the deployment disk (wiped by every publish) to the platform-provisioned
 * PostgreSQL behind `DATABASE_URL`.
 *
 * Every helper here is now `async`, because a network database cannot be read
 * synchronously. `getDb()` still hands back something with `.prepare(sql)` on
 * it, so the SQL each call site wrote is the SQL it still runs; see sql.ts for
 * why that shape was kept and what it does NOT do.
 */
import { randomBytes } from 'node:crypto';
import { runStoreDiscoveryBootRepairs } from './storeDiscoveryDb.js';
import { ensureChiefPrincipal } from './chief.js';
import { seedRescuedChiefJobs } from './rescueSeed.js';
import { openDatabase, sql, type Db, type SqlHandle } from './sql.js';
import { applyMigrations } from './migrations.js';
import { log } from './logger.js';

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

/**
 * Open the database, bring the schema up to date, and settle whatever the last
 * process left behind. Throws — loudly, with no fallback — if `DATABASE_URL` is
 * unset or the backend cannot be reached.
 */
export async function initDb() {
  const backend = await openDatabase();

  const migrations = await applyMigrations(sql(), { adopt: process.env.LEADFINDER_DB_ADOPT === '1' });
  const state =
    migrations.applied.length > 0
      ? `applied ${migrations.applied.join(', ')}`
      : migrations.adopted.length > 0
        ? `ADOPTED ${migrations.adopted.join(', ')}`
        : 'already current';
  // The one boot line that names the backend. `describeBackend` (sql.ts) yields
  // host:port/database and nothing else — no user, no password, no raw URL.
  log.info(`db: postgres ${backend} — migrations ${state} (schema ${migrations.current.join(', ')})`);

  // The Chief's system principal, and the one-off repair of legacy
  // discovery_depth rows. Both idempotent; both used to live inside the
  // "ensure the tables exist" helpers, which migrations.ts now owns instead.
  await ensureChiefPrincipal();
  await runStoreDiscoveryBootRepairs();

  // The two chief jobs rescued from the live seam before this migration, so
  // `lf_job_id` / `lf_lead_id` still resolve for the Chief. Idempotent.
  await seedRescuedChiefJobs();

  // Garbage-collect expired sessions on startup
  await getDb().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());

  // On startup, settle jobs that were 'running' when the process died. A job
  // whose user had ALREADY pressed Stop resolves to 'cancelled' (that is what
  // the pipeline would have done had it lived to poll the flag); the rest are
  // failures. Order matters: the cancelled sweep must run first or the failed
  // sweep would claim its rows.
  await getDb()
    .prepare(
      `UPDATE jobs SET status='cancelled', phase='cancelled', phase_detail='stopped by user (server restarted before finalize)', completed_at=? WHERE status='running' AND cancel_requested=1`
    )
    .run(Date.now());
  await getDb()
    .prepare(
      `UPDATE jobs SET status='failed', phase='failed', error='process restarted mid-job', completed_at=? WHERE status='running'`
    )
    .run(Date.now());
}

export function getDb(): Db {
  return sql();
}

// ---------- Job helpers ----------

export async function createJob(
  input: {
    id: string;
    productType: ProductType;
    countries: string[];
    recipientEmail?: string | null;
    createdByUserId: string;
    source?: JobSource;
    sourceParams?: Record<string, unknown> | null;
  },
  /**
   * Optional transaction handle. A caller that must write this job and
   * something else atomically (chief.ts pairs it with its idempotency-ledger
   * row) passes the handle its transaction gave it; a statement issued through
   * getDb() instead would run on a different pooled connection and land outside
   * that transaction. Defaults to the pool, which is what every other caller
   * wants.
   */
  h: SqlHandle = getDb(),
): Promise<JobRow> {
  const now = Date.now();
  await h
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
  return (await getJob(input.id, h))!;
}

export async function getJob(id: string, h: SqlHandle = getDb()): Promise<JobRow | null> {
  return ((await h.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id)) as JobRow) ?? null;
}

export async function listJobsForUser(userId: string): Promise<JobRow[]>{
  return await getDb()
    .prepare(`SELECT * FROM jobs WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT 200`)
    .all(userId) as JobRow[];
}

export async function listAllJobs(): Promise<JobRow[]>{
  return await getDb().prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`).all() as JobRow[];
}

export type ActivityJobRow = JobRow & { creator_email: string | null; creator_name: string | null };

/** All jobs across ALL users with the creator's identity — the admin Activity view. */
export async function listAllJobsWithUsers(limit = 200): Promise<ActivityJobRow[]>{
  return await getDb()
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
export async function listRunnableJobs(limit = 50): Promise<JobRow[]>{
  return await getDb()
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

export async function markJobRunning(id: string) {
  const now = Date.now();
  // leads_found and progress_pct reset to 0: a deferred/resumed job replays
  // from the top (pipelines clear/skip their partials), so stale counters from
  // the prior attempt would overstate progress until the first live update.
  // Guard: never resurrects a job stopped between dispatch and this write.
  await getDb()
    .prepare(
      `UPDATE jobs SET status='running', started_at=?, leads_found=0, progress_pct=0, phase='starting', phase_detail='launching browser', phase_updated_at=? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
    )
    .run(now, now, id);
}

export async function markJobCompleted(id: string, csvPath: string, counts: { ads: number; advertisers: number }) {
  const now = Date.now();
  await getDb()
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
export async function setJobProgress(id: string, pct: number) {
  const clamped = Math.max(0, Math.min(100, pct));
  await getDb()
    .prepare(
      `UPDATE jobs SET progress_pct = GREATEST(progress_pct, ?) WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`
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
export async function resumeJob(id: string): Promise<boolean>{
  const job = await getJob(id);
  if (!job) return false;
  if (job.status !== 'cancelled' && job.status !== 'failed') return false;
  const now = Date.now();
  await getDb()
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
export async function markJobCancelled(id: string, detail: string, csvPath?: string | null) {
  const now = Date.now();
  if (csvPath) {
    // Unguarded on purpose: pointing csv_path at a partial export is useful
    // even when the watchdog already failed the job.
    await getDb().prepare(`UPDATE jobs SET csv_path=? WHERE id = ?`).run(csvPath, id);
  }
  await getDb()
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
export async function requestJobCancel(id: string): Promise<boolean>{
  const job = await getJob(id);
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return false;
  await getDb().prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ?`).run(id);
  if (job.status === 'pending' || job.status === 'deferred') {
    await markJobCancelled(id, 'stopped by user before start');
  } else {
    const now = Date.now();
    await getDb()
      .prepare(`UPDATE jobs SET phase_detail=?, phase_updated_at=? WHERE id = ?`)
      .run('stopping — finishing current step…', now, id);
  }
  return true;
}

/** Live "leads so far" counter — cheap single-column update, called mid-run. */
export async function setJobLeadsFound(id: string, n: number) {
  await getDb()
    .prepare(`UPDATE jobs SET leads_found = ? WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`)
    .run(n, id);
}

export async function markJobFailed(id: string, error: string) {
  const now = Date.now();
  await getDb()
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
export async function deferJob(id: string, runAfter: number, detail: string) {
  const now = Date.now();
  await getDb()
    .prepare(
      `UPDATE jobs SET status='deferred', run_after=?, phase='deferred', phase_detail=?, phase_updated_at=? WHERE id = ? AND status='running'`
    )
    .run(runAfter, detail.slice(0, 200), now, id);
}

export async function setJobPhase(id: string, phase: JobPhase, detail?: string | null) {
  const now = Date.now();
  // Guard: a watchdog-failed job's zombie pipeline must not make the row look
  // alive again by stamping fresh phases onto it.
  await getDb()
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
export async function jobHeartbeatAt(id: string): Promise<number | null>{
  const row = await getDb()
    .prepare(
      `SELECT GREATEST(COALESCE(phase_updated_at, started_at, created_at),
                       COALESCE((SELECT MAX(ts) FROM job_logs WHERE job_id = jobs.id), 0)) AS beat
         FROM jobs WHERE id = ?`
    )
    .get(id) as { beat: number | null } | undefined;
  return row?.beat ?? null;
}

export async function setJobNotificationStatus(id: string, status: 'sent' | 'failed') {
  await getDb().prepare(`UPDATE jobs SET notification_status=? WHERE id = ?`).run(status, id);
}

export async function setJobHqZipPath(id: string, zipPath: string | null) {
  await getDb().prepare(`UPDATE jobs SET hq_zip_path=? WHERE id = ?`).run(zipPath, id);
}

/**
 * Point job.csv_path at a file BEFORE the job finishes. Pipelines that flush a
 * partial CSV incrementally call this on the first flush so the download route
 * (which 404s while csv_path is null) can serve the growing file — and so a job
 * that is later blocked, interrupted, or marked failed still leaves everything
 * scraped so far downloadable. markJobCompleted overwrites it with the same
 * path at the end; markJobFailed leaves it intact.
 */
export async function setJobCsvPath(id: string, csvPath: string) {
  await getDb().prepare(`UPDATE jobs SET csv_path=? WHERE id = ?`).run(csvPath, id);
}

// ---------- Log helpers ----------

export async function appendLog(jobId: string, level: JobLogRow['level'], message: string) {
  await getDb()
    .prepare(`INSERT INTO job_logs (job_id, level, message, ts) VALUES (?, ?, ?, ?)`)
    .run(jobId, level, message, Date.now());
}

export async function getLogs(jobId: string): Promise<JobLogRow[]>{
  return await getDb().prepare(`SELECT * FROM job_logs WHERE job_id = ? ORDER BY ts ASC`).all(jobId) as JobLogRow[];
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
export async function existingLeadIdentities(): Promise<{ names: string[]; urls: string[]; }>{
  const rows = await getDb()
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

export async function insertResult(input: {
  job_id: string;
  advertiser_name: string;
  page_url: string | null;
  landing_url: string | null;
  classification: string | null;
  store_url: string | null;
  ad_text: string | null;
  country: string;
}) {
  await getDb()
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

export async function getResults(jobId: string): Promise<JobResultRow[]>{
  return await getDb()
    .prepare(`SELECT * FROM job_results WHERE job_id = ? ORDER BY id ASC`)
    .all(jobId) as JobResultRow[];
}

/** Set the app-category enrichment fields on a single result row.
 *  is_game: true→1, false→0, null→NULL (unknown/unclassified). */
export async function setResultCategory(resultId: number, appCategory: string | null, isGame: boolean | null): Promise<void>{
  await getDb()
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
export async function clearJobResults(jobId: string) {
  await getDb().prepare(`DELETE FROM job_results WHERE job_id = ?`).run(jobId);
}

// ---------- User helpers ----------

export async function getUserByEmail(email: string): Promise<UserRow | null>{
  return (await getDb().prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow) ?? null;
}

export async function getUserById(id: string): Promise<UserRow | null>{
  return (await getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow) ?? null;
}

export async function upsertUser(input: { id?: string; email: string; name?: string | null }): Promise<UserRow>{
  const existing = await getUserByEmail(input.email);
  if (existing) {
    if (input.name && input.name !== existing.name) {
      await getDb().prepare(`UPDATE users SET name = ? WHERE id = ?`).run(input.name, existing.id);
      return { ...existing, name: input.name };
    }
    return existing;
  }
  const id = input.id ?? `usr_${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  await getDb()
    .prepare(
      `INSERT INTO users (id, email, name, default_recipient, created_at) VALUES (?, ?, ?, NULL, ?)`
    )
    .run(id, input.email, input.name ?? null, now);
  return (await getUserById(id))!;
}

export async function setUserDefaultRecipient(userId: string, recipient: string | null) {
  await getDb().prepare(`UPDATE users SET default_recipient = ? WHERE id = ?`).run(recipient, userId);
}

// ---------- Session helpers ----------

export async function createSession(userId: string, ttlMs: number): Promise<SessionRow>{
  const token = cryptoRandom(40);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await getDb()
    .prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now, expiresAt);
  return { token, user_id: userId, created_at: now, expires_at: expiresAt };
}

export async function getSessionUser(token: string): Promise<UserRow | null>{
  const row = await getDb()
    .prepare(`SELECT * FROM sessions WHERE token = ?`)
    .get(token) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await deleteSession(token);
    return null;
  }
  return await getUserById(row.user_id);
}

export async function deleteSession(token: string) {
  await getDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// ---------- Gmail token helpers ----------

export async function getGmailTokensForUser(userId: string): Promise<GmailTokenRow | null>{
  return (await getDb().prepare(`SELECT * FROM gmail_tokens WHERE user_id = ?`).get(userId) as GmailTokenRow) ?? null;
}

export async function upsertGmailTokens(input: {
  userId: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  gmailEmail?: string | null;
}) {
  const existing = await getGmailTokensForUser(input.userId);
  const now = Date.now();
  if (!existing) {
    await getDb()
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
  await getDb()
    .prepare(
      `UPDATE gmail_tokens
       SET access_token = ?, refresh_token = ?, expires_at = ?, gmail_email = ?, updated_at = ?
       WHERE user_id = ?`
    )
    .run(next.access_token, next.refresh_token, next.expires_at, next.gmail_email, now, input.userId);
}

export async function deleteGmailTokens(userId: string) {
  await getDb().prepare(`DELETE FROM gmail_tokens WHERE user_id = ?`).run(userId);
}

// ---------- internal ----------

function cryptoRandom(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
// Backwards-compat alias used by routes-auth.ts
export async function upsertUserByEmail(email: string, name?: string | null): Promise<UserRow>{
  return await upsertUser({ email, name });
}