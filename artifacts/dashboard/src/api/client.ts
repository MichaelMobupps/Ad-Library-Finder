export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'deferred';
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
  | 'deferred';

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
}

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