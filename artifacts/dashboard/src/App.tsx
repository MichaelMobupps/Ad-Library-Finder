import { useEffect, useState, useCallback } from 'react';
import {
  api,
  Job,
  JobLog,
  ActivityJob,
  JobPhase,
  Settings,
  Me,
  AuthRequiredError,
  derivePhase,
  phaseLabel,
  jobIsStoppable,
  jobMaxLeads,
  PHASE_STEPS,
} from './api/client';
import Publishers from './Publishers';
import GoogleAdsForm from './GoogleAdsForm';

type View =
  | { kind: 'publishers' }
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'detail'; id: string }
  | { kind: 'activity' }
  | { kind: 'settings' };
type AuthState = { kind: 'loading' } | { kind: 'anon' } | { kind: 'signed-in'; me: Me };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

  const checkAuth = useCallback(async () => {
    try {
      const me = await api.getMe();
      setAuth({ kind: 'signed-in', me });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        setAuth({ kind: 'anon' });
      } else {
        console.error('auth check failed', err);
        setAuth({ kind: 'anon' });
      }
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (auth.kind === 'loading') {
    return <div className="app"><div className="empty"><p>Loading…</p></div></div>;
  }
  if (auth.kind === 'anon') {
    return <LoginScreen />;
  }
  return <AuthedApp me={auth.me} onSignOut={() => setAuth({ kind: 'anon' })} />;
}

// -------- Login screen --------

function LoginScreen() {
  return (
    <div className="app">
      <div className="empty" style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
        <div className="brand" style={{ justifyContent: 'center', marginBottom: 24 }}>
          <span className="brand-mark">▰▰</span>
          <span className="brand-name">AD LIBRARY FINDER</span>
        </div>
        <p className="empty-title">Sign in to continue</p>
        <p className="empty-sub">Access is limited to @mobupps.com Google accounts.</p>
        <a className="btn primary" href="/api/auth/google" style={{ marginTop: 16, display: 'inline-block' }}>
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

// -------- Authed app shell --------

function AuthedApp({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  // The unified Google Ads form is the landing view — the one thing every user
  // needs. Publishers (the admin corpus browser) moved behind the admin flag.
  const [view, setView] = useState<View>({ kind: 'new' });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);

  const handleAuthError = useCallback((err: unknown) => {
    if (err instanceof AuthRequiredError) {
      onSignOut();
      return true;
    }
    return false;
  }, [onSignOut]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listJobs();
      setJobs(list);
    } catch (err) {
      if (!handleAuthError(err)) console.error(err);
    }
  }, [handleAuthError]);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch (err) {
      if (!handleAuthError(err)) console.error(err);
    }
  }, [handleAuthError]);

  useEffect(() => {
    refresh();
    refreshSettings();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, refreshSettings]);

  // On mount, if URL has #/settings (from OAuth callback redirect), switch view
  useEffect(() => {
    if (window.location.hash.startsWith('#/settings')) {
      setView({ kind: 'settings' });
      window.history.replaceState(null, '', window.location.pathname + '#/settings');
    }
  }, []);

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    onSignOut();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▰▰</span>
          <span className="brand-name">AD LIBRARY FINDER</span>
        </div>
        <nav>
          <button
            className={`nav-btn ${view.kind === 'new' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'new' })}
            title="Find Mobile or CPS leads from Google Ads — the one unified search"
          >
            Google Ads
          </button>
          <button className={`nav-btn ${view.kind === 'list' ? 'active' : ''}`} onClick={() => setView({ kind: 'list' })}>
            My Jobs
          </button>
          {me.isAdmin && (
            <button
              className={`nav-btn ${view.kind === 'publishers' ? 'active' : ''}`}
              onClick={() => setView({ kind: 'publishers' })}
              title="The discovered-publisher corpus (admin only)"
            >
              Publishers
            </button>
          )}
          {me.isAdmin && (
            <button
              className={`nav-btn ${view.kind === 'activity' ? 'active' : ''}`}
              onClick={() => setView({ kind: 'activity' })}
              title="All users' scraping jobs — running and past (admin only)"
            >
              Activity
            </button>
          )}
          <button className={`nav-btn ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
            Settings
          </button>
          <span className="nav-user" style={{ marginLeft: 16, color: 'var(--text-mute)', fontSize: 13 }}>
            {me.email}
          </span>
          <button className="nav-btn ghost" onClick={signOut} title="Sign out">Sign out</button>
        </nav>
      </header>

      <main>
        {view.kind === 'publishers' && me.isAdmin && <Publishers onAuthError={handleAuthError} />}
        {view.kind === 'list' && (
          <JobsList
            jobs={jobs}
            onSelect={(id) => setView({ kind: 'detail', id })}
            onNew={() => setView({ kind: 'new' })}
            onChanged={refresh}
          />
        )}
        {view.kind === 'activity' && me.isAdmin && <ActivityView onAuthError={handleAuthError} />}
        {view.kind === 'new' && (
          <GoogleAdsForm
            settings={settings}
            onCreated={() => {
              refresh();
              setView({ kind: 'list' });
            }}
          />
        )}
        {view.kind === 'detail' && <JobDetail id={view.id} onBack={() => setView({ kind: 'list' })} />}
        {view.kind === 'settings' && <SettingsView settings={settings} onChange={refreshSettings} />}
      </main>
    </div>
  );
}

