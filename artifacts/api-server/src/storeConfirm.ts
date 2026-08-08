/**
 * Confirmation (spec step 10) — the ONLY place a discovered publisher becomes a
 * "confirmed advertiser". Discovery is store data; confirmation is ad activity.
 *
 * Per the session decision, GATC confirmation reuses the in-repo Transparency
 * Center RPC scraper (googleAdsScraper) rather than SearchAPI: for each publisher
 * we run up to two SearchSuggestions lookups (by NAME and by website DOMAIN), pick
 * the best-matching advertiser, then count its live creatives (SearchCreatives) as
 * ads_count. Meta (ScrapeCreators) runs only when SCRAPECREATORS_API_KEY is set;
 * absent, its component stays 0.
 *
 * Queue order (charted → in-band tail w/ email → in-band tail w/o email) and the
 * CONFIRMATION_MAX_API_CALLS_PER_RUN budget are enforced here. A charted publisher
 * is confirmed when ads_count > 0 or Meta store-link ads > 0; a tail-only publisher
 * requires that same hit — there is NO chart fallback for the tail.
 *
 * Every RPC degrades gracefully: the scraper never throws, a hard block trips a
 * circuit breaker that stops the run cleanly, and an active cooldown skips GATC
 * entirely so a penalty-boxed exit IP is not hammered.
 */

import {
  listPublishersForConfirmation,
  setPublisherConfirmation,
  type PublisherRow,
} from './storeDiscoveryDb.js';
import {
  searchAdvertisersOnce,
  countAdvertiserAds,
  warmUpSession,
  googleAdsCooldownRemainingMs,
  isProxyConfigured,
  type GoogleAdsAdvertiser,
} from './googleAdsScraper.js';
import { normalizeNameForMatch, registrableDomain } from './publisherRollup.js';
import { META_CONFIRM_ENABLED, META_STORE_LINK_HOSTS, STORE_FETCH_TIMEOUT_MS, isSharedHost } from './storeDiscoveryConfig.js';

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

/** Stop after this many consecutive blocked RPCs — the exit IP is refusing us. */
const MAX_CONSEC_BLOCKS = 3;

export interface ConfirmSummary {
  queued: number; // publishers eligible for confirmation
  processed: number; // publishers actually attempted before budget/breaker
  apiCalls: number; // GATC + Meta calls spent
  confirmed: number; // publishers flipped confirmed this run
  gatcHits: number; // publishers with ads_count > 0
  metaHits: number; // publishers with Meta store-link ads > 0
  skipped: boolean; // whole phase skipped (cooldown / no proxy path)
  /** The pass ended because opts.enough() said the lead target was met — a
   *  SUCCESS, not a budget exhaustion or a user stop. */
  reachedTarget: boolean;
  note: string;
}

// ── advertiser matching (pure, exported for tests) ───────────────────────────

export type MatchTier = 'domain' | 'name' | 'none';

/** Choose the advertiser that best matches a publisher's name/domain. Only an
 *  EXACT normalized-name or registrable-domain match counts — we never label a
 *  publisher "confirmed" off a fuzzy suggestion. Requires an advertiser_id (a
 *  domain-only suggestion can't be ad-counted). */
export function pickBestAdvertiser(
  advertisers: GoogleAdsAdvertiser[],
  publisher: { name: string | null; domain: string | null },
): { advertiser: GoogleAdsAdvertiser | null; tier: MatchTier } {
  // Fuzzy-match normalization, not identity: GATC is an independent party
  // spelling the same company its own way, so brand descriptors are stripped
  // here to preserve recall. Identity/merge deliberately does NOT do this.
  const pubName = normalizeNameForMatch(publisher.name);
  const pubDomain = publisher.domain ? registrableDomain(publisher.domain) : '';
  let nameMatch: GoogleAdsAdvertiser | null = null;
  for (const a of advertisers) {
    if (!a.advertiser_id) continue;
    if (pubDomain && a.domain && registrableDomain(a.domain) === pubDomain) {
      return { advertiser: a, tier: 'domain' }; // strongest — return immediately
    }
    if (!nameMatch && pubName && normalizeNameForMatch(a.name) === pubName) nameMatch = a;
  }
  if (nameMatch) return { advertiser: nameMatch, tier: 'name' };
  return { advertiser: null, tier: 'none' };
}

