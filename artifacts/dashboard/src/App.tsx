import { useEffect, useState, useCallback } from 'react';
import {
  api,
  Job,
  JobLog,
  ProductType,
  JobSource,
  JobPhase,
  Settings,
  Me,
  AppgoblinCategory,
  AuthRequiredError,
  derivePhase,
  phaseLabel,
  PHASE_STEPS,
} from './api/client';

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
          <span className="nav-user" style={{ marginLeft: 16, color: 'var(--text-mute)', fontSize: 13 }}>
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
        <p className="empty-sub">Submit a scrape from Meta Ad Library, Affplus, or AppGoblin.</p>
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
            <th>Source</th>
            <th>Type</th>
            <th>Countries</th>
            <th>Status</th>
            <th>Phase</th>
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
              <td><span className={`tag tag-${j.source || 'meta'}`}>{(j.source || 'meta').toUpperCase()}</span></td>
              <td><span className={`tag tag-${j.product_type}`}>{j.product_type.toUpperCase()}</span></td>
              <td className="mono small">{(JSON.parse(j.countries) as string[]).join(', ')}</td>
              <td><StatusBadge status={j.status} /></td>
              <td className="small">
                <RowPhaseCell job={j} />
              </td>
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
  const [source, setSource] = useState<JobSource>('meta');
  const [countriesText, setCountriesText] = useState('US, BR, IN');
  const [productTypes, setProductTypes] = useState<ProductType[]>(['mobile']);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AppGoblin discovery state
  const [appgoblinCategory, setAppgoblinCategory] = useState<string>('');
  const [appgoblinAdNetwork, setAppgoblinAdNetwork] = useState<string>('');
  const [agCategories, setAgCategories] = useState<AppgoblinCategory[] | null>(null);
  const [agCategoriesError, setAgCategoriesError] = useState<string | null>(null);
  const [agCategoriesLoading, setAgCategoriesLoading] = useState(false);

  // Lazy-load AppGoblin category list when user picks AppGoblin source.
  useEffect(() => {
    if (source !== 'appgoblin') return;
    if (agCategories !== null) return; // already loaded
    setAgCategoriesLoading(true);
    setAgCategoriesError(null);
    api.appgoblinCategories()
      .then((cats) => {
        setAgCategories(cats);
        // Default to game_casino if present (the recon-confirmed slug); else first.
        if (cats.length > 0 && !appgoblinCategory) {
          const def = cats.find((c) => c.id === 'game_casino') || cats[0];
          setAppgoblinCategory(def.id);
        }
      })
      .catch((err) => setAgCategoriesError((err as Error).message))
      .finally(() => setAgCategoriesLoading(false));
  }, [source, agCategories, appgoblinCategory]);

  const toggleType = (pt: ProductType) => {
    setProductTypes((prev) => (prev.includes(pt) ? prev.filter((x) => x !== pt) : [...prev, pt]));
  };

  // When switching to a mobile-only source, force productType to mobile.
  const handleSourceChange = (s: JobSource) => {
    setSource(s);
    if (s === 'affplus' || s === 'appgoblin') setProductTypes(['mobile']);
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
    if (source === 'affplus' && productTypes.some((pt) => pt !== 'mobile')) {
      setError('Affplus source supports Mobile only');
      return;
    }
    if (source === 'appgoblin') {
      if (productTypes.some((pt) => pt !== 'mobile')) {
        setError('AppGoblin source supports Mobile only');
        return;
      }
      const cat = appgoblinCategory.trim();
      const adn = appgoblinAdNetwork.trim();
      if (!cat && !adn) {
        setError('AppGoblin: pick a category and/or enter an ad-network domain');
        return;
      }
      if (adn && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(adn)) {
        setError('AppGoblin ad-network must be a domain like "appsflyer.com"');
        return;
      }
    }
    setSubmitting(true);
    try {
      await api.createJobs({
        countries,
        productTypes,
        recipientEmail: recipientEmail.trim() || null,
        source,
        appgoblinCategory: source === 'appgoblin' ? (appgoblinCategory.trim() || null) : undefined,
        appgoblinAdNetwork: source === 'appgoblin' ? (appgoblinAdNetwork.trim() || null) : undefined,
      });
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
        <label>Source</label>
        <div className="checkbox-row">
          <label className="checkbox">
            <input
              type="radio"
              name="source"
              checked={source === 'meta'}
              onChange={() => handleSourceChange('meta')}
            />
            <span>Meta Ad Library <span className="muted">(Facebook ads → landing URLs)</span></span>
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="source"
              checked={source === 'affplus'}
              onChange={() => handleSourceChange('affplus')}
            />
            <span>Affplus <span className="muted">(affiliate offer directory; Mobile only)</span></span>
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="source"
              checked={source === 'appgoblin'}
              onChange={() => handleSourceChange('appgoblin')}
            />
            <span>AppGoblin <span className="muted">(apps by category / ad-network; Mobile only)</span></span>
          </label>
        </div>
        <p className="form-hint">
          Meta scrapes the Facebook Ad Library and classifies landing pages. Affplus lists CPA/CPI mobile
          offers and verifies each against the Google Play / App Store. AppGoblin discovers real apps by
          category or by which ad-network/MMP SDK they integrate — store URLs come straight from the source.
        </p>
      </div>

      {source === 'appgoblin' && (
        <div className="form-row">
          <label>AppGoblin discovery</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Category</div>
              {agCategoriesLoading && <div className="muted small">Loading categories…</div>}
              {agCategoriesError && <div className="error" style={{ marginBottom: 6 }}>Category list failed to load: {agCategoriesError}</div>}
              <select
                className="input"
                value={appgoblinCategory}
                onChange={(e) => setAppgoblinCategory(e.target.value)}
                disabled={agCategoriesLoading}
              >
                <option value="">(no category filter)</option>
                {(agCategories || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.id}) · {c.total_apps.toLocaleString()} apps
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Ad-network / MMP domain (optional)</div>
              <input
                className="input"
                value={appgoblinAdNetwork}
                onChange={(e) => setAppgoblinAdNetwork(e.target.value)}
                placeholder="e.g. appsflyer.com, adjust.com"
              />
            </div>
          </div>
          <p className="form-hint">
            Pick a <strong>category</strong> to discover top ad-network companies in that vertical and pull their top apps.
            Optionally narrow by an <strong>ad-network domain</strong> (e.g. <code>appsflyer.com</code>) to get apps integrating that
            specific SDK. If you set the ad-network domain alone, the job returns that company's top iOS+Android apps directly.
          </p>
        </div>
      )}

      <div className="form-row">
        <label>Countries (ISO 2-letter, comma-separated)</label>
        <input
          className="input"
          value={countriesText}
          onChange={(e) => setCountriesText(e.target.value)}
          placeholder="US, BR, IN, ID, MX"
        />
        <p className="form-hint">
          {source === 'appgoblin'
            ? 'AppGoblin returns the same apps regardless of country — the country list here is informational metadata on the CSV rows.'
            : 'Each country is searched independently. More countries = longer job.'}
        </p>
      </div>

      <div className="form-row">
        <label>Product Type</label>
        <div className="checkbox-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={productTypes.includes('mobile')}
              onChange={() => toggleType('mobile')}
            />
            <span>Mobile <span className="muted">(Google Play / iTunes preview URLs)</span></span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={productTypes.includes('cps')}
              onChange={() => toggleType('cps')}
              disabled={source === 'affplus' || source === 'appgoblin'}
            />
            <span>CPS <span className="muted">(web product, website URLs)</span></span>
          </label>
        </div>
        <p className="form-hint">
          {source === 'affplus' || source === 'appgoblin'
            ? `${source === 'affplus' ? 'Affplus' : 'AppGoblin'} supports Mobile only.`
            : 'Selecting both creates two separate jobs (one CSV per type).'}
        </p>
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
            <> · <span style={{ color: '#d97706' }}>Your Gmail is not connected — no email will be sent. Connect in Settings.</span></>
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
  const isActive = job.status === 'pending' || job.status === 'running';
  const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

  // Pretty-print source params when present (AppGoblin only today).
  let sourceParamsDisplay: string | null = null;
  if (job.source_params) {
    try {
      const p = JSON.parse(job.source_params) as Record<string, unknown>;
      const parts: string[] = [];
      if (p.category) parts.push(`category=${p.category}`);
      if (p.adNetworkDomain) parts.push(`ad-network=${p.adNetworkDomain}`);
      if (parts.length > 0) sourceParamsDisplay = parts.join(', ');
    } catch { /* ignore */ }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <button className="btn ghost" onClick={onBack}>← Back</button>
        <h2 className="mono">{job.id}</h2>
        <StatusBadge status={job.status} />
      </div>

      <PhaseProgress job={job} latestLog={latestLog} isActive={isActive} />

      <div className="detail-grid">
        <Field label="Source"><span className={`tag tag-${job.source || 'meta'}`}>{(job.source || 'meta').toUpperCase()}</span></Field>
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

      {job.status === 'completed' && (
        <div className="cta-row">
          <a href={api.csvUrl(job.id)} className="btn primary">⬇ Download CSV</a>
          {job.product_type === 'mobile' && (
            <a href={api.hqZipUrl(job.id)} className="btn" style={{ marginLeft: 8 }}>⬇ HQ-Split ZIP</a>
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
  const currentIdx = isFailed ? -1 : PHASE_STEPS.indexOf(currentPhase);

  const description =
    job.phase_detail ||
    (latestLog ? latestLog.message : phaseLabel(currentPhase));

  return (
    <div className={`phase-progress ${isActive ? 'phase-active' : ''} ${isFailed ? 'phase-failed' : ''}`}>
      <div className="phase-stepper">
        {PHASE_STEPS.map((step, idx) => {
          const state =
            isFailed
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