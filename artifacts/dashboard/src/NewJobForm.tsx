import { useEffect, useMemo, useState } from 'react';
import {
  api,
  LEAD_LIMIT_CHOICES,
  LEAD_LIMIT_CUSTOM_MAX,
  parseCustomLeadCount,
  ProductType,
  JobSource,
  Settings,
  AppgoblinCategory,
  GoogleAdsMeta,
  StoreFirstConfig,
  CreateJobOptions,
} from './api/client';
import { COUNTRIES, REGIONS, Country } from './countries';

/**
 * The "New Job" form — ONE menu for every scraper, with the DATA SOURCE as the
 * first, visible choice: Google Ads (the unified Mobile/CPS engine, default)
 * sits BESIDE Meta Ad Library, Affplus and AppGoblin — they are different lead
 * sources, not variants of Google Ads. Picking Google Ads gives the simplified
 * flow (Mobile vs CPS, Countries, how many leads) with the technical knobs
 * under "Advanced settings"; the other sources show their own minimal fields.
 *
 * Under the hood the Google Ads paths stay distinct BY DESIGN:
 *   • Mobile  → source `store_first`: store-first ONLY (harvest the app stores,
 *     then check each publisher against Google Ads Transparency to prove it
 *     advertises). Never keyword-first.
 *   • CPS     → source `google_ads`: direct keyword scraping of the Google Ads
 *     Transparency Center.
 */

type SourceChoice = 'google_ads' | 'meta' | 'affplus' | 'appgoblin';

const SOURCE_CARDS: Array<{ id: SourceChoice; title: string; sub: string }> = [
  {
    id: 'google_ads',
    title: '🎯 Google Ads',
    sub: 'Mobile app publishers & CPS websites, verified in Google’s Ads Transparency Center. Recommended.',
  },
  {
    id: 'meta',
    title: '📘 Meta Ad Library',
    sub: 'Advertisers found in Facebook’s ad library, classified by their landing pages.',
  },
  {
    id: 'affplus',
    title: '🔗 Affplus',
    sub: 'Affiliate offer directory — offers verified against the app stores or advertiser sites.',
  },
  {
    id: 'appgoblin',
    title: '👾 AppGoblin',
    sub: 'Apps by store category or by which ad-network / MMP SDK they integrate. Mobile only.',
  },
];

