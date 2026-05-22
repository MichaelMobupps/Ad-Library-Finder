export type ProductType = 'mobile' | 'cps';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

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
    recipientEmail?: string | null
  ) =>
    fetchJson<{ jobs: Job[] }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ countries, productTypes, recipientEmail }),
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