/**
 * Display name for a job source. The stored id stays `store_first` — it is the
 * engine's name, written into every existing job row and every API contract — so
 * the rename lives here, at the one place a user reads it.
 */
const SOURCE_LABELS: Record<string, string> = {
  store_first: 'GOOGLE ADS - MOBILE',
  google_ads: 'GOOGLE ADS - CPS',
};
function sourceLabel(source: string | null | undefined): string {
  const s = source || 'meta';
  return SOURCE_LABELS[s] || s.toUpperCase();
}

// -------- Stop button (shared by Jobs list, Job detail, Activity) --------

function StopButton({ job, onStopped, small }: { job: Job; onStopped: () => void; small?: boolean }) {
  const [stopping, setStopping] = useState(false);
  if (!jobIsStoppable(job)) return null;
  const stop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Stop this scraping job? Everything found so far is kept and exported.')) return;
    setStopping(true);
    try {
      await api.stopJob(job.id);
      onStopped();
    } catch (err) {
      alert(`Could not stop the job: ${(err as Error).message}`);
    } finally {
      setStopping(false);
    }
  };
  return (
    <button
      className={`btn danger ${small ? 'small' : ''}`}
      onClick={stop}
      disabled={stopping}
      title="Stop this job — leads found so far are kept"
    >
      {stopping ? 'Stopping…' : '■ Stop'}
    </button>
  );
}

/** Live "leads so far" cell: counter while running, final count when done. */
function LeadsCell({ job }: { job: Job }) {
  const active = job.status === 'pending' || job.status === 'running';
  const n = active ? job.leads_found : job.total_advertisers || job.leads_found;
  const cap = jobMaxLeads(job);
  if (!active) return <>{n || '—'}</>;
  return (
    <span className="leads-live" title="Leads found so far — updates live">
      <span className="leads-live-dot" />
      {n}
      {cap ? <span className="muted"> / {cap}</span> : null}
    </span>
  );
}

// -------- Jobs List --------

