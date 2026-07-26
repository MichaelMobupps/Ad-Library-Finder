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

export interface Job {
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
  notification_status: string | null;
  created_by_user_id: string | null;
  source: JobSource;
  source_params: string | null;
  // Coarse pipeline phase (additive). May be null for old jobs created
  // before this column existed; UI derives a sensible default from status.
  phase: JobPhase | null;
  phase_detail: string | null;
  phase_updated_at: number | null;
  // Per-HQ-country .zip bundle path (mobile jobs, and Google Ads web jobs).
  // Presence (not just product_type) gates the HQ-split download button.
  hq_zip_path: string | null;
  /** 1 when a Stop was requested; the pipeline is unwinding. */
  cancel_requested: number;
  /** LIVE "leads so far" counter — updates while the job runs. */
  leads_found: number;
  /** Overall progress 0..100 across EVERY task the pipeline performs —
   *  reported by the pipeline itself (weighted phase spans), live. */
  progress_pct: number;
}

/** Admin Activity row: a job plus who started it. */
export type ActivityJob = Job & { creator_email: string | null; creator_name: string | null };

export interface JobLog {
  id: number;
  job_id: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  ts: number;
}

export interface Me {
  id: string;
  email: string;
  name: string | null;
  /** Admin sees the cross-user Activity view + Publishers, and can stop any job. */
  isAdmin: boolean;
}

export interface Settings {
  userEmail: string;
  userName: string | null;
  gmailConnected: boolean;
  gmailEmail: string | null;
  defaultRecipient: string | null;
}

export interface AppgoblinCategory {
  id: string;
  name: string;
  type: string;
  android: number;
  ios: number;
  total_apps: number;
}

export interface GoogleAdsVertical {
  id: string;
  label: string;
  hint: string;
}

export interface GoogleAdsLanguage {
  code: string;
  label: string;
  native: string;
}

export interface GoogleAdsMeta {
  verticals: GoogleAdsVertical[];
  languages: GoogleAdsLanguage[];
  stats: { total: number; languages: number; verticals: number };
}

export interface GoogleAdsOptions {
  verticals?: string[] | null;
  languages?: string[] | null;
  maxKeywords?: number | null;
  customKeywords?: string[] | null;
  region?: string | null;
}

// ---- store-first discovery (app stores are the discovery engine; GATC/Meta confirm) ----

export interface StoreVertical {
  id: string;
  label: string;
}

export interface StoreFirstConfig {
  verticals: StoreVertical[];
  markets: string[];
  defaults: { verticals: string[]; markets: string[] };
  charts: { play: string[]; apple: string[] };
  installBand: { min: number; max: number };
}

export interface StoreFirstOptions {
  verticals?: string[] | null;
  markets?: string[] | null;
  similarMaxAppsPerRun?: number | null;
  searchTermsLimit?: number | null;
  confirmationMaxApiCalls?: number | null;
}

/** One row of the publisher table — the primary store-first view. */
export interface Publisher {
  id: number;
  name: string;
  email: string | null;
  website: string | null;
  previewUrl: string | null;
  previewTitle: string | null;
  verticals: string[];
  /** Every country this publisher's apps were sighted in (chart or long tail). */
  markets: string[];
  /** Subset of `markets` where an app actually charted (drives the rank score). */
  marketsCharted: string[];
  /** discovery source → app count, e.g. { chart: 3, similar: 11, search: 2 }. */
  sourceMix: Record<string, number>;
  chartedAppCount: number;
  appCount: number;
  bestRank: number | null;
  bothStores: boolean;
  inBand: boolean;
  isCharted: boolean;
  gatcAdsCount: number | null;
  gatcAdvertiserId: string | null;
  metaActiveAds: number | null;
  confirmed: boolean;
  isGame: boolean;
  score: number;
}

/** Counts for the discovery-funnel widget. */
export interface DiscoveryFunnel {
  bySource: Record<string, number>;
  totalApps: number;
  enriched: number;
  inBand: number;
  publishers: number;
  confirmed: number;
}

export interface PublishersResponse {
  /**
   * The matching publishers, score desc — capped server-side to bound the
   * payload, so this is a page, NOT the whole match set. Use `total` for counts.
   */
  publishers: Publisher[];
  /** Publishers matching the active filters, across the whole table. */
  total: number;
  /** Publishers in the whole table, filters ignored — the honest grand total. */
  totalUnfiltered: number;
  /** Dropdown options, derived server-side from the unfiltered table. */
  facets: { verticals: string[]; markets: string[] };
  funnel: DiscoveryFunnel;
}

