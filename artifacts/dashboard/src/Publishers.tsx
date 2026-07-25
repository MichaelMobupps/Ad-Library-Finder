import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { api, Publisher, PublishersResponse, DiscoveryFunnel, AuthRequiredError } from './api/client';

/**
 * Store-first PUBLISHERS view (spec step 15) — the primary view of the
 * store-first engine. Discovery comes from app-store data; GATC and Meta only
 * confirm ad activity, so the confirmed flag and the two ad counts are read as
 * evidence columns, never as the thing that found the publisher.
 *
 * Rows are served pre-sorted by score desc and CAPPED, because the publishers
 * table is shared across runs and never pruned. So the filters run server-side
 * over the whole table and the counts shown here come from the response, not
 * from the row array: filtering the received page would have hidden every
 * publisher below the cap, and `rows.length` would have reported the page size
 * as the grand total while the funnel widget below it reported the real one.
 */

const GATC_ADVERTISER_URL = 'https://adstransparency.google.com/advertiser/';

/** Discovery sources, in funnel order. Mirrors DiscoverySource in storeDiscoveryDb.ts. */
const SOURCES = ['chart', 'similar', 'developer_catalog', 'search'] as const;

const SOURCE_LABEL: Record<string, string> = {
  chart: 'Chart',
  similar: 'Similar',
  developer_catalog: 'Dev catalog',
  search: 'Search',
};

/**
 * Rows rendered at once. The table is unvirtualized, so painting several thousand
 * rows x 15 cells stalls the tab on every keystroke and every poll. Filters run
 * server-side over the FULL table — only the painted slice is capped here, and
 * the cap is surfaced against the server's real match count.
 */
const MAX_RENDERED_ROWS = 300;

/**
 * Only http(s) links are safe to put in an href: `website` comes off a store
 * listing, so a `javascript:` value would execute on click and a schemeless one
 * would navigate inside the SPA. Returns null when the URL should not be linked.
 */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  const raw = url.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

type GameFilter = 'all' | 'games' | 'non-games';