function JobsList({
  jobs,
  onSelect,
  onNew,
  onChanged,
}: {
  jobs: Job[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onChanged: () => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No searches yet</p>
        <p className="empty-sub">Start a Google Ads search — pick Mobile or CPS, your countries and how many leads you want.</p>
        <button className="btn primary" onClick={onNew}>🔍 New search</button>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Jobs</h2>
        <span className="panel-meta">{jobs.length} total</span>
      </div>
      <table className="jobs-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Source</th>
            <th>Type</th>
            <th>Countries</th>
            <th>Status</th>
            <th>Phase</th>
            <th>Leads</th>
            <th>Recipient</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} onClick={() => onSelect(j.id)} className="jobs-row">
              <td className="mono">{j.id}</td>
              <td><span className={`tag tag-${j.source || 'meta'}`}>{sourceLabel(j.source)}</span></td>
              <td><span className={`tag tag-${j.product_type}`}>{j.product_type.toUpperCase()}</span></td>
              <td className="mono small">{(JSON.parse(j.countries) as string[]).join(', ')}</td>
              <td><StatusBadge status={j.status} /></td>
              <td className="small">
                <RowPhaseCell job={j} />
              </td>
              <td className="mono"><LeadsCell job={j} /></td>
              <td className="small muted">{j.recipient_email || '(default)'}</td>
              <td className="small">{new Date(j.created_at).toLocaleString()}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {(j.status === 'completed' || j.status === 'cancelled') && j.csv_path && (
                  <a href={api.csvUrl(j.id)} className="btn small">
                    Download CSV
                  </a>
                )}
                <StopButton job={j} onStopped={onChanged} small />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: Job['status'] }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

function RowPhaseCell({ job }: { job: Job }) {
  if (job.status === 'completed' || job.status === 'failed') {
    return <span className="muted">—</span>;
  }
  const phase = derivePhase(job);
  return (
    <span className="phase-pill" title={job.phase_detail || ''}>
      <span className="phase-pill-dot" />
      <span className="phase-pill-label">{phaseLabel(phase)}</span>
    </span>
  );
}

// -------- Job Detail --------

function JobDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { job, logs } = await api.getJob(id);
        if (cancelled) return;
        setJob(job);
        setLogs(logs);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!job) return <div className="empty"><p>Loading…</p></div>;

  const countries = JSON.parse(job.countries) as string[];
  const isActive = job.status === 'pending' || job.status === 'running';
  const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

  // Pretty-print source params when present (AppGoblin + Google Ads).
  let sourceParamsDisplay: string | null = null;
  if (job.source_params) {
    try {
      const p = JSON.parse(job.source_params) as Record<string, unknown>;
      const parts: string[] = [];
      // AppGoblin
      if (p.category) parts.push(`category=${p.category}`);
      if (p.adNetworkDomain) parts.push(`ad-network=${p.adNetworkDomain}`);
      // Google Ads Transparency
      if (Array.isArray(p.verticals) && p.verticals.length) parts.push(`verticals=${(p.verticals as string[]).join('/')}`);
      if (Array.isArray(p.languages) && p.languages.length) parts.push(`languages=${(p.languages as string[]).join('/')}`);
      if (Array.isArray(p.customKeywords) && p.customKeywords.length) parts.push(`custom keywords=${(p.customKeywords as string[]).length}`);
      if (p.maxKeywords) parts.push(`maxKeywords=${p.maxKeywords}`);
      // Store-first
      if (Array.isArray(p.markets) && p.markets.length) parts.push(`markets=${(p.markets as string[]).join('/')}`);
      if (p.similarMaxAppsPerRun != null) parts.push(`similarCap=${p.similarMaxAppsPerRun}`);
      if (p.searchTermsLimit != null) parts.push(`searchTerms=${p.searchTermsLimit}`);
      if (p.confirmationMaxApiCalls != null) parts.push(`confirmCap=${p.confirmationMaxApiCalls}`);
      if (parts.length > 0) sourceParamsDisplay = parts.join(', ');
    } catch { /* ignore */ }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <button className="btn ghost" onClick={onBack}>← Back</button>
        <h2 className="mono">{job.id}</h2>
        <StatusBadge status={job.status} />
        <span style={{ marginLeft: 'auto' }}>
          <StopButton job={job} onStopped={() => { /* next poll shows the new state */ }} />
        </span>
      </div>

      <PhaseProgress job={job} latestLog={latestLog} isActive={isActive} />

      <div className="detail-grid">
        <Field label="Source"><span className={`tag tag-${job.source || 'meta'}`}>{sourceLabel(job.source)}</span></Field>
        <Field label="Product Type"><span className={`tag tag-${job.product_type}`}>{job.product_type.toUpperCase()}</span></Field>
        <Field label="Countries"><code>{countries.join(', ')}</code></Field>
        {sourceParamsDisplay && <Field label="Discovery"><code>{sourceParamsDisplay}</code></Field>}
        <Field label="Recipient">{job.recipient_email || <span className="muted">(default)</span>}</Field>
        <Field label="Email">{job.notification_status === 'sent' ? '✓ sent' : job.notification_status === 'failed' ? '✗ failed' : '—'}</Field>
        <Field label="Created">{new Date(job.created_at).toLocaleString()}</Field>
        <Field label="Started">{job.started_at ? new Date(job.started_at).toLocaleString() : '—'}</Field>
        <Field label="Completed">{job.completed_at ? new Date(job.completed_at).toLocaleString() : '—'}</Field>
        <Field label="Ads Scraped">{job.total_ads_scraped}</Field>
        <Field label="Advertisers (CSV)">{job.total_advertisers}</Field>
      </div>

      {(job.status === 'completed' || (job.status === 'cancelled' && job.csv_path)) && (
        <div className="cta-row">
          <a href={api.csvUrl(job.id)} className="btn primary">⬇ Download CSV</a>
          {job.hq_zip_path && (
            <a href={api.hqZipUrl(job.id)} className="btn" style={{ marginLeft: 8 }}>⬇ Excel (by HQ country)</a>
          )}
          {job.status === 'cancelled' && (
            <span className="muted small" style={{ marginLeft: 12 }}>
              Stopped early — the download contains everything found up to the stop.
            </span>
          )}
        </div>
      )}
      {job.status === 'failed' && job.error && (
        <div className="error">Failed: {job.error}</div>
      )}

      <details className="logs-section" open>
        <summary>Logs ({logs.length})</summary>
        <pre className="logs">
          {logs.map((l) => (
            <div key={l.id} className={`log-line log-${l.level}`}>
              <span className="log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className="log-level">[{l.level.toUpperCase()}]</span>
              <span className="log-msg">{l.message}</span>
            </div>
          ))}
        </pre>
      </details>
    </div>
  );
}

