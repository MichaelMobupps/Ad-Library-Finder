import { useEffect, useState, useCallback } from 'react';
import { api, Job, JobLog, ProductType, Settings, Me, AuthRequiredError } from './api/client';

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: string } | { kind: 'settings' };
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
  const [view, setView] = useState<View>({ kind: 'list' });
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
          <button className={`nav-btn ${view.kind === 'list' ? 'active' : ''}`} onClick={() => setView({ kind: 'list' })}>
            Jobs
          </button>
          <button className={`nav-btn ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
            Settings
          </button>
          <button className={`nav-btn primary ${view.kind === 'new' ? 'active' : ''}`} onClick={() => setView({ kind: 'new' })}>
            + New Job
          </button>
          <span className="nav-user" style={{ marginLeft: 16, color: 'var(--muted, #888)', fontSize: 13 }}>
            {me.email}
          </span>
          <button className="nav-btn ghost" onClick={signOut} title="Sign out">Sign out</button>
        </nav>
      </header>

      <main>
        {view.kind === 'list' && (
          <JobsList
            jobs={jobs}
            onSelect={(id) => setView({ kind: 'detail', id })}
            onNew={() => setView({ kind: 'new' })}
          />
        )}
        {view.kind === 'new' && (
          <NewJob
            settings={settings}
            onCreated={() => {
              refresh();
              setView({ kind: 'list' });
            }}
            onCancel={() => setView({ kind: 'list' })}
          />
        )}
        {view.kind === 'detail' && <JobDetail id={view.id} onBack={() => setView({ kind: 'list' })} />}
        {view.kind === 'settings' && <SettingsView settings={settings} onChange={refreshSettings} />}
      </main>
    </div>
  );
}

// -------- Jobs List --------

function JobsList({ jobs, onSelect, onNew }: { jobs: Job[]; onSelect: (id: string) => void; onNew: () => void }) {
  if (jobs.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No jobs yet</p>
        <p className="empty-sub">Submit a scrape to find advertisers from Meta Ad Library.</p>
        <button className="btn primary" onClick={onNew}>+ New Job</button>
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
            <th>Type</th>
            <th>Countries</th>
            <th>Status</th>
            <th>Found</th>
            <th>Recipient</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} onClick={() => onSelect(j.id)} className="jobs-row">
              <td className="mono">{j.id}</td>
              <td><span className={`tag tag-${j.product_type}`}>{j.product_type.toUpperCase()}</span></td>
              <td className="mono small">{(JSON.parse(j.countries) as string[]).join(', ')}</td>
              <td><StatusBadge status={j.status} /></td>
              <td className="mono">{j.total_advertisers || '—'}</td>
              <td className="small muted">{j.recipient_email || '(default)'}</td>
              <td className="small">{new Date(j.created_at).toLocaleString()}</td>
              <td>
                {j.status === 'completed' && (
                  <a href={api.csvUrl(j.id)} className="btn small" onClick={(e) => e.stopPropagation()}>
                    Download CSV
                  </a>
                )}
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

// -------- New Job --------

function NewJob({
  settings,
  onCreated,
  onCancel,
}: {
  settings: Settings | null;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [countriesText, setCountriesText] = useState('US, BR, IN');
  const [productTypes, setProductTypes] = useState<ProductType[]>(['mobile']);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleType = (pt: ProductType) => {
    setProductTypes((prev) => (prev.includes(pt) ? prev.filter((x) => x !== pt) : [...prev, pt]));
  };

  const submit = async () => {
    setError(null);
    const countries = countriesText.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (countries.length === 0) {
      setError('Add at least one country code');
      return;
    }
    if (productTypes.length === 0) {
      setError('Pick at least one product type');
      return;
    }
    setSubmitting(true);
    try {
      await api.createJobs(countries, productTypes, recipientEmail.trim() || null);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const effectiveRecipient = recipientEmail.trim() || settings?.defaultRecipient || '(none configured)';

  return (
    <div className="panel form-panel">
      <div className="panel-head">
        <h2>New Job</h2>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      <div className="form-row">
        <label>Countries (ISO 2-letter, comma-separated)</label>
        <input
          className="input"
          value={countriesText}
          onChange={(e) => setCountriesText(e.target.value)}
          placeholder="US, BR, IN, ID, MX"
        />
        <p className="form-hint">Each country is searched independently. More countries = longer job.</p>
      </div>

      <div className="form-row">
        <label>Product Type</label>
        <div className="checkbox-row">
          <label className="checkbox">
            <input type="checkbox" checked={productTypes.includes('mobile')} onChange={() => toggleType('mobile')} />
            <span>Mobile <span className="muted">(Google Play / iTunes preview URLs)</span></span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={productTypes.includes('cps')} onChange={() => toggleType('cps')} />
            <span>CPS <span className="muted">(web product, website URLs)</span></span>
          </label>
        </div>
        <p className="form-hint">Selecting both creates two separate jobs (one CSV per type).</p>
      </div>

      <div className="form-row">
        <label>Notification recipient (optional)</label>
        <input
          className="input"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          placeholder={settings?.defaultRecipient || 'leave empty to use default'}
          type="email"
        />
        <p className="form-hint">
          Email will be sent here when job completes. Effective: <code>{effectiveRecipient}</code>
          {!settings?.gmailConnected && (
            <> · <span style={{ color: 'var(--warn)' }}>Your Gmail is not connected — no email will be sent. Connect in Settings.</span></>
          )}
        </p>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Start Job'}
        </button>
      </div>
    </div>
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

  return (
    <div className="panel">
      <div className="panel-head">
        <button className="btn ghost" onClick={onBack}>← Back</button>
        <h2 className="mono">{job.id}</h2>
        <StatusBadge status={job.status} />
      </div>

      <div className="detail-grid">
        <Field label="Product Type"><span className={`tag tag-${job.product_type}`}>{job.product_type.toUpperCase()}</span></Field>
        <Field label="Countries"><code>{countries.join(', ')}</code></Field>
        <Field label="Recipient">{job.recipient_email || <span className="muted">(default)</span>}</Field>
        <Field label="Email">{job.notification_status === 'sent' ? '✓ sent' : job.notification_status === 'failed' ? '✗ failed' : '—'}</Field>
        <Field label="Created">{new Date(job.created_at).toLocaleString()}</Field>
        <Field label="Started">{job.started_at ? new Date(job.started_at).toLocaleString() : '—'}</Field>
        <Field label="Completed">{job.completed_at ? new Date(job.completed_at).toLocaleString() : '—'}</Field>
        <Field label="Ads Scraped">{job.total_ads_scraped}</Field>
        <Field label="Advertisers (CSV)">{job.total_advertisers}</Field>
      </div>

      {job.status === 'completed' && (
        <div className="cta-row">
          <a href={api.csvUrl(job.id)} className="btn primary">⬇ Download CSV</a>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
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
        {savedMsg && <p className="form-hint" style={{ color: 'var(--accent)' }}>{savedMsg}</p>}
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