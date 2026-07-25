import { useEffect, useState, useCallback } from 'react';
import {
  api,
  LEAD_LIMIT_CHOICES,
  Job,
  JobLog,
  ProductType,
  JobSource,
  JobPhase,
  Settings,
  Me,
  AppgoblinCategory,
  GoogleAdsMeta,
  StoreFirstConfig,
  CreateJobOptions,
  AuthRequiredError,
  derivePhase,
  phaseLabel,
  PHASE_STEPS,
} from './api/client';
import Publishers from './Publishers';

type View =
  | { kind: 'publishers' }
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'detail'; id: string }
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
  // Publishers is the primary view (store-first is the discovery engine).
  const [view, setView] = useState<View>({ kind: 'publishers' });
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
            className={`nav-btn ${view.kind === 'publishers' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'publishers' })}
            title="Google Ads - Mobile results — the primary view"
          >
            Publishers
          </button>
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
        {view.kind === 'publishers' && <Publishers onAuthError={handleAuthError} />}
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

// -------- Jobs List --------

function JobsList({ jobs, onSelect, onNew }: { jobs: Job[]; onSelect: (id: string) => void; onNew: () => void }) {
  if (jobs.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No jobs yet</p>
        <p className="empty-sub">Run Google Ads - Mobile, or a scrape from Meta Ad Library, Affplus, AppGoblin, or Google Ads Transparency.</p>
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
              <td><span className={`tag tag-${j.source || 'meta'}`}>{sourceLabel(j.source)}</span></td>
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
  // Lead cap for the two high-volume sources. null = "as many as found".
  const [maxLeads, setMaxLeads] = useState<number | null>(null);
  // Only the two Google Ads sources routinely return hundreds of leads; the
  // others are already small, so offering a cap there would be noise.
  const leadCapApplies = source === 'google_ads' || source === 'store_first';
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AppGoblin discovery state
  const [appgoblinCategory, setAppgoblinCategory] = useState<string>('');
  const [appgoblinAdNetwork, setAppgoblinAdNetwork] = useState<string>('');
  const [agCategories, setAgCategories] = useState<AppgoblinCategory[] | null>(null);
  const [agCategoriesError, setAgCategoriesError] = useState<string | null>(null);
  const [agCategoriesLoading, setAgCategoriesLoading] = useState(false);

  // Store-first discovery state. Markets come from the store config (not the
  // Countries field, which is only CSV metadata for this source).
  const [sfVerticals, setSfVerticals] = useState<string[]>([]);
  const [sfMarkets, setSfMarkets] = useState<string[]>([]);
  const [sfSimilarMax, setSfSimilarMax] = useState<number>(5000);
  const [sfSearchTerms, setSfSearchTerms] = useState<number>(15);
  const [sfConfirmMax, setSfConfirmMax] = useState<number>(200);
  const [sfConfig, setSfConfig] = useState<StoreFirstConfig | null>(null);
  const [sfConfigError, setSfConfigError] = useState<string | null>(null);
  const [sfConfigLoading, setSfConfigLoading] = useState(false);

  // Google Ads Transparency discovery state
  const [gaVerticals, setGaVerticals] = useState<string[]>([]);
  const [gaLanguages, setGaLanguages] = useState<string[]>([]); // empty = all languages
  const [gaMaxKeywords, setGaMaxKeywords] = useState<number>(40);
  const [gaCustomKeywords, setGaCustomKeywords] = useState<string>('');
  const [gaMeta, setGaMeta] = useState<GoogleAdsMeta | null>(null);
  const [gaMetaError, setGaMetaError] = useState<string | null>(null);
  const [gaMetaLoading, setGaMetaLoading] = useState(false);

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

  // Lazy-load Google Ads vertical/language metadata when that source is picked.
  useEffect(() => {
    if (source !== 'google_ads') return;
    if (gaMeta !== null) return;
    setGaMetaLoading(true);
    setGaMetaError(null);
    api.googleAdsMeta()
      .then((m) => setGaMeta(m))
      .catch((err) => setGaMetaError((err as Error).message))
      .finally(() => setGaMetaLoading(false));
  }, [source, gaMeta]);

  // Lazy-load the store-first vertical/market config when that source is picked,
  // and seed the form with the spec's default active vertical + markets.
  useEffect(() => {
    if (source !== 'store_first') return;
    if (sfConfig !== null) return;
    setSfConfigLoading(true);
    setSfConfigError(null);
    api.storeFirstConfig()
      .then((c) => {
        setSfConfig(c);
        setSfVerticals((prev) => (prev.length ? prev : c.defaults.verticals));
        setSfMarkets((prev) => (prev.length ? prev : c.defaults.markets));
      })
      .catch((err) => setSfConfigError((err as Error).message))
      .finally(() => setSfConfigLoading(false));
  }, [source, sfConfig]);

  const toggleSfVertical = (id: string) => {
    setSfVerticals((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleSfMarket = (m: string) => {
    setSfMarkets((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };

  const toggleType = (pt: ProductType) => {
    setProductTypes((prev) => (prev.includes(pt) ? prev.filter((x) => x !== pt) : [...prev, pt]));
  };

  const toggleGaVertical = (id: string) => {
    setGaVerticals((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleGaLanguage = (code: string) => {
    setGaLanguages((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
  };

  // Product type is not a free choice per source: AppGoblin and Google Ads -
  // Mobile (store_first) are mobile-only, Google Ads Transparency is CPS-only.
  // Forcing it here keeps the form from submitting a combination the API rejects.
  const handleSourceChange = (s: JobSource) => {
    setSource(s);
    if (s === 'appgoblin' || s === 'store_first') setProductTypes(['mobile']);
    else if (s === 'google_ads') setProductTypes(['cps']);
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
    let storeFirst: CreateJobOptions['storeFirst'] = undefined;
    if (source === 'store_first') {
      if (productTypes.some((pt) => pt !== 'mobile')) {
        setError('Google Ads - Mobile supports Mobile only');
        return;
      }
      if (sfVerticals.length === 0) {
        setError('Google Ads - Mobile: pick at least one vertical');
        return;
      }
      if (sfMarkets.length === 0) {
        setError('Google Ads - Mobile: pick at least one market');
        return;
      }
      storeFirst = {
        verticals: sfVerticals,
        markets: sfMarkets,
        similarMaxAppsPerRun: sfSimilarMax,
        searchTermsLimit: sfSearchTerms,
        confirmationMaxApiCalls: sfConfirmMax,
      };
    }
    let googleAds: CreateJobOptions['googleAds'] = undefined;
    if (source === 'google_ads') {
      const custom = gaCustomKeywords
        .split(/[\n,]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      googleAds = {
        verticals: gaVerticals.length ? gaVerticals : null,
        languages: gaLanguages.length ? gaLanguages : null,
        maxKeywords: gaMaxKeywords > 0 ? gaMaxKeywords : null,
        customKeywords: custom.length ? custom : null,
        region: null,
      };
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
        googleAds,
        storeFirst,
        maxLeads: leadCapApplies ? maxLeads : null,
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
              checked={source === 'store_first'}
              onChange={() => handleSourceChange('store_first')}
            />
            <span>
              Google Ads - Mobile{' '}
              <span className="muted">(app publishers + Ads Transparency check, one run → Excel)</span>
            </span>
          </label>
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
            <span>Affplus <span className="muted">(affiliate offer directory)</span></span>
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
          <label className="checkbox">
            <input
              type="radio"
              name="source"
              checked={source === 'google_ads'}
              onChange={() => handleSourceChange('google_ads')}
            />
            <span>
              Google Ads Transparency{' '}
              <span className="muted">(secondary — advertiser search by keyword; Mobile + CPS)</span>
            </span>
          </label>
        </div>
        <p className="form-hint">
          <strong>Google Ads - Mobile</strong> is one search, end to end: it harvests Play + App Store charts,
          crawls the long tail via similar-apps, developer catalogs and store search, rolls the apps up into
          publishers with the contact email the Play listing publishes, then <em>automatically</em> checks each
          publisher against Google Ads Transparency (and Meta, when configured) to prove it is actively
          advertising — and writes the CSV and the per-country Excel. One click, one Excel; no second search.
        </p>
        <p className="form-hint">
          Meta scrapes the Facebook Ad Library and classifies landing pages. Affplus lists CPA/CPI mobile
          offers and verifies each against the Google Play / App Store. AppGoblin discovers real apps by
          category or by which ad-network/MMP SDK they integrate. Google Ads Transparency is kept as a
          secondary advertiser view: its search matches advertiser names and verified domains only, caps at
          100 advertisers per query, and structurally cannot enumerate app advertisers — which is why
          discovery moved to the stores.
        </p>
      </div>

      {source === 'store_first' && (
        <div className="form-row">
          <label>Google Ads - Mobile</label>
          {sfConfigLoading && <div className="muted small">Loading store config…</div>}
          {sfConfigError && <div className="error" style={{ marginBottom: 6 }}>Store config failed to load: {sfConfigError}</div>}
          {sfConfig && (
            <p className="form-hint" style={{ marginTop: 0 }}>
              Charts: Play <code>{sfConfig.charts.play.join(' + ')}</code>, Apple{' '}
              <code>{sfConfig.charts.apple.join(' + ')}</code>. Long-tail apps outside the install band{' '}
              <code>{sfConfig.installBand.min.toLocaleString()}–{sfConfig.installBand.max.toLocaleString()}</code>{' '}
              are stored but skip enrichment and confirmation; charted apps are exempt.
            </p>
          )}

          <div className="muted small" style={{ margin: '8px 0 4px' }}>
            Verticals ({sfVerticals.length} selected)
          </div>
          <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(sfConfig?.verticals || []).map((v) => (
              <label key={v.id} className="checkbox" style={{ marginRight: 10 }}>
                <input type="checkbox" checked={sfVerticals.includes(v.id)} onChange={() => toggleSfVertical(v.id)} />
                <span>{v.label}</span>
              </label>
            ))}
          </div>

          <div className="muted small" style={{ margin: '12px 0 4px' }}>
            Markets ({sfMarkets.length} selected)
          </div>
          <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(sfConfig?.markets || []).map((m) => (
              <label key={m} className="checkbox" style={{ marginRight: 8 }}>
                <input type="checkbox" checked={sfMarkets.includes(m)} onChange={() => toggleSfMarket(m)} />
                <span className="mono">{m.toUpperCase()}</span>
              </label>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Similar-apps cap / run</div>
              <input
                className="input"
                type="number"
                min={0}
                max={50000}
                value={sfSimilarMax}
                onChange={(e) => setSfSimilarMax(Math.max(0, Math.min(50000, Number(e.target.value) || 0)))}
              />
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Search terms / vertical</div>
              <input
                className="input"
                type="number"
                min={0}
                max={15}
                value={sfSearchTerms}
                onChange={(e) => setSfSearchTerms(Math.max(0, Math.min(15, Number(e.target.value) || 0)))}
              />
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Confirmation API calls / run</div>
              <input
                className="input"
                type="number"
                min={0}
                max={10000}
                value={sfConfirmMax}
                onChange={(e) => setSfConfirmMax(Math.max(0, Math.min(10000, Number(e.target.value) || 0)))}
              />
            </div>
          </div>
          <p className="form-hint">
            The similar-apps crawl expands outward from chart apps up to depth 2. The search battery runs each
            term against both Play and iTunes search. Confirmation spends paid GATC (and Meta, if the key is
            set) calls in priority order: charted publishers first, then in-band tail publishers with an email,
            then the rest. Results land in the <strong>Publishers</strong> tab.
          </p>
        </div>
      )}

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

      {source === 'google_ads' && (
        <div className="form-row">
          <label>Google Ads discovery</label>
          {gaMetaLoading && <div className="muted small">Loading keyword bank…</div>}
          {gaMetaError && <div className="error" style={{ marginBottom: 6 }}>Keyword bank failed to load: {gaMetaError}</div>}
          {gaMeta && (
            <p className="form-hint" style={{ marginTop: 0 }}>
              Exemplar bank: <strong>{gaMeta.stats.total.toLocaleString()}</strong> keywords across{' '}
              <strong>{gaMeta.stats.languages}</strong> languages and <strong>{gaMeta.stats.verticals}</strong> verticals.
              A job draws a well-spread sample (default 40). Leave verticals/languages empty to search across everything.
            </p>
          )}

          <div className="muted small" style={{ margin: '8px 0 4px' }}>Verticals ({gaVerticals.length ? `${gaVerticals.length} selected` : 'all'})</div>
          <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(gaMeta?.verticals || []).map((v) => (
              <label key={v.id} className="checkbox" title={v.hint} style={{ marginRight: 10 }}>
                <input type="checkbox" checked={gaVerticals.includes(v.id)} onChange={() => toggleGaVertical(v.id)} />
                <span>{v.label}</span>
              </label>
            ))}
          </div>

          <div className="muted small" style={{ margin: '12px 0 4px' }}>Languages ({gaLanguages.length ? `${gaLanguages.length} selected` : 'all'})</div>
          <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, maxHeight: 120, overflowY: 'auto' }}>
            {(gaMeta?.languages || []).map((l) => (
              <label key={l.code} className="checkbox" style={{ marginRight: 8 }}>
                <input type="checkbox" checked={gaLanguages.includes(l.code)} onChange={() => toggleGaLanguage(l.code)} />
                <span>{l.label} <span className="muted">{l.native}</span></span>
              </label>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, marginTop: 12, alignItems: 'start' }}>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Max keywords / job</div>
              <input
                className="input"
                type="number"
                min={1}
                max={500}
                value={gaMaxKeywords}
                onChange={(e) => setGaMaxKeywords(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              />
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Custom keywords (optional — overrides the bank)</div>
              <textarea
                className="input"
                rows={2}
                value={gaCustomKeywords}
                onChange={(e) => setGaCustomKeywords(e.target.value)}
                placeholder="comma or newline separated, e.g. casino, prestamo rapido, 仮想通貨"
              />
            </div>
          </div>
          <p className="form-hint">
            Each keyword is one Transparency Center search that returns matching advertisers. More keywords = more
            leads but a longer job. A keyword does <strong>not</strong> guarantee Mobile vs CPS — the advertiser's
            ad destination decides that, and both CSVs are HQ-split by country.
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
          {source === 'store_first'
            ? 'Google Ads - Mobile ignores this list for discovery — the Markets checkboxes above choose which store fronts are harvested. The country list here is only metadata on the CSV rows.'
            : source === 'appgoblin'
            ? 'AppGoblin returns the same apps regardless of country — the country list here is informational metadata on the CSV rows.'
            : source === 'google_ads'
              ? 'Google Ads Transparency treats region as metadata, not a hard filter — the country list here tags CSV rows and seeds the informational region. Leads are split by resolved HQ country, not by this list.'
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
              disabled={source === 'google_ads'}
            />
            <span>Mobile <span className="muted">(Google Play / iTunes preview URLs)</span></span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={productTypes.includes('cps')}
              onChange={() => toggleType('cps')}
              disabled={source === 'appgoblin' || source === 'store_first'}
            />
            <span>CPS <span className="muted">(web product, website URLs)</span></span>
          </label>
        </div>
        <p className="form-hint">
          {source === 'appgoblin'
            ? 'AppGoblin supports Mobile only.'
            : source === 'store_first'
              ? 'Google Ads - Mobile discovers app publishers, so it supports Mobile only.'
              : source === 'google_ads'
                ? 'Google Ads Transparency is CPS only. For apps use Google Ads - Mobile, which finds the publishers AND checks Ads Transparency in one run.'
                : 'Selecting both creates two separate jobs (one CSV per type).'}
        </p>
      </div>

      {leadCapApplies && (
        <div className="form-row">
          <label>How many leads?</label>
          <div className="checkbox-row">
            {LEAD_LIMIT_CHOICES.map((n) => (
              <label className="checkbox" key={n}>
                <input type="radio" name="maxLeads" checked={maxLeads === n} onChange={() => setMaxLeads(n)} />
                <span>{n}</span>
              </label>
            ))}
            <label className="checkbox">
              <input type="radio" name="maxLeads" checked={maxLeads === null} onChange={() => setMaxLeads(null)} />
              <span>As many as found</span>
            </label>
          </div>
          <p className="form-hint">
            {source === 'store_first'
              ? 'Caps the CSV and the Excel to the highest-scoring publishers — best rank, most countries, most Ads Transparency activity first. Discovery still runs in full, so the rest stay in the Publishers tab.'
              : 'Caps the CSV and the Excel to the first leads found. The scrape still runs in full, so nothing discovered is lost.'}
          </p>
        </div>
      )}

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

      {job.status === 'completed' && (
        <div className="cta-row">
          <a href={api.csvUrl(job.id)} className="btn primary">⬇ Download CSV</a>
          {job.hq_zip_path && (
            <a href={api.hqZipUrl(job.id)} className="btn" style={{ marginLeft: 8 }}>⬇ Excel (by HQ country)</a>
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