/**
 * May this pass's GATC ad count be written over the stored one? A ZERO is only a
 * measurement when the evidence set is COMPLETE — every advertiser search step 10
 * asks for (name AND domain) actually answered. If one was blocked, failed, or was
 * never issued because the per-run budget ran out, the advertiser it would have
 * surfaced is unknown, so "no advertiser matched" is ignorance, not a zero; writing
 * it would erase an ads_count an earlier run really measured and flip
 * confirmed_advertiser off a publisher that is in fact advertising. A POSITIVE
 * count needs no such completeness: it can only add evidence, never erase it.
 * Pure — exported for tests.
 */
export function gatcCountIsTrustworthy(
  plannedSearches: number,
  answeredSearches: number,
  adsCount: number,
): boolean {
  if (adsCount > 0) return true;
  return plannedSearches > 0 && answeredSearches === plannedSearches;
}

// ── Meta (optional) ──────────────────────────────────────────────────────────

interface MetaAd {
  // ScrapeCreators /v1/facebook/adLibrary/search/ads returns each ad's
  // destination inside `snapshot.link_url` (per their OpenAPI docs); a bare
  // `link` never appears there but is kept as a defensive fallback.
  snapshot?: { link_url?: string | null } | null;
  link?: string | null;
  [k: string]: unknown;
}

/** Count active Meta ads whose destination link points at an app store. Never
 *  throws — every failure mode (key absent, non-ok status, timeout, bad JSON)
 *  comes back as `ok: false`. That flag is load-bearing: a bare 0 for "the
 *  lookup did not answer" is indistinguishable from a genuine "this publisher
 *  runs no store-link ads", and writing the latter's 0 would erase a
 *  meta_active_ads a previous run really measured (and un-confirm the
 *  publisher). Only `ok: true` means `ads` was actually counted. */