export interface CreateJobOptions {
  countries: string[];
  productTypes: ProductType[];
  recipientEmail?: string | null;
  source?: JobSource;
  appgoblinCategory?: string | null;
  appgoblinAdNetwork?: string | null;
  googleAds?: GoogleAdsOptions | null;
  storeFirst?: StoreFirstOptions | null;
  /** Cap on exported leads (20/50/100); null = as many as found. */
  maxLeads?: number | null;
}

/** Lead-count choices offered for the two high-volume sources. null = all. */
export const LEAD_LIMIT_CHOICES: readonly number[] = [20, 50, 100];

/**
 * Upper bound for the New Job form's custom lead box.
 *
 * MIRROR of LEAD_LIMIT_CUSTOM_MAX in api-server/src/csv.ts — the dashboard is a
 * separate workspace package and mirrors these the same way LEAD_LIMIT_CHOICES
 * and countries.ts already do. The server pins this value in its offline
 * assertions, so a change there fails the suite and flags this copy.
 *
 * It is a typo guard, not a server restriction: the API itself still honours any
 * positive integer (normalizeMaxLeads), so ops can pass more via a direct call.
 */
export const LEAD_LIMIT_CUSTOM_MAX = 100_000;

/**
 * Validate a hand-typed lead count. Returns the integer, or null when the text
 * is not a usable whole number in range.
 *
 * MIRROR of parseCustomLeadCount in api-server/src/csv.ts — keep the two in step.
 * Rejects decimals rather than flooring them: someone typing "2.5" meant
 * something, and quietly exporting 2 leads is exactly the sort of silent
 * surprise this codebase avoids.
 */
export function parseCustomLeadCount(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null; // digits only: no decimals, signs, spaces, 1e3
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n <= 0 || n > LEAD_LIMIT_CUSTOM_MAX) return null;
  return n;
}