function PhaseProgress({
  job,
  latestLog,
  isActive,
}: {
  job: Job;
  latestLog: JobLog | null;
  isActive: boolean;
}) {
  const currentPhase: JobPhase = derivePhase(job);
  const isFailed = currentPhase === 'failed';
  const isCancelled = currentPhase === 'cancelled';
  const currentIdx = isFailed || isCancelled ? -1 : PHASE_STEPS.indexOf(currentPhase);

  const description =
    job.phase_detail ||
    (latestLog ? latestLog.message : phaseLabel(currentPhase));

  // Lead progress: leads found so far, against the chosen cap when there is one.
  const leads = isActive ? job.leads_found : job.total_advertisers || job.leads_found;
  const cap = jobMaxLeads(job);
  const pct = cap ? Math.min(100, Math.round((leads / cap) * 100)) : null;

  return (
    <div className={`phase-progress ${isActive ? 'phase-active' : ''} ${isFailed ? 'phase-failed' : ''}`}>
      <div className="phase-stepper">
        {PHASE_STEPS.map((step, idx) => {
          const state =
            isFailed || isCancelled
              ? 'pending'
              : idx < currentIdx
                ? 'complete'
                : idx === currentIdx
                  ? 'current'
                  : 'pending';
          return (
            <div key={step} className={`phase-step phase-step-${state}`}>
              <div className="phase-step-dot">
                {state === 'complete' ? '✓' : idx + 1}
              </div>
              <div className="phase-step-label">{phaseLabel(step)}</div>
              {idx < PHASE_STEPS.length - 1 && (
                <div className={`phase-step-bar phase-step-bar-${idx < currentIdx ? 'complete' : 'pending'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* The number the user actually cares about: leads so far, live. */}
      <div className="leads-progress">
        <span className="leads-progress-count">
          {isActive && <span className="leads-live-dot" />}
          <strong>{leads}</strong>&nbsp;lead{leads === 1 ? '' : 's'}
          {cap ? <span className="muted"> of {cap} requested</span> : isActive ? <span className="muted"> so far</span> : null}
        </span>
        {pct != null && (
          <span className="leadbar" title={`${pct}% of the requested leads`}>
            <span className="leadbar-fill" style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>

      <div className="phase-description">
        {isActive && <span className="phase-spinner" aria-hidden="true" />}
        <span className="phase-description-label">
          {isFailed ? 'Failed' : phaseLabel(currentPhase)}:
        </span>
        <span className="phase-description-detail">{description}</span>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}

// -------- Activity (admin only) --------

/**
 * Cross-user job monitor: every scraping job on the system — who started it,
 * what it's doing right now, how many leads it has produced — running jobs
 * first. Admin can stop any job from here.
 */
function ActivityView({ onAuthError }: { onAuthError: (err: unknown) => boolean }) {
  const [jobs, setJobs] = useState<ActivityJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.activity();
      setJobs(list);
      setError(null);
    } catch (err) {
      if (onAuthError(err)) return;
      setError((err as Error).message);
    }
  }, [onAuthError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !jobs) return <div className="error">Could not load activity: {error}</div>;
  if (!jobs) return <div className="empty"><p>Loading…</p></div>;

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'pending');
  const past = jobs.filter((j) => j.status !== 'running' && j.status !== 'pending');

  const durationOf = (j: Job): string => {
    const start = j.started_at ?? j.created_at;
    const end = j.completed_at ?? Date.now();
    const mins = Math.max(0, Math.round((end - start) / 60000));
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const table = (rows: ActivityJob[], live: boolean) => (
    <table className="jobs-table">
      <thead>
        <tr>
          <th>Started by</th>
          <th>ID</th>
          <th>Source</th>
          <th>Type</th>
          <th>Status</th>
          <th>Phase</th>
          <th>Leads</th>
          <th>{live ? 'Running for' : 'Duration'}</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((j) => (
          <tr key={j.id}>
            <td className="small">{j.creator_email || <span className="muted">unknown</span>}</td>
            <td className="mono small">{j.id}</td>
            <td><span className={`tag tag-${j.source || 'meta'}`}>{sourceLabel(j.source)}</span></td>
            <td><span className={`tag tag-${j.product_type}`}>{j.product_type.toUpperCase()}</span></td>
            <td><StatusBadge status={j.status} /></td>
            <td className="small">
              {j.status === 'running' ? (
                <span className="phase-pill" title={j.phase_detail || ''}>
                  <span className="phase-pill-dot" />
                  <span className="phase-pill-label">{j.phase_detail || phaseLabel(derivePhase(j))}</span>
                </span>
              ) : (
                <span className="muted">{phaseLabel(derivePhase(j))}</span>
              )}
            </td>
            <td className="mono"><LeadsCell job={j} /></td>
            <td className="small">{durationOf(j)}</td>
            <td className="small">{new Date(j.created_at).toLocaleString()}</td>
            <td><StopButton job={j} onStopped={load} small /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Running now</h2>
          <span className="panel-meta">{active.length} active job(s) · all users</span>
        </div>
        {error && <div className="error">Refresh failed ({error}) — showing the last loaded data.</div>}
        {active.length === 0 ? (
          <div className="empty"><p className="empty-title">No scraping jobs are running right now</p></div>
        ) : (
          table(active, true)
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>History</h2>
          <span className="panel-meta">{past.length} past job(s)</span>
        </div>
        {past.length === 0 ? (
          <div className="empty"><p className="empty-title">No past jobs yet</p></div>
        ) : (
          table(past, false)
        )}
      </div>
    </>
  );
}

// -------- Settings --------

function SettingsView({ settings, onChange }: { settings: Settings | null; onChange: () => void }) {
  const [recipient, setRecipient] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setRecipient(settings.defaultRecipient || '');
  }, [settings]);

  if (!settings) return <div className="empty"><p>Loading…</p></div>;

  const saveRecipient = async () => {
    setSaving(true);
    setSavedMsg(null);
    try {
      await api.setRecipient(recipient);
      setSavedMsg('Saved');
      onChange();
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (err) {
      setSavedMsg(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect your Gmail? You will need to sign in again to reconnect it.')) return;
    await api.disconnectGmail();
    onChange();
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await api.sendTestEmail();
      setTestResult(`Test sent to ${settings.defaultRecipient}`);
    } catch (err) {
      setTestResult(`Error: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="panel form-panel">
      <div className="panel-head">
        <h2>Settings</h2>
      </div>

      <div className="form-row">
        <label>Signed in as</label>
        <div><code>{settings.userEmail}</code>{settings.userName ? <span className="muted" style={{ marginLeft: 8 }}>({settings.userName})</span> : null}</div>
      </div>

      <div className="form-row">
        <label>My Gmail (sender for my jobs)</label>
        {settings.gmailConnected ? (
          <div className="settings-connected">
            <div>
              <span className="status status-completed">connected</span>
              <code style={{ marginLeft: 12 }}>{settings.gmailEmail}</code>
            </div>
            <button className="btn small" onClick={disconnect}>Disconnect</button>
          </div>
        ) : (
          <div>
            <a href="/api/auth/google" className="btn primary">Connect my Gmail</a>
            <p className="form-hint" style={{ marginTop: 10 }}>
              Re-authorize Google to grant Gmail-send permission. Job completion emails will be sent from your Gmail.
            </p>
          </div>
        )}
      </div>

      <div className="form-row">
        <label>My Default Recipient</label>
        <div className="settings-recipient">
          <input
            className="input"
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="leads@example.com"
          />
          <button className="btn primary" onClick={saveRecipient} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {savedMsg && <p className="form-hint" style={{ color: 'var(--accent-strong)' }}>{savedMsg}</p>}
        <p className="form-hint">Default destination for your job-completion emails. Per-job override is available on the New Job form.</p>
      </div>

      {settings.gmailConnected && settings.defaultRecipient && (
        <div className="form-row">
          <label>Test</label>
          <button className="btn" onClick={sendTest} disabled={testing}>
            {testing ? 'Sending…' : 'Send Test Email'}
          </button>
          {testResult && <p className="form-hint" style={{ marginTop: 10 }}>{testResult}</p>}
        </div>
      )}
    </div>
  );
}