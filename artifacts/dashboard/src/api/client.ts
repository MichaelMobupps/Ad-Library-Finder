export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type JobSource = 'meta' | 'affplus';
export type JobPhase =
  | 'queued'
  | 'starting'
  | 'scraping'
  | 'classifying'
  | 'building_csv'
  | 'done'
  | 'failed';

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
  // Coarse pipeline phase (additive). May be null for old jobs created
  // before this column existed; UI derives a sensible default from status.
  phase: JobPhase | null;
  phase_detail: string | null;
  phase_updated_at: number | null;
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

  createJobs: (
    countries: string[],
    productTypes: ProductType[],
    recipientEmail?: string | null,
    source?: JobSource
  ) =>
    fetchJson<{ jobs: Job[] }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ countries, productTypes, recipientEmail, source }),
    }),

  csvUrl: (id: string) => `/api/jobs/${id}/csv`,

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
  'building_csv',
  'done',
];

const PHASE_LABEL: Record<JobPhase, string> = {
  queued: 'Queued',
  starting: 'Starting browser',
  scraping: 'Scraping',
  classifying: 'Classifying',
  building_csv: 'Building CSV',
  done: 'Done',
  failed: 'Failed',
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