export async function fetchMetaStoreLinkAds(
  query: string,
  onLog?: LogFn,
): Promise<{ ads: number; ok: boolean }> {
  if (!META_CONFIRM_ENABLED) return { ads: 0, ok: false };
  const key = process.env.SCRAPECREATORS_API_KEY || '';
  const q = (query || '').trim();
  if (!key || !q) return { ads: 0, ok: false };
  const url = `https://api.scrapecreators.com/v1/facebook/adLibrary/search/ads?query=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(STORE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      onLog?.('debug', `meta: HTTP ${res.status} for "${q.slice(0, 40)}"`);
      return { ads: 0, ok: false };
    }
    // Documented 200 shape: { success, credits_charged, searchResults: [...] }.
    // `ads`/`results` never appear in the current API but stay as fallbacks so a
    // ScrapeCreators shape change degrades to 0-with-ok rather than a crash.
    const json = (await res.json()) as {
      searchResults?: MetaAd[];
      ads?: MetaAd[];
      results?: MetaAd[];
    };
    const ads = json.searchResults || json.ads || json.results || [];
    return { ads: countStoreLinkAds(ads), ok: true };
  } catch (err) {
    onLog?.('debug', `meta: fetch failed (${(err as Error).message})`);
    return { ads: 0, ok: false };
  }
}

/**
 * The string the Meta Ad Library is searched with. The spec's DATA SOURCES entry
 * is explicit — `search/ads?query=<app title>` — because advertisers buy Meta ads
 * under the APP brand, not the legal entity behind it ("Acme Studios Inc." rarely
 * appears in an ad account name), so querying the publisher name finds nothing for
 * exactly the tail publishers step 10 wants confirmed. preview_title is the top
 * charted / highest-install app of the portfolio (publisherRollup), i.e. the brand
 * most likely to be advertised; the publisher name is only the fallback for a row
 * whose preview app has no title. Pure — exported for tests.
 */
export function metaQueryFor(p: { preview_title: string | null; name: string | null }): string {
  return (p.preview_title || '').trim() || (p.name || '').trim();
}

/** Pure: how many ads have a store-link destination. Exported for tests. */
export function countStoreLinkAds(ads: MetaAd[]): number {
  let n = 0;
  for (const ad of ads) {
    const link = (ad.snapshot?.link_url || ad.link || '').toString().toLowerCase();
    if (link && META_STORE_LINK_HOSTS.some((h) => link.includes(h))) n++;
  }
  return n;
}

/** Pure: drop queue entries already confirmation-checked at/after `since`.
 *  undefined/null since ⇒ queue unchanged. Exported for tests. */
export function filterUncheckedSince<T extends { last_confirm_at: number | null }>(
  queue: T[],
  since: number | null | undefined,
): T[] {
  if (since == null) return queue;
  return queue.filter((p) => p.last_confirm_at == null || p.last_confirm_at < since);
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function confirmPublishers(
  opts: {
    maxApiCalls: number;
    onLog?: LogFn;
    /** Job Stop button — polled between publishers; a stop ends the pass early
     *  with every verdict recorded so far already persisted. */
    shouldStop?: () => boolean | Promise<boolean>;
    /** Called after each publisher so the pipeline can surface a LIVE counter. */
    onProgress?: (s: ConfirmSummary) => void;
    /**
     * "We already have what the job asked for" — polled after each publisher.
     *
     * DISTINCT from shouldStop: that is the user's Stop button and ends the job
     * as cancelled, whereas this is a satisfied lead target and ends the pass
     * SUCCESSFULLY. Without it a job ordering 20 leads burned its whole
     * confirmation budget (and the operator's proxy spend) long after the 20th
     * lead had landed.
     */
    enough?: () => boolean;
    /**
     * Skip publishers whose last confirmation attempt is at/after this epoch —
     * i.e. "already checked THIS RUN". The pipeline now runs MANY confirmation
     * passes per run (a continuous background pump + phase barriers), all
     * sharing one budget; without this filter a pass whose queue starts with
     * publishers the previous pass just checked re-spends budget re-asking the
     * same question, which is paid API calls and proxy GB for zero information.
     */
    skipConfirmedSince?: number;
    /** Skip the session warm-up (the cookie jar is module-global, so one warm-up
     *  per RUN is enough — pass true on every pass after the first). */
    skipWarmUp?: boolean;
  },
): Promise<ConfirmSummary> {
  const onLog = opts.onLog;
  const summary: ConfirmSummary = {
    queued: 0, processed: 0, apiCalls: 0, confirmed: 0, gatcHits: 0, metaHits: 0,
    skipped: false, reachedTarget: false, note: '',
  };

  const queue = filterUncheckedSince(await listPublishersForConfirmation(), opts.skipConfirmedSince);
  summary.queued = queue.length;
  if (queue.length === 0) {
    summary.note = 'no eligible publishers';
    return summary;
  }
  if (opts.maxApiCalls <= 0) {
    summary.skipped = true;
    summary.note = 'confirmation budget is 0';
    onLog?.('warn', 'confirm: CONFIRMATION_MAX_API_CALLS_PER_RUN is 0 — skipping confirmation');
    return summary;
  }

  // GATC cooldown gate: a recently hard-blocked exit IP means every request only
  // renews Google's penalty. Skip GATC entirely (Meta may still run if enabled).
  const gatcAvailable = googleAdsCooldownRemainingMs() <= 0;
  if (!gatcAvailable) {
    const mins = Math.ceil(googleAdsCooldownRemainingMs() / 60_000);
    onLog?.('warn', `confirm: GATC cooldown active (~${mins} min) — GATC confirmation skipped this run`);
  }
  if (!gatcAvailable && !META_CONFIRM_ENABLED) {
    summary.skipped = true;
    summary.note = 'GATC cooldown active and Meta disabled — nothing to confirm';
    return summary;
  }
  if (gatcAvailable && !isProxyConfigured()) {
    onLog?.('warn', 'confirm: no GOOGLE_ADS_PROXY_URL — GATC RPC will egress from the host IP and may be rate-limited');
  }

  // Warm one cookie session up-front (best-effort; rpcPost still backs off).
  if (gatcAvailable && !opts.skipWarmUp) {
    const warm = await warmUpSession(onLog);
    if (warm.blocked) onLog?.('warn', 'confirm: warm-up was blocked — proceeding but the exit IP may be penalty-boxed');
  }

  let consecBlocks = 0;
  for (const p of queue) {
    if (await opts.shouldStop?.()) {
      summary.note = `stop requested — ended after ${summary.processed}/${queue.length} publishers (verdicts so far are saved)`;
      onLog?.('warn', `confirm: ${summary.note}`);
      break;
    }
    if (summary.apiCalls >= opts.maxApiCalls) {
      summary.note = `budget exhausted after ${summary.processed}/${queue.length} publishers`;
      break;
    }
    if (consecBlocks >= MAX_CONSEC_BLOCKS) {
      summary.note = `circuit-breaker: ${MAX_CONSEC_BLOCKS} consecutive blocks — stopped after ${summary.processed} publishers`;
      onLog?.('warn', `confirm: ${summary.note}`);
      break;
    }

    const result = await confirmOne(p, opts.maxApiCalls - summary.apiCalls, gatcAvailable, onLog);
    summary.apiCalls += result.apiCalls;
    summary.processed++;
    if (result.blockedThisPublisher) consecBlocks++;
    else consecBlocks = 0;

    if (result.adsCount > 0) summary.gatcHits++;
    if (result.metaAds > 0) summary.metaHits++;

    // Pass null for a provider that did not run this pass, so it preserves what
    // is already stored instead of erasing it. confirmed_advertiser is derived
    // from the resulting counts inside setPublisherConfirmation.
    await setPublisherConfirmation(p.id, {
      gatc_advertiser_id: result.advertiserId,
      gatc_ads_count: result.gatcMeasured ? result.adsCount : null,
      meta_active_ads: result.metaMeasured ? result.metaAds : null,
    });
    // Mirror the derivation in setPublisherConfirmation: a provider we measured
    // this pass supplies the fresh number, one we did not falls back to what is
    // already stored, so the summary neither under- nor over-reports.
    const confirmed =
      (result.gatcMeasured ? result.adsCount > 0 : (p.gatc_ads_count ?? 0) > 0) ||
      (result.metaMeasured ? result.metaAds > 0 : (p.meta_active_ads ?? 0) > 0);
    if (confirmed) summary.confirmed++;
    opts.onProgress?.(summary);

    // Lead target satisfied — stop spending. Checked AFTER onProgress so the
    // caller has already seen (and exported) this publisher's verdict.
    if (opts.enough?.()) {
      summary.reachedTarget = true;
      summary.note = `lead target reached after ${summary.processed}/${queue.length} publishers (${summary.apiCalls} calls)`;
      onLog?.('info', `confirm: ${summary.note}`);
      break;
    }
  }

  if (!summary.note) summary.note = `confirmed ${summary.confirmed}/${summary.processed} processed`;
  onLog?.(
    'info',
    `confirm: ${summary.processed}/${summary.queued} processed, ${summary.apiCalls} calls, ${summary.confirmed} confirmed (${summary.gatcHits} GATC, ${summary.metaHits} Meta)`,
  );
  return summary;
}

/** Pure: the domain a publisher's GATC domain query (and domain-tier match) may
 *  use — '' when the stored website is a shared host. A shared-host "website"
 *  (a facebook.com page, sites.google.com, linktr.ee…) identifies the PLATFORM,
 *  not the publisher: searching GATC by it returns the platform's own advertiser
 *  (Meta Platforms for facebook.com), which the domain tier would match
 *  immediately — a false confirmation with a saturated ads_count. Same guard the
 *  rollup merge (publisherRollup) and lead dedupe (storeLeads) apply to this very
 *  field; the name query still runs. Exported for tests. */
export function confirmDomainFor(website: string | null): string {
  const d = registrableDomain(website);
  return d && !isSharedHost(d) ? d : '';
}

interface ConfirmOneResult {
  advertiserId: string | null;
  adsCount: number;
  metaAds: number;
  apiCalls: number;
  /**
   * True ONLY when this pass produced a trustworthy GATC ad count — i.e. every
   * planned advertiser search answered, followed by either "no advertiser matches"
   * (a real zero) or a completed, unblocked ad count; or, regardless of the search
   * evidence, a positive count (see gatcCountIsTrustworthy). It is deliberately NOT
   * "we issued a request": a blocked/failed search, a search skipped by the budget,
   * or a budget-skipped creative count measures nothing, and writing its 0 would
   * erase a real count stored by an earlier run.
   */
  gatcMeasured: boolean;
  /** True only when the Meta lookup actually ANSWERED this pass — not merely that
   *  it was attempted. fetchMetaStoreLinkAds returns 0 for a blocked/failed/timed-out
   *  lookup too, and that 0 must never be written over a stored meta_active_ads. */
  metaMeasured: boolean;
  blockedThisPublisher: boolean;
}

async function confirmOne(
  p: PublisherRow,
  budgetLeft: number,
  gatcAvailable: boolean,
  onLog?: LogFn,
): Promise<ConfirmOneResult> {
  const res: ConfirmOneResult = {
    advertiserId: null, adsCount: 0, metaAds: 0, apiCalls: 0,
    gatcMeasured: false, metaMeasured: false, blockedThisPublisher: false,
  };

  // ── GATC ──
  if (gatcAvailable) {
    const domain = confirmDomainFor(p.website);
    const queries = [p.name, domain].map((q) => (q || '').trim()).filter(Boolean);
    const advertisers: GoogleAdsAdvertiser[] = [];
    // How many of the planned searches actually ANSWERED. Answered is not "was not
    // blocked": rpcPost flags blocked only for 429/403 and unparseable-200, so a
    // 5xx, a timeout or a proxy/DNS failure arrives as blocked=false with no
    // advertisers. And it is counted rather than OR-ed because ONE clean search is
    // not enough evidence for a zero — the sibling query (blocked, failed, or never
    // issued because the budget ran out at the break above) is exactly the one that
    // might have surfaced the advertiser. gatcCountIsTrustworthy applies that rule.
    let answeredSearches = 0;
    for (const q of queries) {
      if (res.apiCalls >= budgetLeft) break;
      const r = await searchAdvertisersOnce(q, onLog);
      res.apiCalls++;
      if (r.blocked) res.blockedThisPublisher = true;
      else if (r.ok) answeredSearches++;
      advertisers.push(...r.advertisers);
    }
    const match = pickBestAdvertiser(advertisers, { name: p.name, domain });
    if (match.advertiser) {
      res.advertiserId = match.advertiser.advertiser_id;
      if (res.apiCalls < budgetLeft) {
        const c = await countAdvertiserAds(match.advertiser.advertiser_id, { onLog });
        res.apiCalls++;
        if (c.blocked) res.blockedThisPublisher = true;
        else {
          res.adsCount = c.adsCount;
          res.gatcMeasured = gatcCountIsTrustworthy(queries.length, answeredSearches, c.adsCount);
        }
      }
      // else: budget ran out before the count — advertiser known, ads NOT measured.
    } else {
      // A COMPLETE search that matched no advertiser is a genuine zero; a partial
      // one is ignorance and must leave the stored count alone.
      res.gatcMeasured = gatcCountIsTrustworthy(queries.length, answeredSearches, 0);
    }
  }

  // ── Meta (optional) ──
  // Queried by APP TITLE per the spec's DATA SOURCES entry (metaQueryFor), and
  // measured only when the lookup answered — a failed ScrapeCreators call also
  // yields 0 and would otherwise un-confirm a publisher on a transient error.
  if (META_CONFIRM_ENABLED && res.apiCalls < budgetLeft) {
    const meta = await fetchMetaStoreLinkAds(metaQueryFor(p), onLog);
    res.apiCalls++;
    res.metaAds = meta.ads;
    res.metaMeasured = meta.ok;
  }

  return res;
}

// ── offline unit tests ───────────────────────────────────────────────────────

export function runStoreConfirmTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // filterUncheckedSince — the guard that keeps the run's MANY confirmation
  // passes (background pump + phase barriers) from re-charging the same
  // publisher against one shared budget.
  {
    const q = (last: number | null) => ({ last_confirm_at: last });
    const T = 1_000_000;
    const queue = [q(null), q(T - 1), q(T), q(T + 1)];
    check(filterUncheckedSince(queue, undefined).length === 4, 'since undefined ⇒ queue unchanged');
    check(filterUncheckedSince(queue, null).length === 4, 'since null ⇒ queue unchanged');
    const kept = filterUncheckedSince(queue, T);
    check(kept.length === 2, `checked at/after runStart dropped (kept ${kept.length}/4)`);
    check(kept[0].last_confirm_at === null, 'never-checked publisher always kept');
    check(kept[1].last_confirm_at === T - 1, 'checked BEFORE the run kept (stale verdict, re-checkable)');
    check(filterUncheckedSince([], T).length === 0, 'empty queue stays empty');
  }

  const adv = (o: Partial<GoogleAdsAdvertiser>): GoogleAdsAdvertiser => ({
    advertiser_id: 'AR1', name: '', domain: null, region: null, matchedKeyword: '', ...o,
  });

  // Domain match wins and returns immediately.
  const byDomain = pickBestAdvertiser(
    [adv({ advertiser_id: 'AR9', name: 'Something Else', domain: 'acme.com' })],
    { name: 'Acme Inc', domain: 'https://www.acme.com' },
  );
  check(byDomain.tier === 'domain' && byDomain.advertiser?.advertiser_id === 'AR9', 'match: domain exact');

  // Name match when domain absent.
  const byName = pickBestAdvertiser(
    [adv({ advertiser_id: 'AR3', name: 'Acme Studios Inc', domain: null })],
    { name: 'Acme Studios, Inc.', domain: null },
  );
  check(byName.tier === 'name' && byName.advertiser?.advertiser_id === 'AR3', 'match: normalized name');

  // No confident match → none.
  const none = pickBestAdvertiser(
    [adv({ advertiser_id: 'AR4', name: 'Zebra Corp', domain: 'zebra.io' })],
    { name: 'Acme', domain: 'acme.com' },
  );
  check(none.tier === 'none' && none.advertiser === null, 'match: unrelated advertiser rejected');

  // Advertiser without an id can't be selected (can't be ad-counted).
  const noId = pickBestAdvertiser(
    [adv({ advertiser_id: '', name: 'Acme', domain: 'acme.com' })],
    { name: 'Acme', domain: 'acme.com' },
  );
  check(noId.advertiser === null, 'match: domain-only suggestion (no id) rejected');

  // Shared-host websites must never drive a GATC domain query or domain-tier
  // match — facebook.com would match Meta Platforms' own advertiser.
  check(confirmDomainFor('https://www.facebook.com/acmegames') === '', 'confirm: shared-host website yields no domain query');
  check(confirmDomainFor('https://sites.google.com/view/acme') === '', 'confirm: sites.google.com yields no domain query');
  check(confirmDomainFor('https://www.acme.com/about') === 'acme.com', 'confirm: real website yields its registrable domain');
  check(confirmDomainFor(null) === '', 'confirm: null website yields no domain query');

  // Meta store-link counting — the REAL ScrapeCreators shape puts the
  // destination in snapshot.link_url; a bare `link` is the legacy fallback.
  check(
    countStoreLinkAds([
      { snapshot: { link_url: 'https://play.google.com/store/apps/details?id=x' } },
      { snapshot: { link_url: 'https://example.com/promo' } },
      { snapshot: { link_url: 'https://go.link/abc' } },
      { snapshot: { link_url: null } },
      { snapshot: null },
    ]) === 2,
    'meta: counts play + go.link via snapshot.link_url, ignores web/null',
  );
  check(
    countStoreLinkAds([
      { link: 'https://apps.apple.com/app/id42' },
      { link: null },
    ]) === 1,
    'meta: legacy top-level link fallback still counted',
  );

  // A zero is only measured when BOTH planned searches answered — one blocked or
  // budget-skipped sibling makes "no advertiser matched" ignorance, and writing
  // that 0 would erase a stored ads_count and un-confirm a live advertiser.
  check(gatcCountIsTrustworthy(2, 2, 0) === true, 'gatc: zero measured when every search answered');
  check(gatcCountIsTrustworthy(2, 1, 0) === false, 'gatc: zero NOT measured when a sibling search did not answer');
  check(gatcCountIsTrustworthy(2, 0, 0) === false, 'gatc: zero NOT measured when no search answered');
  check(gatcCountIsTrustworthy(0, 0, 0) === false, 'gatc: zero NOT measured when nothing was searchable');
  // A positive count can only add evidence, so incomplete search evidence never suppresses it.
  check(gatcCountIsTrustworthy(2, 1, 7) === true, 'gatc: positive count recorded despite an unanswered search');

  // Meta is searched by APP TITLE (spec DATA SOURCES), publisher name only as fallback.
  check(
    metaQueryFor({ preview_title: 'Acme Budget Tracker', name: 'Acme Studios, Inc.' }) === 'Acme Budget Tracker',
    'meta: queries the app title, not the publisher name',
  );
  check(
    metaQueryFor({ preview_title: '  ', name: 'Acme Studios, Inc.' }) === 'Acme Studios, Inc.',
    'meta: falls back to publisher name when no app title',
  );
  check(metaQueryFor({ preview_title: null, name: null }) === '', 'meta: empty query when neither is known');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeConfirm.js') || process.argv[1].endsWith('storeConfirm.ts'));
if (isMain) {
  const { passed, failed, failures } = runStoreConfirmTests();
  console.log(`storeConfirm tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