export default function Publishers({ onAuthError }: { onAuthError: (err: unknown) => boolean }) {
  const [data, setData] = useState<PublishersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // filters
  const [vertical, setVertical] = useState('');
  const [market, setMarket] = useState('');
  const [source, setSource] = useState('');
  const [gameFilter, setGameFilter] = useState<GameFilter>('all');
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [emailOnly, setEmailOnly] = useState(false);
  const [query, setQuery] = useState('');

  // The CSV export re-applies these server-side, so the download matches the
  // table the operator is looking at rather than silently exporting everything.
  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (vertical) p.set('vertical', vertical);
    if (market) p.set('market', market);
    if (source) p.set('source', source);
    if (gameFilter !== 'all') p.set('game', gameFilter);
    if (confirmedOnly) p.set('confirmed', '1');
    if (emailOnly) p.set('email', '1');
    if (query.trim()) p.set('q', query.trim());
    return p.toString();
  }, [vertical, market, source, gameFilter, confirmedOnly, emailOnly, query]);

  // The table is filtered server-side, so every filter change is a request.
  // Debounce so typing in the search box costs one table scan, not one per
  // keystroke; the selects settle immediately after this tick.
  const [appliedParams, setAppliedParams] = useState(filterParams);
  useEffect(() => {
    const t = setTimeout(() => setAppliedParams(filterParams), 250);
    return () => clearTimeout(t);
  }, [filterParams]);

  // Never apply a response after unmount, and never apply a stale one: a filter
  // change and the 10s poll can be in flight together, and the older scan
  // landing last would repaint the table with rows that no longer match. Each
  // request stamps a sequence number and only the newest is allowed to win.
  const seq = useRef(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await api.publishers(appliedParams);
      if (!alive.current || mine !== seq.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      if (onAuthError(err) || err instanceof AuthRequiredError) return;
      // A transient poll failure must NOT blank a view that is already showing
      // data — surface it as a banner and keep the last good rows.
      setError((err as Error).message);
    }
  }, [onAuthError, appliedParams]);

  useEffect(() => {
    alive.current = true;
    load();
    // Publishers accrue while a store job runs, so poll — but not while the tab
    // is hidden: each poll is a full table scan server-side and a full re-render
    // here, and this is the default landing view.
    const tick = () => {
      if (document.visibilityState === 'visible') load();
    };
    const t = setInterval(tick, 10000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  // `rows` is the server's already-filtered page; `total` is how many publishers
  // actually match, which is what every count on this screen must report.
  const rows = data ? data.publishers : null;
  const funnel = data ? data.funnel : null;
  const total = data ? data.total : 0;
  const totalUnfiltered = data ? data.totalUnfiltered : 0;

  // Filter option lists come from the server's facets over the UNFILTERED table,
  // so they only ever offer values that match something and picking one never
  // removes the rest from the list.
  const verticalOptions = data ? data.facets.verticals : [];
  const marketOptions = data ? data.facets.markets : [];

  const resetFilters = () => {
    setVertical('');
    setMarket('');
    setSource('');
    setGameFilter('all');
    setConfirmedOnly(false);
    setEmailOnly(false);
    setQuery('');
  };

  const filtersActive =
    !!vertical || !!market || !!source || gameFilter !== 'all' || confirmedOnly || emailOnly || !!query;

  // Only a failure with nothing to show replaces the view; otherwise the error
  // rides as a banner above the last good data, so one dropped poll on a 10s
  // interval never blanks a populated table.
  if (error && !rows) return <div className="error">Could not load publishers: {error}</div>;
  if (!rows) return <div className="empty"><p>Loading…</p></div>;

  // Publishers only appear at the rollup phase, long after discovery starts, so
  // an empty table during a live run must still show the funnel — otherwise the
  // default landing view tells the user to start a job that is already running.
  // Keyed off the unfiltered total, not the returned rows: with a filter active
  // an empty page means "nothing matches", which is the other empty state below.
  if (totalUnfiltered === 0) {
    const started = !!funnel && funnel.totalApps > 0;
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Publishers</h2>
          {started && <span className="panel-meta">discovery in progress</span>}
        </div>
        {funnel && started && <FunnelWidget funnel={funnel} />}
        <div className="empty">
          <p className="empty-title">{started ? 'No publishers rolled up yet' : 'No publishers yet'}</p>
          <p className="empty-sub">
            {started ? (
              <>
                Discovery has found <strong>{funnel!.totalApps.toLocaleString()}</strong> apps so far.
                Publishers appear once the run reaches its rollup phase.
              </>
            ) : (
              <>
                Run a <strong>Google Ads - Mobile</strong> job to harvest app-store charts, crawl the long
                tail, roll the results up into publishers and check each against Ads Transparency.
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  const shown = rows.slice(0, MAX_RENDERED_ROWS);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Publishers</h2>
        <span className="panel-meta">
          {total === totalUnfiltered
            ? `${totalUnfiltered.toLocaleString()} total`
            : `${total.toLocaleString()} of ${totalUnfiltered.toLocaleString()}`}
        </span>
        <a href={api.publishersCsvUrl(filterParams)} className="btn primary" style={{ marginLeft: 'auto' }}>
          ⬇ Send to Prospector (CSV){filtersActive ? ` · ${total.toLocaleString()}` : ''}
        </a>
      </div>

      {error && <div className="error">Refresh failed ({error}) — showing the last loaded data.</div>}

      {funnel && <FunnelWidget funnel={funnel} />}

      <div className="pub-filters">
        <select className="input" aria-label="Filter by vertical" value={vertical} onChange={(e) => setVertical(e.target.value)}>
          <option value="">All verticals</option>
          {verticalOptions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>

        <select className="input" aria-label="Filter by market" value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">All markets</option>
          {marketOptions.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
        </select>

        <select className="input" aria-label="Filter by discovery source" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All sources</option>
          {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>

        <select className="input" aria-label="Filter games / non-games" value={gameFilter} onChange={(e) => setGameFilter(e.target.value as GameFilter)}>
          <option value="all">Games + non-games</option>
          <option value="non-games">Non-games only</option>
          <option value="games">Games only</option>
        </select>

        <input
          className="input"
          type="search"
          aria-label="Search publishers by name, email or website"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name / email / website"
        />

        <label className="checkbox">
          <input type="checkbox" checked={confirmedOnly} onChange={() => setConfirmedOnly((v) => !v)} />
          <span>Confirmed only</span>
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={emailOnly} onChange={() => setEmailOnly((v) => !v)} />
          <span>Has email</span>
        </label>

        {filtersActive && (
          <button className="btn ghost small" onClick={resetFilters}>Clear</button>
        )}
      </div>

      {total === 0 ? (
        <div className="empty">
          <p className="empty-title">No publishers match these filters</p>
          <button className="btn" onClick={resetFilters}>Clear filters</button>
        </div>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Publishers table (scrolls horizontally)">
          <table className="jobs-table pub-table">
            <thead>
              <tr>
                <th>Publisher</th>
                <th>Email</th>
                <th>Website</th>
                <th>Verticals</th>
                <th>Markets</th>
                <th>Source mix</th>
                <th className="num">Charted</th>
                <th className="num">Best rank</th>
                <th>Install band</th>
                <th>Stores</th>
                <th className="num">GATC ads</th>
                <th className="num">Meta ads</th>
                <th>Confirmed</th>
                <th>Game</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="pub-row">
                  <td>
                    {safeHref(p.previewUrl) ? (
                      <a href={safeHref(p.previewUrl)!} target="_blank" rel="noreferrer noopener" title={p.previewTitle || undefined}>
                        {p.name}
                      </a>
                    ) : (
                      p.name
                    )}
                    <span className="muted small"> · {p.appCount} app{p.appCount === 1 ? '' : 's'}</span>
                  </td>
                  <td className="small">
                    {p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : <span className="muted">—</span>}
                  </td>
                  <td className="small">
                    {safeHref(p.website) ? (
                      <a href={safeHref(p.website)!} target="_blank" rel="noreferrer noopener">{hostOf(p.website!)}</a>
                    ) : p.website ? (
                      <span title={p.website}>{hostOf(p.website)}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="small">{p.verticals.join(', ') || <span className="muted">—</span>}</td>
                  <td className="small mono">{p.markets.map((m) => m.toUpperCase()).join(', ') || <span className="muted">—</span>}</td>
                  <td className="small"><SourceMix mix={p.sourceMix} /></td>
                  <td className="mono num">{p.chartedAppCount || <span className="muted">—</span>}</td>
                  <td className="mono num">{p.bestRank == null ? <span className="muted">—</span> : `#${p.bestRank}`}</td>
                  <td className="small">
                    {p.isCharted
                      ? <span className="muted" title="Chart apps are exempt from the install-band gate">exempt</span>
                      : p.inBand
                        ? <span className="tag tag-inband">in band</span>
                        : <span className="muted">out</span>}
                  </td>
                  <td className="small">{storesLabel(p)}</td>
                  <td className="mono num">
                    {p.gatcAdsCount == null ? (
                      <span className="muted">—</span>
                    ) : p.gatcAdvertiserId ? (
                      <a
                        href={`${GATC_ADVERTISER_URL}${p.gatcAdvertiserId}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="Open this advertiser in the Google Ads Transparency Center"
                      >
                        {p.gatcAdsCount}
                      </a>
                    ) : (
                      p.gatcAdsCount
                    )}
                  </td>
                  <td className="mono num">{p.metaActiveAds == null ? <span className="muted">—</span> : p.metaActiveAds}</td>
                  <td>
                    {p.confirmed
                      ? <span className="status status-completed">confirmed</span>
                      : <span className="muted small">—</span>}
                  </td>
                  <td className="small">{p.isGame ? 'game' : <span className="muted">non-game</span>}</td>
                  <td className="mono num"><strong>{p.score}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > shown.length && (
            <p className="form-hint" style={{ padding: '12px 14px' }}>
              Showing the top {shown.length.toLocaleString()} of {total.toLocaleString()} matching
              publishers by score. Narrow the filters to see more — the CSV export contains all{' '}
              {total.toLocaleString()}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// -------- funnel widget --------

/**
 * Discovery funnel: how many apps each source produced, then the narrowing
 * through the install-band gate, enrichment, rollup and confirmation.
 */
function FunnelWidget({ funnel }: { funnel: DiscoveryFunnel }) {
  const steps: Array<{ label: string; value: number; hint: string }> = [
    ...SOURCES.map((s) => ({
      label: SOURCE_LABEL[s],
      value: funnel.bySource[s] || 0,
      hint: `apps discovered via ${SOURCE_LABEL[s].toLowerCase()}`,
    })),
    // Enriched BEFORE In band: the band gate is evaluated from enrichment data,
    // so in-band is a subset of enriched and listing it first made the funnel
    // read as though it grew at the next step.
    { label: 'Apps', value: funnel.totalApps, hint: 'distinct discovered app rows' },
    { label: 'Enriched', value: funnel.enriched, hint: 'apps with store detail fetched' },
    { label: 'In band', value: funnel.inBand, hint: 'enriched apps inside the install band' },
    { label: 'Publishers', value: funnel.publishers, hint: 'publishers after rollup' },
    { label: 'Confirmed', value: funnel.confirmed, hint: 'publishers with a GATC or Meta hit' },
  ];

  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div key={s.label} className={`funnel-step ${i < SOURCES.length ? 'funnel-source' : ''}`} title={s.hint}>
          <div className="funnel-value">{s.value.toLocaleString()}</div>
          <div className="funnel-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

function SourceMix({ mix }: { mix: Record<string, number> }) {
  const parts = SOURCES.filter((s) => (mix[s] || 0) > 0);
  if (parts.length === 0) return <span className="muted">—</span>;
  return (
    <>
      {parts.map((s) => (
        <span key={s} className={`tag tag-src-${s}`} title={`${mix[s]} app(s) via ${SOURCE_LABEL[s].toLowerCase()}`}>
          {SOURCE_LABEL[s]} {mix[s]}
        </span>
      ))}
    </>
  );
}

// -------- helpers --------

function storesLabel(p: Publisher) {
  if (p.bothStores) return <span className="tag tag-both">both</span>;
  return <span className="muted small">single</span>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