export class AuthRequiredError extends Error {
  constructor() { super('authentication required'); this.name = 'AuthRequiredError'; }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (res.status === 401) {
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => fetchJson<{ ok: boolean }>('/api/health'),

  // ---- auth / me ----
  getMe: () => fetchJson<Me>('/api/me'),
  logout: () => fetchJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  startGoogleSignInUrl: () => '/api/auth/google',

  // ---- jobs ----
  listJobs: () => fetchJson<{ jobs: Job[] }>('/api/jobs').then((r) => r.jobs),

  getJob: (id: string) => fetchJson<{ job: Job; logs: JobLog[] }>(`/api/jobs/${id}`),

  createJobs: (opts: CreateJobOptions) =>
    fetchJson<{ jobs: Job[] }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  /** Stop a running/pending job. Partial results are kept. */
  stopJob: (id: string) =>
    fetchJson<{ job: Job }>(`/api/jobs/${id}/stop`, { method: 'POST' }).then((r) => r.job),

  /** Re-queue a stopped/failed job under the same id — it continues where the
   *  durable state left off (store_first resumes exactly; others replay safely). */
  resumeJob: (id: string) =>
    fetchJson<{ job: Job }>(`/api/jobs/${id}/resume`, { method: 'POST' }).then((r) => r.job),

  /** Admin only: every user's jobs, for the Activity view. */
  activity: () => fetchJson<{ jobs: ActivityJob[] }>('/api/jobs/activity').then((r) => r.jobs),

  csvUrl: (id: string) => `/api/jobs/${id}/csv`,
  hqZipUrl: (id: string) => `/api/jobs/${id}/hq-zip`,

  // ---- appgoblin ----
  appgoblinCategories: () =>
    fetchJson<{ categories: AppgoblinCategory[] }>('/api/jobs/appgoblin-categories').then((r) => r.categories),

  // ---- google ads ----
  googleAdsMeta: () => fetchJson<GoogleAdsMeta>('/api/jobs/google-ads-verticals'),

  // ---- store-first discovery ----
  storeFirstConfig: () => fetchJson<StoreFirstConfig>('/api/jobs/store-first-config'),

  /**
   * `params` is a pre-encoded query string of the active Publishers filters —
   * the same ones the CSV export takes. Filtering is server-side because the row
   * list is capped: filtering the returned page would hide every publisher that
   * sits below the cap by score.
   */
  publishers: (params = '') =>
    fetchJson<PublishersResponse>(`/api/jobs/publishers${params ? `?${params}` : ''}`),

  /** `params` is a pre-encoded query string of the active Publishers filters. */
  publishersCsvUrl: (params = '') => `/api/jobs/publishers.csv${params ? `?${params}` : ''}`,

  // ---- settings ----
  getSettings: () => fetchJson<Settings>('/api/settings'),

  setRecipient: (email: string) =>
    fetchJson<{ defaultRecipient: string | null }>('/api/settings/recipient', {
      method: 'PUT',
      body: JSON.stringify({ email }),
    }),

  disconnectGmail: () =>
    fetchJson<{ ok: boolean }>('/api/settings/disconnect-gmail', { method: 'POST' }),

  sendTestEmail: () =>
    fetchJson<{ ok: boolean }>('/api/settings/test-email', { method: 'POST' }),
};

// ---------- phase helpers ----------

const PHASE_ORDER: JobPhase[] = [
  'queued',
  'starting',
  'scraping',
  'classifying',
  'enriching',
  'building_csv',
  'done',
];

const PHASE_LABEL: Record<JobPhase, string> = {
  queued: 'Queued',
  starting: 'Starting',
  scraping: 'Scraping',
  classifying: 'Classifying',
  enriching: 'Categorizing apps',
  building_csv: 'Building CSV',
  hq_splitting: 'HQ split',
  done: 'Done',
  failed: 'Failed',
  deferred: 'Deferred',
  cancelled: 'Stopped',
};

/**
 * Derive a phase to show in the UI. New jobs have job.phase set; old jobs
 * (created before the phase column existed) have phase=null and we
 * synthesize one from status so the UI never shows "undefined".
 */
export function derivePhase(job: Job): JobPhase {
  if (job.phase) return job.phase;
  switch (job.status) {
    case 'pending': return 'queued';
    case 'running': return 'scraping'; // best guess; old running jobs had no finer signal
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'deferred': return 'deferred'; // LLM daily cap; resumes after Jerusalem midnight
    case 'cancelled': return 'cancelled'; // user pressed Stop
  }
}

/** True while the job can still be stopped. */
export function jobIsStoppable(job: Job): boolean {
  return (
    (job.status === 'pending' || job.status === 'running' || job.status === 'deferred') &&
    job.cancel_requested !== 1
  );
}

/**
 * Overall progress of a job as 0..100.
 *
 * Primary signal: `progress_pct`, reported live by the pipeline itself and
 * covering EVERY task it performs (charts, crawls, enrichment, verification,
 * CSV, HQ split…). Fallbacks keep old rows honest: leads-vs-cap, and for jobs
 * predating the column a coarse phase-index estimate. Completed pins to 100.
 */
export function jobProgressPct(job: Job): number {
  if (job.status === 'completed') return 100;
  const serverPct = Math.round(job.progress_pct || 0);
  const cap = jobMaxLeads(job);
  const leadPct = cap ? Math.min(100, Math.round((job.leads_found / cap) * 100)) : 0;
  if (serverPct > 0) return Math.max(serverPct, leadPct);
  // Old rows (or the first instants of a run): coarse phase-based estimate.
  const idx = PHASE_ORDER.indexOf(derivePhase(job));
  const phasePct = idx >= 0 ? Math.round((idx / (PHASE_ORDER.length - 1)) * 100) : 0;
  return Math.max(phasePct, leadPct);
}

/** True when the job can be re-queued (Resume/Retry button). */
export function jobIsResumable(job: Job): boolean {
  return job.status === 'cancelled' || job.status === 'failed';
}

/** The job's lead cap (maxLeads) if one was chosen, else null. */
export function jobMaxLeads(job: Job): number | null {
  if (!job.source_params) return null;
  try {
    const p = JSON.parse(job.source_params) as Record<string, unknown>;
    const n = Number(p.maxLeads);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

export function phaseLabel(p: JobPhase): string {
  return PHASE_LABEL[p];
}

export function phaseProgress(p: JobPhase): { index: number; total: number } {
  // For the stepper. 'failed' floats outside the happy path.
  if (p === 'failed') return { index: -1, total: PHASE_ORDER.length };
  const idx = PHASE_ORDER.indexOf(p);
  return { index: idx, total: PHASE_ORDER.length };
}

export const PHASE_STEPS: JobPhase[] = PHASE_ORDER;