export default function NewJobForm({
  settings,
  onCreated,
}: {
  settings: Settings | null;
  onCreated: () => void;
}) {
  const [srcChoice, setSrcChoice] = useState<SourceChoice>('google_ads');
  const [mode, setMode] = useState<ProductType>('mobile');
  // The source actually submitted. For the Google Ads choice the mode picks the
  // engine; the other sources submit as themselves.
  const source: JobSource =
    srcChoice === 'google_ads' ? (mode === 'mobile' ? 'store_first' : 'google_ads') : srcChoice;

  // null = "user hasn't touched the picker" → the defaults for the active source.
  const [selected, setSelected] = useState<string[] | null>(null);
  const [maxLeads, setMaxLeads] = useState<number | null>(100);
  // The custom lead box. Kept as RAW TEXT with an explicit mode flag rather than
  // being derived from maxLeads: deriving "is custom" from "the number isn't a
  // preset" would make the box visually deselect the moment someone typed 20,
  // and would throw away what they had typed while they were mid-edit.
  const [useCustomLeads, setUseCustomLeads] = useState(false);
  const [customLeadsText, setCustomLeadsText] = useState('');
  const customLeads = parseCustomLeadCount(customLeadsText);
  /** The cap actually submitted — the typed number in custom mode, else the radio. */
  const effectiveMaxLeads = useCustomLeads ? customLeads : maxLeads;
  /**
   * Custom mode with no usable number — Start stays disabled, so this ALWAYS
   * gets an explanation. Covers the empty box too: disabling the button with no
   * visible reason is the dead end this guards against.
   */
  const customLeadsMissing = useCustomLeads && customLeads === null;
  /** Typed something that is genuinely wrong (not merely blank) — also styled red.
   *  NB a `type=number` input reports '' for un-parseable text like "abc", so a
   *  blank box can mean "untouched" OR "browser rejected the keystrokes". */
  const customLeadsInvalid = customLeadsMissing && customLeadsText.trim() !== '';
  const [recipientEmail, setRecipientEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Store-first (Google Ads Mobile) config + advanced knobs ──
  const [sfConfig, setSfConfig] = useState<StoreFirstConfig | null>(null);
  const [sfConfigError, setSfConfigError] = useState<string | null>(null);
  const [sfVerticals, setSfVerticals] = useState<string[]>([]);
  const [sfSimilarMax, setSfSimilarMax] = useState<number>(5000);
  const [sfSearchTerms, setSfSearchTerms] = useState<number>(15);
  const [sfConfirmMax, setSfConfirmMax] = useState<number>(200);

  // ── Google Ads Transparency (CPS) advanced knobs ──
  const [gaMeta, setGaMeta] = useState<GoogleAdsMeta | null>(null);
  const [gaMetaError, setGaMetaError] = useState<string | null>(null);
  const [gaVerticals, setGaVerticals] = useState<string[]>([]);
  const [gaLanguages, setGaLanguages] = useState<string[]>([]);
  const [gaMaxKeywords, setGaMaxKeywords] = useState<number>(40);
  const [gaCustomKeywords, setGaCustomKeywords] = useState<string>('');

  // ── AppGoblin discovery ──
  const [agCategories, setAgCategories] = useState<AppgoblinCategory[] | null>(null);
  const [agCategoriesError, setAgCategoriesError] = useState<string | null>(null);
  const [appgoblinCategory, setAppgoblinCategory] = useState<string>('');
  const [appgoblinAdNetwork, setAppgoblinAdNetwork] = useState<string>('');

  // Google Ads Mobile is the default view, so load the store config on mount;
  // seed the vertical selection with the server's defaults.
  useEffect(() => {
    api.storeFirstConfig()
      .then((c) => {
        setSfConfig(c);
        setSfVerticals((prev) => (prev.length ? prev : c.defaults.verticals));
      })
      .catch((err) => setSfConfigError((err as Error).message));
  }, []);

  // Lazy-load the CPS keyword-bank metadata the first time it's relevant.
  useEffect(() => {
    if (source !== 'google_ads' || gaMeta !== null) return;
    api.googleAdsMeta()
      .then(setGaMeta)
      .catch((err) => setGaMetaError((err as Error).message));
  }, [source, gaMeta]);

  // Lazy-load AppGoblin categories when that source is picked.
  useEffect(() => {
    if (srcChoice !== 'appgoblin' || agCategories !== null) return;
    api.appgoblinCategories()
      .then((cats) => {
        setAgCategories(cats);
        if (cats.length > 0 && !appgoblinCategory) {
          const def = cats.find((c) => c.id === 'game_casino') || cats[0];
          setAppgoblinCategory(def.id);
        }
      })
      .catch((err) => setAgCategoriesError((err as Error).message));
  }, [srcChoice, agCategories, appgoblinCategory]);

  // ── Country options: Google Ads Mobile offers the store-market universe;
  //    everything else offers the full country catalog. ──
  const mobileOptions: Country[] = useMemo(() => {
    if (!sfConfig) return [];
    const known = new Set(sfConfig.markets.map((m) => m.toUpperCase()));
    return COUNTRIES.filter((c) => known.has(c.code));
  }, [sfConfig]);

  const options = source === 'store_first' ? mobileOptions : COUNTRIES;
  const defaultCountries = useMemo(
    () =>
      source === 'store_first'
        ? (sfConfig?.defaults.markets || []).map((m) => m.toUpperCase())
        : ['US'],
    [source, sfConfig],
  );
  const countries = selected ?? defaultCountries;
  const setCountries = (next: string[]) => setSelected(next);

  // AppGoblin is mobile-only: picking it forces Mobile.
  const pickSource = (s: SourceChoice) => {
    setSrcChoice(s);
    if (s === 'appgoblin') setMode('mobile');
  };

  const toggleIn = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  // Every source supports the lead cap: pipelines cap their CSV/Excel export
  // while discovery still runs in full.
  const effectiveRecipient = recipientEmail.trim() || settings?.defaultRecipient || '(none configured)';

  const countryHint = (): string => {
    switch (source) {
      case 'store_first':
        return 'Where we scan the app stores. More countries = more leads but a longer search. The default set covers the biggest ad markets.';
      case 'google_ads':
        return 'Tags the leads in your file by the markets you care about. The keyword search itself is worldwide.';
      case 'meta':
        return 'Each country is searched independently in the Meta Ad Library. More countries = a longer job.';
      case 'affplus':
        return 'Which geos to list offers for. More countries = a longer job.';
      case 'appgoblin':
        return 'AppGoblin returns the same apps regardless of country — this only tags the rows in your file.';
      default:
        return '';
    }
  };

  const submit = async () => {
    setError(null);
    if (countries.length === 0) {
      setError('Pick at least one country');
      return;
    }
    const opts: CreateJobOptions = {
      countries,
      productTypes: [mode],
      recipientEmail: recipientEmail.trim() || null,
      source,
      maxLeads: effectiveMaxLeads,
    };
    if (source === 'store_first') {
      if (sfVerticals.length === 0) {
        setError('Advanced → pick at least one app category');
        return;
      }
      opts.storeFirst = {
        verticals: sfVerticals,
        markets: countries.map((c) => c.toLowerCase()),
        similarMaxAppsPerRun: sfSimilarMax,
        searchTermsLimit: sfSearchTerms,
        confirmationMaxApiCalls: sfConfirmMax,
      };
    }
    if (source === 'google_ads') {
      const custom = gaCustomKeywords.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
      opts.googleAds = {
        verticals: gaVerticals.length ? gaVerticals : null,
        languages: gaLanguages.length ? gaLanguages : null,
        maxKeywords: gaMaxKeywords > 0 ? gaMaxKeywords : null,
        customKeywords: custom.length ? custom : null,
        region: null,
      };
    }
    if (source === 'appgoblin') {
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
      opts.appgoblinCategory = cat || null;
      opts.appgoblinAdNetwork = adn || null;
    }

    setSubmitting(true);
    try {
      await api.createJobs(opts);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // A custom box in an unusable state must not silently fall back to "as many as
  // found" — that would hand the user a far bigger (and slower) job than asked.
  const startDisabled = submitting || (source === 'store_first' && !sfConfig) || customLeadsMissing;

  return (
    <div className="panel form-panel">
      <div className="panel-head">
        <h2>New Job</h2>
        <span className="panel-meta">runs in the background — watch progress in My Jobs</span>
      </div>

      {/* 1 ─ Data source: Google Ads BESIDE the other scrapers, all first-class. */}
      <div className="form-row">
        <label>Lead source</label>
        <div className="source-cards">
          {SOURCE_CARDS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`mode-card compact ${srcChoice === s.id ? 'active' : ''}`}
              onClick={() => pickSource(s.id)}
            >
              <span className="mode-card-title">{s.title}</span>
              <span className="mode-card-sub">{s.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 2 ─ Lead type (hidden for AppGoblin — it is mobile-only). */}
      {srcChoice !== 'appgoblin' ? (
        <div className="form-row">
          <label>What are you looking for?</label>
          <div className="mode-cards">
            <button
              type="button"
              className={`mode-card ${mode === 'mobile' ? 'active' : ''}`}
              onClick={() => setMode('mobile')}
            >
              <span className="mode-card-title">📱 Mobile apps</span>
              <span className="mode-card-sub">
                {srcChoice === 'google_ads'
                  ? 'App publishers that advertise on Google. We scan the app stores first, then verify each company in Google’s Ads Transparency Center.'
                  : 'Leads whose ads point at a Google Play / App Store listing.'}
              </span>
            </button>
            <button
              type="button"
              className={`mode-card ${mode === 'cps' ? 'active' : ''}`}
              onClick={() => setMode('cps')}
            >
              <span className="mode-card-title">🌐 Websites (CPS)</span>
              <span className="mode-card-sub">
                {srcChoice === 'google_ads'
                  ? 'Online shops & web products that advertise on Google. We search the Ads Transparency Center directly by keyword.'
                  : 'Leads whose ads point at a website / web product.'}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="form-row">
          <label>AppGoblin discovery <span className="muted">(Mobile leads only)</span></label>
          {agCategoriesError && <div className="error">Category list failed to load: {agCategoriesError}</div>}
          <div className="adv-grid">
            <div>
              <div className="muted small" style={{ marginBottom: 4 }}>Category</div>
              <select className="input" value={appgoblinCategory} onChange={(e) => setAppgoblinCategory(e.target.value)}>
                <option value="">(no category filter)</option>
                {(agCategories || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.id}) · {c.total_apps.toLocaleString()} apps
                  </option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
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
            Pick a <strong>category</strong> to discover the top companies in that vertical, or narrow by an{' '}
            <strong>ad-network domain</strong> (e.g. <code>appsflyer.com</code>) to get apps that integrate that SDK.
          </p>
        </div>
      )}

      {/* 3 ─ Countries */}
      <div className="form-row">
        <label>Countries ({countries.length} selected)</label>
        {source === 'store_first' && !sfConfig && !sfConfigError && (
          <div className="muted small">Loading country list…</div>
        )}
        {source === 'store_first' && sfConfigError && (
          <div className="error">Country list failed to load: {sfConfigError}</div>
        )}
        {options.length > 0 && (
          <CountryPicker options={options} selected={countries} onChange={setCountries} />
        )}
        <p className="form-hint">{countryHint()}</p>
      </div>

      {/* 4 ─ How many leads (every source honours the cap) */}
      <div className="form-row">
        <label>How many leads do you want?</label>
          <div className="checkbox-row">
            {LEAD_LIMIT_CHOICES.map((n) => (
              <label className="checkbox" key={n}>
                <input
                  type="radio"
                  name="maxLeads"
                  checked={!useCustomLeads && maxLeads === n}
                  onChange={() => { setUseCustomLeads(false); setMaxLeads(n); }}
                />
                <span>{n}</span>
              </label>
            ))}
            <label className="checkbox">
              <input
                type="radio"
                name="maxLeads"
                checked={!useCustomLeads && maxLeads === null}
                onChange={() => { setUseCustomLeads(false); setMaxLeads(null); }}
              />
              <span>As many as found</span>
            </label>
            {/* The box lives INSIDE the Custom row so it sits beside the radio —
                .checkbox-row stacks its children vertically. */}
            <label className="checkbox">
              <input
                type="radio"
                name="maxLeads"
                checked={useCustomLeads}
                onChange={() => setUseCustomLeads(true)}
              />
              <span>Custom</span>
              <input
                type="number"
                min={1}
                max={LEAD_LIMIT_CUSTOM_MAX}
                step={1}
                className={`input input-inline${customLeadsInvalid ? ' input-invalid' : ''}`}
                placeholder="e.g. 250"
                value={customLeadsText}
                aria-label="Custom number of leads"
                aria-invalid={customLeadsInvalid || undefined}
                // Focusing or typing selects Custom, so a number can never be
                // entered and then silently ignored because a preset was still on.
                onFocus={() => setUseCustomLeads(true)}
                onChange={(e) => { setUseCustomLeads(true); setCustomLeadsText(e.target.value); }}
              />
              <span className="muted small">leads</span>
            </label>
          </div>
        {customLeadsMissing && (
          <p className={`form-hint${customLeadsInvalid ? ' error-hint' : ''}`}>
            Enter a whole number between 1 and {LEAD_LIMIT_CUSTOM_MAX.toLocaleString()} to start.
          </p>
        )}
        <p className="form-hint">
          Your file contains the best leads up to this number. The search keeps everything else it
          discovers, so nothing is wasted.
        </p>
      </div>

      {/* 5 ─ Email */}
      <div className="form-row">
        <label>Email the results to (optional)</label>
        <input
          className="input"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value)}
          placeholder={settings?.defaultRecipient || 'leave empty to use your default'}
          type="email"
        />
        <p className="form-hint">
          You'll get the file by email when the search finishes. Effective: <code>{effectiveRecipient}</code>
          {!settings?.gmailConnected && (
            <> · <span style={{ color: '#d97706' }}>Your Gmail is not connected — no email will be sent. Connect in Settings.</span></>
          )}
        </p>
      </div>

      {/* 6 ─ Advanced (the technical knobs of the two Google Ads engines) */}
      {(source === 'store_first' || source === 'google_ads') && (
        <details className="advanced-box">
          <summary>Advanced settings <span className="muted small">— defaults are already selected; you don't need to open this</span></summary>

          {source === 'store_first' && (
            <>
              <div className="form-row">
                <label>App categories ({sfVerticals.length} selected)</label>
                <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {(sfConfig?.verticals || []).map((v) => (
                    <label key={v.id} className="checkbox" style={{ marginRight: 10 }}>
                      <input
                        type="checkbox"
                        checked={sfVerticals.includes(v.id)}
                        onChange={() => setSfVerticals((prev) => toggleIn(prev, v.id))}
                      />
                      <span>{v.label}</span>
                    </label>
                  ))}
                </div>
                <p className="form-hint">Which kinds of apps to look for. All categories are on by default.</p>
              </div>

              <div className="form-row">
                <label>Search depth &amp; verification</label>
                <div className="adv-grid">
                  <div>
                    <div className="muted small" style={{ marginBottom: 4 }}>Similar-apps discovery cap</div>
                    <input
                      className="input" type="number" min={0} max={50000} value={sfSimilarMax}
                      onChange={(e) => setSfSimilarMax(Math.max(0, Math.min(50000, Number(e.target.value) || 0)))}
                    />
                    <p className="form-hint">
                      How many extra apps we discover through the stores' "Similar apps" recommendations.
                      Higher = more potential leads per run, but a longer search.
                    </p>
                  </div>
                  <div>
                    <div className="muted small" style={{ marginBottom: 4 }}>Search phrases per category</div>
                    <input
                      className="input" type="number" min={0} max={15} value={sfSearchTerms}
                      onChange={(e) => setSfSearchTerms(Math.max(0, Math.min(15, Number(e.target.value) || 0)))}
                    />
                    <p className="form-hint">
                      How many store-search phrases we try per app category (like typing searches into the
                      store yourself). 15 = full coverage; lower = faster run.
                    </p>
                  </div>
                  <div>
                    <div className="muted small" style={{ marginBottom: 4 }}>Ad-verification checks per run</div>
                    <input
                      className="input" type="number" min={0} max={10000} value={sfConfirmMax}
                      onChange={(e) => setSfConfirmMax(Math.max(0, Math.min(10000, Number(e.target.value) || 0)))}
                    />
                    <p className="form-hint">
                      How many companies we verify against Google's Ads Transparency Center per run. Only
                      VERIFIED advertisers become leads, so this effectively caps a run's leads. Each check
                      costs a fraction of a cent.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {source === 'google_ads' && (
            <div className="form-row">
              <label>Keyword bank</label>
              {gaMetaError && <div className="error">Keyword bank failed to load: {gaMetaError}</div>}
              {gaMeta && (
                <p className="form-hint" style={{ marginTop: 0 }}>
                  We search the Ads Transparency Center with keywords drawn from a bank of{' '}
                  <strong>{gaMeta.stats.total.toLocaleString()}</strong> phrases across{' '}
                  <strong>{gaMeta.stats.languages}</strong> languages. Leave everything empty to sample
                  across all of it.
                </p>
              )}
              <div className="muted small" style={{ margin: '8px 0 4px' }}>
                Verticals ({gaVerticals.length ? `${gaVerticals.length} selected` : 'all'})
              </div>
              <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {(gaMeta?.verticals || []).map((v) => (
                  <label key={v.id} className="checkbox" title={v.hint} style={{ marginRight: 10 }}>
                    <input
                      type="checkbox"
                      checked={gaVerticals.includes(v.id)}
                      onChange={() => setGaVerticals((prev) => toggleIn(prev, v.id))}
                    />
                    <span>{v.label}</span>
                  </label>
                ))}
              </div>
              <div className="muted small" style={{ margin: '12px 0 4px' }}>
                Languages ({gaLanguages.length ? `${gaLanguages.length} selected` : 'all'})
              </div>
              <div className="checkbox-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, maxHeight: 120, overflowY: 'auto' }}>
                {(gaMeta?.languages || []).map((l) => (
                  <label key={l.code} className="checkbox" style={{ marginRight: 8 }}>
                    <input
                      type="checkbox"
                      checked={gaLanguages.includes(l.code)}
                      onChange={() => setGaLanguages((prev) => toggleIn(prev, l.code))}
                    />
                    <span>{l.label} <span className="muted">{l.native}</span></span>
                  </label>
                ))}
              </div>
              <div className="adv-grid" style={{ marginTop: 12 }}>
                <div>
                  <div className="muted small" style={{ marginBottom: 4 }}>Keywords per search</div>
                  <input
                    className="input" type="number" min={1} max={500} value={gaMaxKeywords}
                    onChange={(e) => setGaMaxKeywords(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                  />
                  <p className="form-hint">Each keyword is one Transparency Center query. More = more leads, longer run.</p>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <div className="muted small" style={{ marginBottom: 4 }}>Your own keywords (optional — overrides the bank)</div>
                  <textarea
                    className="input" rows={2} value={gaCustomKeywords}
                    onChange={(e) => setGaCustomKeywords(e.target.value)}
                    placeholder="comma or newline separated, e.g. casino, prestamo rapido, 仮想通貨"
                  />
                </div>
              </div>
            </div>
          )}
        </details>
      )}

      {error && <div className="error">{error}</div>}

      <div className="form-actions">
        {/* In Google Ads Mobile the country list comes from the server config —
            until it arrives, Start would only produce a confusing validation error. */}
        <button className="btn primary" onClick={submit} disabled={startDisabled}>
          {submitting ? 'Starting…' : source === 'store_first' && !sfConfig ? 'Loading…' : '🔍 Start search'}
        </button>
        <p className="form-hint" style={{ marginTop: 8 }}>
          The search runs in the background — you can close this page. Check <strong>My Jobs</strong> any
          time to see the live lead count, stop the search, or download the file.
        </p>
      </div>
    </div>
  );
}

// ── country picker ───────────────────────────────────────────────────────────

function CountryPicker({
  options,
  selected,
  onChange,
}: {
  options: Country[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const sel = useMemo(() => new Set(selected), [selected]);
  const q = query.trim().toLowerCase();
  const visible = q
    ? options.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
    : options;

  const byRegion = useMemo(() => {
    const m = new Map<string, Country[]>();
    for (const r of REGIONS) m.set(r, []);
    for (const c of visible) {
      if (!m.has(c.region)) m.set(c.region, []);
      m.get(c.region)!.push(c);
    }
    return m;
  }, [visible]);

  const toggle = (code: string) =>
    onChange(sel.has(code) ? selected.filter((x) => x !== code) : [...selected, code]);

  const regionState = (cs: Country[]) => {
    const n = cs.filter((c) => sel.has(c.code)).length;
    return n === 0 ? 'none' : n === cs.length ? 'all' : 'some';
  };
  const toggleRegion = (cs: Country[]) => {
    const state = regionState(cs);
    const codes = cs.map((c) => c.code);
    if (state === 'all') onChange(selected.filter((x) => !codes.includes(x)));
    else onChange([...new Set([...selected, ...codes])]);
  };

  return (
    <div className="country-picker">
      <div className="country-picker-tools">
        <input
          className="input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search countries…"
          aria-label="Search countries"
        />
        <button type="button" className="btn small" onClick={() => onChange(options.map((c) => c.code))}>
          Select all
        </button>
        <button type="button" className="btn small ghost" onClick={() => onChange([])}>
          Clear
        </button>
      </div>
      <div className="country-picker-list">
        {[...byRegion.entries()].filter(([, cs]) => cs.length > 0).map(([region, cs]) => (
          <div key={region} className="country-region">
            <label className="checkbox country-region-head">
              <input
                type="checkbox"
                checked={regionState(cs) === 'all'}
                ref={(el) => { if (el) el.indeterminate = regionState(cs) === 'some'; }}
                onChange={() => toggleRegion(cs)}
              />
              <span><strong>{region}</strong> <span className="muted small">({cs.filter((c) => sel.has(c.code)).length}/{cs.length})</span></span>
            </label>
            <div className="country-region-grid">
              {cs.map((c) => (
                <label key={c.code} className="checkbox country-item" title={c.code}>
                  <input type="checkbox" checked={sel.has(c.code)} onChange={() => toggle(c.code)} />
                  <span>{c.name} <span className="muted mono small">{c.code}</span></span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
