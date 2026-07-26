/**
 * Publisher rollup (spec step 9).
 *
 * Groups every ENRICHED app into publisher entities and writes one publishers row
 * per entity with its portfolio aggregates. Grouping:
 *   • Play apps group by developerId (fallback: normalized developer name).
 *   • Apple apps group by sellerName (fallback: artistId).
 *   • Cross-store MERGE: two groups join when they share a registrable website
 *     domain OR a normalized name (union-find). This is how a publisher present on
 *     both stores becomes a single row (both_stores = true).
 *
 * Only apps with a successful enrichment (a known developer identity) roll up — an
 * unenriched / out-of-band tail app is stored in discovered_apps but is not turned
 * into a lead here. Portfolio provenance (countries charted, best rank, source mix,
 * verticals) is aggregated from discovered_apps.
 *
 * The publishers upsert resolves an existing row by the group's IDENTITY KEYS
 * (identityKeysFor) before it writes, so re-running the rollup produces zero
 * duplicate rows (verification step 5) even though merge_key is derived from the
 * group's contents and moves when the group grows. Confirmation/score columns set
 * by later phases are preserved across re-rollups.
 */

import {
  allDoneAppDetails,
  allDiscoveredLite,
  allPublisherIdentities,
  upsertPublisher,
  mergePublisherFields,
  type StoreAppDetailRow,
  type DiscoveredLite,
  type PublisherRow,
  type PublisherUpsert,
  rawPlayListDeveloperGroups,
  countPlayListIdentityRows,
  type ProvisionalPublisher,
} from './storeDiscoveryDb.js';
import { isInInstallBand } from './storeEnrich.js';
import { isSharedHost } from './storeDiscoveryConfig.js';
import { playStoreUrl } from './playSource.js';
import { appleStoreUrl } from './appleSource.js';

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

export interface RollupSummary {
  publishers: number;
  bothStores: number;
  charted: number;
  gamePublishers: number;
  withEmail: number;
}

// ── pure text helpers (exported for tests) ───────────────────────────────────

/**
 * LEGAL-ENTITY wrappers only. Stripping these is safe because they carry no brand:
 * "Acme Inc." and "Acme" are the same company under any reading.
 *
 * Brand DESCRIPTORS — studios, games, apps, technology/technologies, software,
 * mobile, labs — are deliberately NOT here. They are part of the name, and stripping
 * them made unrelated companies collide on the residue: "BILT Inc." (3D assembly
 * instructions) and "Bilt Technology, Inc." (Bilt Rewards) both reduced to 'bilt' and
 * were merged into one publisher, which kept one company's email under the other's
 * name and silently dropped the absorbed company's lead. Same shape for
 * "Nova Apps"/"Nova Games", "Pixel Studios"/"Pixel Mobile", "Lion Studio"/"Lion Games".
 *
 * The cost is accepted deliberately: a publisher listed as "Acme Studios" on Play and
 * "Acme" on Apple no longer merges BY NAME. It still merges on a shared website
 * domain, which spec step 9 lists first and which is the stronger signal anyway.
 */
const LEGAL_ENTITY_SUFFIXES =
  /\b(inc|inc\.|llc|l\.l\.c|ltd|ltd\.|limited|gmbh|co|co\.|corp|corp\.|corporation|company|pte|plc|s\.?a\.?|s\.?r\.?l|b\.?v|oy|ab|as)\b/gi;

/** The same designators for IDENTITY, but anchored: a legal form designates only
 *  where it TRAILS the name (possibly stacked — "Acme Co., Ltd."). Matching them
 *  anywhere stripped brand-bearing short tokens ("SA Money Transfer", "AB
 *  Fitness", "Co-op Bank") and collided unrelated companies on the residue —
 *  the same Bilt-class over-merge the descriptor rule above documents. Applied
 *  iteratively from the end; normalizeNameForMatch keeps the anywhere-variant
 *  deliberately (recall against a third party's spelling, cost documented there). */
const TRAILING_LEGAL_ENTITY_SUFFIX =
  /[\s,.]*\b(inc|llc|l\.l\.c|ltd|limited|gmbh|co|corp|corporation|company|pte|plc|s\.?a\.?|s\.?r\.?l|b\.?v|oy|ab|as)\.?\s*$/i;

/** Brand descriptors — stripped ONLY for fuzzy matching against a third party's
 *  spelling of a name (see normalizeNameForMatch), never for identity. */
const BRAND_DESCRIPTORS = /\b(studios?|games?|apps?|technolog(?:y|ies)|software|mobile|labs?)\b/gi;

/** Normalize a publisher name for IDENTITY/merge: lowercase, strip legal-entity
 *  suffixes, collapse to [a-z0-9]. Empty string when nothing meaningful remains. */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  let s = name.toLowerCase();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(TRAILING_LEGAL_ENTITY_SUFFIX, '');
  }
  return s.replace(/[^a-z0-9]+/g, '').trim();
}

/**
 * Looser normalization for matching a publisher against an EXTERNAL party's spelling
 * of the same company — currently GATC advertiser names. Here recall is what matters:
 * the two sides are independent renderings of one entity ("Monarch Money, Inc." vs
 * "Monarch Money Studios"), a wrong match costs one mis-attributed ads_count rather
 * than a lost lead, and a second corroborating query by website domain runs anyway.
 * Identity/merge must NOT use this — that is what caused the Bilt over-merge.
 */
export function normalizeNameForMatch(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(LEGAL_ENTITY_SUFFIXES, ' ')
    .replace(BRAND_DESCRIPTORS, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * The token two publisher names must share to be treated as the same entity.
 *
 * normalizeName() returns '' for any name with no [a-z0-9] left: a wholly
 * non-Latin one ('株式会社ミクシィ', '카카오게임즈', 'Кэшбэк' — jp, kr, tr, il and br
 * are all active markets) or a suffix-only Latin one ('Mobile Apps'). An empty
 * token carries no identity, so we fall back to the raw label, lowercased with
 * its whitespace collapsed.
 *
 * BOTH the merge predicate (mergeableNames) and the merge key (mergeKeyFor) must
 * go through this one function or they disagree: while only the KEY had the raw
 * fallback, two Apple artists with byte-identical non-Latin seller names stayed
 * TWO groups that emitted ONE merge_key, and the second group's upsert silently
 * overwrote the first's name/app_count/preview/countries/verticals/source_mix
 * while the rollup summary still counted two publishers.
 */
export function mergeNameKey(name: string | null | undefined): string {
  const norm = normalizeName(name);
  if (norm) return norm;
  return String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Registrable-ish domain from a website URL or bare host: hostname minus a
 *  leading "www.". Returns '' when it can't be parsed. We deliberately keep the
 *  full host (not a naive eTLD+1) so "co.uk"-style domains don't over-merge. */
export function registrableDomain(website: string | null | undefined): string {
  if (!website) return '';
  let host = String(website).trim().toLowerCase();
  if (!host) return '';
  try {
    if (!/^https?:\/\//.test(host)) host = `http://${host}`;
    host = new URL(host).hostname;
  } catch {
    return '';
  }
  return host.replace(/^www\./, '');
}

// ── union-find ───────────────────────────────────────────────────────────────

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    // Walk to the root.
    let root: string = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    // Path-compress everything on the way to the root.
    let cur: string = x;
    while (cur !== root) {
      const next: string = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ── per-app discovered aggregate ─────────────────────────────────────────────

interface AppAgg {
  /** Countries where the app appeared ON A CHART. Feeds the multi-country score. */
  countriesCharted: Set<string>;
  /** Every country the app was sighted in, from ANY source. Feeds the UI/CSV. */
  countriesSeen: Set<string>;
  bestRank: number | null;
  isChart: boolean;
  sources: Map<string, number>;
  verticals: Set<string>;
  title: string | null;
}

function buildAppAggregates(rows: DiscoveredLite[]): Map<string, AppAgg> {
  const m = new Map<string, AppAgg>();
  for (const r of rows) {
    const key = `${r.store}|${r.app_id}`;
    let agg = m.get(key);
    if (!agg) {
      agg = {
        countriesCharted: new Set(), countriesSeen: new Set(), bestRank: null,
        isChart: false, sources: new Map(), verticals: new Set(), title: null,
      };
      m.set(key, agg);
    }
    agg.sources.set(r.source, (agg.sources.get(r.source) ?? 0) + 1);
    if (r.vertical) agg.verticals.add(r.vertical);
    if (r.title && !agg.title) agg.title = r.title;
    // Every sighting carries the market it was harvested in — the search battery
    // and chart harvest both pass one. Tracking it separately from the CHARTED
    // countries is what lets a tail-only publisher still show a market: rolling
    // up only chart countries left the entire long tail with markets=[], so the
    // Markets column rendered "—" and any market filter silently dropped it.
    if (r.country) agg.countriesSeen.add(r.country);
    if (r.source === 'chart') {
      agg.isChart = true;
      agg.countriesCharted.add(r.country);
      if (r.rank != null && (agg.bestRank == null || r.rank < agg.bestRank)) agg.bestRank = r.rank;
    }
  }
  return m;
}

// ── identity key for a single enriched app ───────────────────────────────────

/** The raw (pre-merge) identity key for an enriched app. */
export function appIdentityKey(d: StoreAppDetailRow): string {
  if (d.store === 'google_play') {
    if (d.developer_id) return `p:${d.developer_id}`;
    const n = normalizeName(d.developer);
    return n ? `pn:${n}` : `pa:${d.store}|${d.app_id}`; // last resort: app-unique (never merges)
  }
  // app_store
  const seller = normalizeName(d.seller_name || d.developer);
  if (seller) return `a:${seller}`;
  if (d.artist_id) return `ai:${d.artist_id}`;
  return `aa:${d.store}|${d.app_id}`;
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * The website domains of an app group that may legitimately drive a cross-store
 * merge (spec step 9).
 *
 * A shared platform host — facebook.com, sites.google.com, a store URL — is not
 * evidence of common ownership; merging on one would collapse many unrelated
 * publishers into a single lead. Such a host still stands as the publisher's
 * website, it just cannot drive a merge.
 *
 * Exported so the merge predicate the tests assert on is the one that ships.
 */
export function mergeableDomains(apps: StoreAppDetailRow[]): Set<string> {
  const out = new Set<string>();
  for (const a of apps) {
    const dom = registrableDomain(a.developer_website);
    if (dom && !isSharedHost(dom)) out.add(dom);
  }
  return out;
}

/** The publisher names of an app group that may drive a merge, as merge tokens. */
export function mergeableNames(apps: StoreAppDetailRow[]): Set<string> {
  const out = new Set<string>();
  for (const a of apps) {
    const nm = mergeNameKey(a.seller_name || a.developer);
    if (nm) out.add(nm);
  }
  return out;
}

/**
 * Every identity key a merged group asserts — the input to the publishers upsert
 * (spec step 9: "One publisher row per entity").
 *
 * merge_key alone cannot carry identity across runs because it is derived from
 * the group's CONTENTS: the run a group gains its first Play app (its Play app
 * was deferred by ENRICH_MAX_APPS_PER_RUN, or the search battery only found it
 * now) or unions with another group, mergeKeyFor emits a different key and an
 * upsert keyed on it INSERTs a second row for a publisher that already has one.
 * The key SET only grows as the corpus grows, so a later run still resolves the
 * row an earlier one inserted. The prefixes mirror mergeKeyFor's, which is what
 * makes a stored merge_key one of these keys.
 *
 * Domain and name keys are exactly the union-find evidence used above, so two
 * distinct merged groups can only share a key when the rollup would already have
 * merged them into one — identity resolution never fuses unrelated publishers.
 */
export function identityKeysFor(apps: StoreAppDetailRow[]): string[] {
  const keys = new Set<string>();
  for (const a of apps) {
    if (a.store === 'google_play' && a.developer_id) keys.add(`p:${a.developer_id}`);
    if (a.store === 'app_store') {
      const seller = mergeNameKey(a.seller_name || a.developer);
      if (seller) keys.add(`a:${seller}`);
    }
  }
  for (const dom of mergeableDomains(apps)) keys.add(`w:${dom}`);
  for (const nm of mergeableNames(apps)) keys.add(`n:${nm}`);
  return [...keys].sort();
}

/**
 * Tail-scoring app signals for EVERY publisher, resolved over its whole merged
 * portfolio: the min-installs of its Play apps and the newest store update across
 * both stores.
 *
 * Attribution goes through publisher_identity, not through the single
 * play_developer_id / apple_seller_name on the publishers row: a merged publisher owns
 * several of each and only the first is persisted, so matching on that one identity
 * silently scored a partial portfolio (see the note in storeDiscoveryDb).
 *
 * One pass over identities + enriched apps, keyed the same way identityKeysFor keys
 * them, so it stays O(apps + identities) instead of a query per publisher — the Apple
 * arm cannot be a SQL equality anyway, since `a:` keys hold a mergeNameKey-normalized
 * seller name while store_app_detail stores the raw one.
 */
export function allPublisherAppSignals(): Map<number, { installs: number[]; latestUpdate: number | null }> {
  const owner = new Map<string, number>();
  for (const row of allPublisherIdentities()) owner.set(row.identity_key, row.publisher_id);

  const out = new Map<number, { installs: number[]; latestUpdate: number | null }>();
  for (const a of allDoneAppDetails()) {
    // The identity key this app contributes — same construction as identityKeysFor.
    let key: string | null = null;
    if (a.store === 'google_play' && a.developer_id) {
      key = `p:${a.developer_id}`;
    } else if (a.store === 'app_store') {
      const seller = mergeNameKey(a.seller_name || a.developer);
      if (seller) key = `a:${seller}`;
    }
    if (!key) continue;
    const pid = owner.get(key);
    if (pid == null) continue;

    let entry = out.get(pid);
    if (!entry) {
      entry = { installs: [], latestUpdate: null };
      out.set(pid, entry);
    }
    if (a.min_installs != null) entry.installs.push(a.min_installs);
    if (a.store_updated_at != null && (entry.latestUpdate == null || a.store_updated_at > entry.latestUpdate)) {
      entry.latestUpdate = a.store_updated_at;
    }
  }
  return out;
}

export interface RollupResult {
  summary: RollupSummary;
  publisherIds: number[];
}

export function rollupPublishers(onLog?: LogFn): RollupResult {
  const details = allDoneAppDetails();
  const appAgg = buildAppAggregates(allDiscoveredLite());

  // 1. bucket apps by raw identity key.
  const rawGroups = new Map<string, StoreAppDetailRow[]>();
  for (const d of details) {
    const k = appIdentityKey(d);
    const list = rawGroups.get(k) ?? [];
    list.push(d);
    rawGroups.set(k, list);
  }

  // 2. union raw groups that share a domain or a name token.
  const uf = new UnionFind();
  const byDomain = new Map<string, string>(); // domain → a representative raw key
  const byName = new Map<string, string>(); // mergeNameKey → a representative raw key
  for (const [k, apps] of rawGroups) {
    uf.find(k); // register
    const domains = mergeableDomains(apps);
    const names = mergeableNames(apps);
    for (const dom of domains) {
      const rep = byDomain.get(dom);
      if (rep) uf.union(k, rep);
      else byDomain.set(dom, k);
    }
    for (const nm of names) {
      const rep = byName.get(nm);
      if (rep) uf.union(k, rep);
      else byName.set(nm, k);
    }
  }

  // 3. collapse into merged groups.
  const merged = new Map<string, StoreAppDetailRow[]>();
  for (const [k, apps] of rawGroups) {
    const root = uf.find(k);
    const list = merged.get(root) ?? [];
    list.push(...apps);
    merged.set(root, list);
  }

  const summary: RollupSummary = { publishers: 0, bothStores: 0, charted: 0, gamePublishers: 0, withEmail: 0 };
  const publisherIds: number[] = [];

  for (const [, apps] of merged) {
    const p = buildPublisherRow(apps, appAgg);
    const id = upsertPublisher(p, identityKeysFor(apps));
    publisherIds.push(id);
    summary.publishers++;
    if (p.both_stores) summary.bothStores++;
    if (p.is_charted) summary.charted++;
    if (p.is_game_publisher) summary.gamePublishers++;
    if (p.email) summary.withEmail++;
  }

  onLog?.(
    'info',
    `rollup: ${summary.publishers} publishers (${summary.bothStores} both-stores, ${summary.charted} charted, ${summary.withEmail} w/ email)`,
  );
  return { summary, publisherIds };
}

/** Assemble one publishers-row upsert from a merged app group. Exported for tests. */
/**
 * Fold raw per-developer list aggregates into normalised publisher groups.
 *
 * SQL groups on the RAW developer string; this merges spellings that share a
 * `mergeNameKey` ("Block, Inc." and "Block Inc"), which is the SAME normalisation
 * the full rollup's union-find uses — so both sides agree on identity.
 * Exported for tests.
 */
export function foldProvisionalPublishers(
  raw: ReturnType<typeof rawPlayListDeveloperGroups>,
): ProvisionalPublisher[] {
  const byKey = new Map<string, ProvisionalPublisher>();
  for (const r of raw) {
    const key = mergeNameKey(r.developer);
    if (!key) continue; // unnameable ⇒ not searchable on GATC ⇒ useless as a lead
    const split = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
    const mix: Record<string, number> = {};
    if (r.src_chart) mix.chart = r.src_chart;
    if (r.src_search) mix.search = r.src_search;
    if (r.src_similar) mix.similar = r.src_similar;
    if (r.src_catalog) mix.developer_catalog = r.src_catalog;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        source_mix: mix,
        name_key: key,
        developer: r.developer,
        raw_developers: [r.developer],
        developer_id: r.developer_id,
        app_count: r.app_count,
        charted_app_count: r.charted_app_count,
        best_rank: r.best_rank,
        preview_app_id: r.preview_app_id,
        preview_title: r.preview_title,
        countries: split(r.countries),
        verticals: split(r.verticals),
        unenriched_apps: r.unenriched_apps,
      });
      continue;
    }
    // Merge a second spelling into the existing group.
    cur.raw_developers.push(r.developer);
    cur.developer_id = cur.developer_id ?? r.developer_id;
    cur.app_count += r.app_count;
    cur.charted_app_count += r.charted_app_count;
    cur.unenriched_apps += r.unenriched_apps;
    if (r.best_rank != null && (cur.best_rank == null || r.best_rank < cur.best_rank)) {
      cur.best_rank = r.best_rank;
      cur.preview_app_id = r.preview_app_id;
      cur.preview_title = r.preview_title;
    }
    cur.countries = [...new Set([...cur.countries, ...split(r.countries)])];
    cur.verticals = [...new Set([...cur.verticals, ...split(r.verticals)])];
    for (const [k, v] of Object.entries(mix)) cur.source_mix[k] = (cur.source_mix[k] ?? 0) + v;
  }
  return [...byKey.values()].sort(
    (a, b) => b.charted_app_count - a.charted_app_count || b.app_count - a.app_count,
  );
}

/**
 * FAST LANE: create/refresh publisher rows straight from Play LIST identity,
 * with no enrichment required.
 *
 * Runs inside every harvest pass so a charted publisher becomes confirmable
 * within the first minute of a run, instead of after the whole corpus has been
 * detail-fetched. Returns how many rows it touched.
 *
 * MERGE SAFETY — the property this design rests on: the identity key used here
 * is `n:<mergeNameKey(developer)>`, which identityKeysFor() also emits for every
 * rolled-up publisher (via mergeableNames, one per app, unconditionally). So the
 * full rollup resolves to the SAME publisher row through publisher_identity and
 * UPDATES it. A provisional row is never a duplicate; it is the same row,
 * earlier and thinner.
 *
 * DELIBERATELY THIN. Only what a list payload can honestly support is written:
 * name, portfolio size, chart facts, preview. Fields needing a detail page —
 * email, website, install band, genre — stay null/0 for the full rollup to fill.
 * in_band is 0 here on purpose: an unenriched app has no known install count,
 * and claiming otherwise would let it skip the band gate.
 *
 * SKIPS fully-enriched publishers so it can never downgrade richer data.
 */
/** Input size at the last fast-lane pass, so an unchanged corpus is skipped. */
let lastFastLaneInputRows = -1;

/** Reset the fast lane's change detector — call at the start of a RUN so a new
 *  job never inherits the previous job's "nothing changed" state. */
export function resetFastLaneCache(): void {
  lastFastLaneInputRows = -1;
}

export function rollupProvisionalPlayPublishers(onLog?: LogFn, limit = 20_000): { publishers: number; skipped: number } {
  // The background pump calls this every 15s. On a corpus the size of a real run
  // (8,000 apps / 2,000 developers) a full pass measured ~4s, so repeating it
  // when nothing new has been discovered would burn a quarter of every tick
  // competing with the scrape. One indexed COUNT settles it.
  const inputRows = countPlayListIdentityRows();
  if (inputRows === lastFastLaneInputRows) return { publishers: 0, skipped: 0 };
  lastFastLaneInputRows = inputRows;

  const groups = foldProvisionalPublishers(rawPlayListDeveloperGroups(limit));
  let touched = 0;
  let skipped = 0;

  for (const p of groups) {
    // Nothing left unenriched ⇒ the full rollup owns the complete picture, so
    // skip the write entirely. (Partially-enriched publishers are protected a
    // second way: the upsert below runs in preserveEnriched mode, which never
    // lowers enrichment-derived facts.)
    if (p.unenriched_apps === 0) {
      skipped++;
      continue;
    }
    const row: PublisherUpsert = {
      merge_key: `n:${p.name_key}`,
      name: p.developer,
      play_developer_id: p.developer_id,
      apple_seller_name: null,
      website: null, // needs a detail page
      email: null, // needs a detail page
      countries_charted: JSON.stringify(p.charted_app_count > 0 ? p.countries : []),
      countries_seen: JSON.stringify(p.countries),
      verticals: JSON.stringify(p.verticals),
      charted_app_count: p.charted_app_count,
      app_count: p.app_count,
      best_rank: p.best_rank,
      both_stores: 0, // list identity is Play-only by construction
      in_band: 0, // install count unknown until enrichment — see note above
      source_mix: JSON.stringify(p.source_mix),
      gatc_advertiser_id: null,
      gatc_ads_count: null,
      meta_active_ads: null,
      confirmed_advertiser: 0,
      is_game_publisher: 0, // genre needs a detail page
      is_charted: p.charted_app_count > 0 ? 1 : 0,
      preview_url: p.preview_app_id ? playStoreUrl(p.preview_app_id) : null,
      preview_title: p.preview_title,
      score: 0, // scoring runs separately
    };
    upsertPublisher(row, [`n:${p.name_key}`], { preserveEnriched: true });
    touched++;
  }

  onLog?.(
    'info',
    `fast lane: ${touched} publisher(s) from list data alone (no detail fetch); ${skipped} already enriched`,
  );
  return { publishers: touched, skipped };
}

export function buildPublisherRow(apps: StoreAppDetailRow[], appAgg: Map<string, AppAgg>): PublisherUpsert {
  const countriesCharted = new Set<string>();
  const countriesSeen = new Set<string>();
  const verticals = new Set<string>();
  const sourceMix: Record<string, number> = {};
  let bestRank: number | null = null;
  let chartedAppCount = 0;
  let hasPlay = false;
  let hasApple = false;
  let inBand = false;
  let isCharted = false;
  let games = 0;
  let knownGame = 0;

  let playDeveloperId: string | null = null;
  let appleSellerName: string | null = null;
  let website: string | null = null;
  let email: string | null = null;

  // Name: most common non-empty developer/seller label.
  const nameCounts = new Map<string, number>();

  // Preview candidate selection: chart apps by best rank, else highest installs.
  let previewUrl: string | null = null;
  let previewTitle: string | null = null;
  let previewRankKey = Number.POSITIVE_INFINITY; // lower = better (chart rank)
  let previewInstalls = -1;

  for (const d of apps) {
    if (d.store === 'google_play') hasPlay = true;
    else hasApple = true;

    if (d.store === 'google_play' && d.developer_id && !playDeveloperId) playDeveloperId = d.developer_id;
    if (d.store === 'app_store' && d.seller_name && !appleSellerName) appleSellerName = d.seller_name;
    if (!website && d.developer_website) website = d.developer_website;
    if (!email && d.developer_email) email = d.developer_email;

    const nm = (d.seller_name || d.developer || '').trim();
    if (nm) nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);

    if (d.is_game === 1) games++;
    if (d.is_game != null) knownGame++;

    if (d.store === 'google_play' && isInInstallBand(d.min_installs)) inBand = true;

    const agg = appAgg.get(`${d.store}|${d.app_id}`);
    const appIsChart = agg?.isChart ?? false;
    if (appIsChart) {
      isCharted = true;
      chartedAppCount++;
      for (const c of agg!.countriesCharted) countriesCharted.add(c);
      if (agg!.bestRank != null && (bestRank == null || agg!.bestRank < bestRank)) bestRank = agg!.bestRank;
    }
    if (agg) {
      for (const v of agg.verticals) verticals.add(v);
      for (const [s, n] of agg.sources) sourceMix[s] = (sourceMix[s] ?? 0) + n;
      // EVERY sighting's country, charted or not. This union used to live inside
      // the `appIsChart` branch above, which left the whole long tail with
      // countries_seen='[]' — measured at 1044 of 1418 publishers in a finance/us
      // run, every one of them a tail publisher. Downstream that is not cosmetic:
      // the Markets column renders '—', the market filter drops the row entirely
      // (routes-jobs market filter + Publishers.tsx), and the exported CSV ships
      // an empty country/markets for the lead.
      for (const c of agg.countriesSeen) countriesSeen.add(c);
    }

    // Preview link ranking: a charted app (by rank) beats a non-charted one;
    // among non-charted, higher installs wins. Store URL from the right store.
    const url = d.store === 'google_play' ? playStoreUrl(d.app_id) : appleStoreUrl(d.app_id);
    const title = d.title || agg?.title || null;
    if (appIsChart) {
      const rk = agg?.bestRank ?? Number.MAX_SAFE_INTEGER;
      if (rk < previewRankKey) {
        previewRankKey = rk;
        previewUrl = url;
        previewTitle = title;
      }
    } else if (previewRankKey === Number.POSITIVE_INFINITY) {
      const inst = d.min_installs ?? 0;
      if (inst > previewInstalls) {
        previewInstalls = inst;
        previewUrl = url;
        previewTitle = title;
      }
    }
  }

  const name =
    [...nameCounts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] ||
    playDeveloperId ||
    appleSellerName ||
    'Unknown publisher';

  const appCount = new Set(apps.map((d) => `${d.store}|${d.app_id}`)).size;
  const isGamePublisher = knownGame > 0 && games * 2 > knownGame; // majority of known apps are games

  return {
    merge_key: mergeKeyFor(playDeveloperId, appleSellerName, name),
    name,
    play_developer_id: playDeveloperId,
    apple_seller_name: appleSellerName,
    website,
    email,
    countries_charted: JSON.stringify([...countriesCharted].sort()),
    countries_seen: JSON.stringify([...countriesSeen].sort()),
    verticals: JSON.stringify([...verticals].sort()),
    charted_app_count: chartedAppCount,
    app_count: appCount,
    best_rank: bestRank,
    both_stores: hasPlay && hasApple ? 1 : 0,
    in_band: inBand ? 1 : 0,
    source_mix: JSON.stringify(sourceMix),
    gatc_advertiser_id: null,
    gatc_ads_count: null,
    meta_active_ads: null,
    confirmed_advertiser: 0,
    is_game_publisher: isGamePublisher ? 1 : 0,
    is_charted: isCharted ? 1 : 0,
    preview_url: previewUrl,
    preview_title: previewTitle,
    score: 0,
  };
}

/**
 * Deterministic merge_key for a group AS IT STANDS: prefer Play developerId,
 * else Apple sellerName, else the name. It is the row's preferred label, not its
 * identity — a group that grows a Play app changes key, so the upsert resolves
 * the row through identityKeysFor() and only then writes this.
 *
 * Both fallback branches go through mergeNameKey, which never returns '' for a
 * non-empty label. That matters twice over: merge_key is UNIQUE, so every
 * empty-normalizing name degrading to the bare key 'a:' would collapse unrelated
 * companies into one row, and mergeableNames uses the same token, so a key
 * emitted here always has a matching merge predicate above.
 */
export function mergeKeyFor(playDevId: string | null, appleSeller: string | null, name: string): string {
  if (playDevId) return `p:${playDevId}`;
  if (appleSeller) return `a:${mergeNameKey(appleSeller)}`;
  return `n:${mergeNameKey(name)}`;
}

// ── offline unit tests ───────────────────────────────────────────────────────

export function runPublisherRollupTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // normalizeName
  check(
    normalizeName('Acme Studios, Inc.') === 'acmestudios',
    'normalize: strips LEGAL suffixes + punctuation but keeps the brand descriptor',
  );
  check(normalizeName('Acme, Inc.') === 'acme', 'normalize: legal suffix and punctuation both go');
  check(normalizeName('Acme GmbH') === 'acme', 'normalize: non-English legal suffix goes too');
  // The over-merge this fixes: descriptors are brand, not boilerplate. Stripping them
  // collapsed unrelated companies onto a shared residue, and the merged row kept one
  // company's contact under the other's name while the absorbed lead vanished.
  const mustNotCollide: Array<[string, string]> = [
    ['BILT Inc.', 'Bilt Technology, Inc.'], // observed live: publisher 57
    ['Nova Apps', 'Nova Games'],
    ['Pixel Studios', 'Pixel Mobile'],
    ['Zen Mobile', 'Zen Technologies'],
    ['Lion Studio', 'Lion Games'],
    ['Cash App Labs', 'Cash Apps Ltd'],
    // Same over-merge via ANYWHERE-matched legal tokens: short designators (co,
    // ab, sa, as, oy, bv…) are brand-bearing mid-name and may only be stripped
    // where they actually designate a legal form — trailing the name.
    ['SA Money Transfer', 'Money Transfer Ltd'],
    ['AB Fitness', 'Fitness Co'],
    ['Co-op Bank', 'OP Bank'],
  ];
  for (const [a, b] of mustNotCollide) {
    check(
      normalizeName(a) !== normalizeName(b),
      `normalize: "${a}" and "${b}" are distinct identities (was: both → one token)`,
    );
  }
  // …while the looser matcher used against a third party's spelling still bridges them.
  check(
    normalizeNameForMatch('Monarch Money, Inc.') === normalizeNameForMatch('Monarch Money Studios'),
    'normalizeNameForMatch: descriptors still stripped for external (GATC) name matching',
  );
  check(
    normalizeNameForMatch('Bilt') === normalizeNameForMatch('Bilt Technology'),
    'normalizeNameForMatch: recall is the goal there, so these DO match',
  );
  check(normalizeName('King.com Ltd') === 'kingcom', 'normalize: keeps distinctive token');
  check(normalizeName('Acme Co., Ltd.') === 'acme', 'normalize: stacked trailing suffixes all go');
  check(normalizeName('') === '', 'normalize: empty → empty');

  // registrableDomain
  check(registrableDomain('https://www.acme.com/x') === 'acme.com', 'domain: strips scheme/path/www');
  check(registrableDomain('acme.co.uk') === 'acme.co.uk', 'domain: bare host kept whole');
  check(registrableDomain('') === '', 'domain: empty → empty');
  check(registrableDomain('has spaces') === '', 'domain: unparseable host → empty');

  // Merge on matching website domain (spec verification #1): a Play group and an
  // Apple group with the same developer website roll into ONE publisher.
  const mkDetail = (o: Partial<StoreAppDetailRow>): StoreAppDetailRow => ({
    store: 'google_play', app_id: 'x', title: null, developer: null, developer_id: null,
    developer_email: null, developer_website: null, min_installs: null, genre_id: null,
    category_raw: null, is_game: null, store_updated_at: null, artist_id: null, seller_name: null,
    bundle_id: null, enrich_status: 'done', attempts: 1, created_at: 0, updated_at: 0, ...o,
  });
  const playApp = mkDetail({ store: 'google_play', app_id: 'com.acme.a', developer: 'Acme LLC', developer_id: 'dev-1', developer_website: 'https://acme.com', is_game: 0 });
  const appleApp = mkDetail({ store: 'app_store', app_id: '123', seller_name: 'Totally Different Name', developer_website: 'https://www.acme.com/app', artist_id: '999', is_game: 0 });

  // Mirror rollupPublishers' union-find, but drive it through the SHIPPED
  // mergeableDomains()/mergeableNames() predicates so a regression in either real
  // merge rule fails here.
  const unionRoots = (groups: StoreAppDetailRow[][]): number => {
    const rawGroups = new Map<string, StoreAppDetailRow[]>(groups.map((g) => [appIdentityKey(g[0]), g]));
    const uf = new UnionFind();
    const byDomain = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const [k, apps] of rawGroups) {
      uf.find(k);
      for (const dom of mergeableDomains(apps)) {
        const rep = byDomain.get(dom);
        if (rep) uf.union(k, rep);
        else byDomain.set(dom, k);
      }
      for (const nm of mergeableNames(apps)) {
        const rep = byName.get(nm);
        if (rep) uf.union(k, rep);
        else byName.set(nm, k);
      }
    }
    return new Set([...rawGroups.keys()].map((k) => uf.find(k))).size;
  };

  check(unionRoots([[playApp], [appleApp]]) === 1, 'merge: play+apple with same website domain → one publisher');

  // Shared-host guard: two unrelated publishers that both list a Facebook page
  // must NOT be merged, or a single platform host collapses many distinct leads.
  const fbA = mkDetail({ store: 'google_play', app_id: 'com.a', developer: 'Alpha', developer_id: 'dev-a', developer_website: 'https://facebook.com/alpha' });
  const fbB = mkDetail({ store: 'google_play', app_id: 'com.b', developer: 'Beta', developer_id: 'dev-b', developer_website: 'https://www.facebook.com/beta' });
  check(unionRoots([[fbA], [fbB]]) === 2, 'merge: shared host (facebook.com) does NOT merge distinct publishers');
  check(mergeableDomains([fbA]).size === 0, 'merge: shared host yields no mergeable domain');
  const siteA = mkDetail({ store: 'google_play', app_id: 'com.c', developer: 'Gamma', developer_id: 'dev-c', developer_website: 'https://sites.google.com/view/gamma' });
  const siteB = mkDetail({ store: 'google_play', app_id: 'com.d', developer: 'Delta', developer_id: 'dev-d', developer_website: 'https://sites.google.com/view/delta' });
  check(unionRoots([[siteA], [siteB]]) === 2, 'merge: sites.google.com does NOT merge distinct publishers');
  // Per-publisher subdomains stay mergeable — they really are one owner.
  const wixA = mkDetail({ store: 'google_play', app_id: 'com.e', developer_id: 'dev-e', developer_website: 'https://acme.wixsite.com/home' });
  const wixB = mkDetail({ store: 'app_store', app_id: '555', seller_name: 'Acme Mobile', developer_website: 'https://acme.wixsite.com/apps' });
  check(unionRoots([[wixA], [wixB]]) === 1, 'merge: per-publisher subdomain still merges');

  const merged = buildPublisherRow([playApp, appleApp], new Map());
  check(merged.both_stores === 1, 'merge: both_stores true after cross-store merge');
  check(merged.play_developer_id === 'dev-1', 'merge: keeps play developerId');
  check(merged.apple_seller_name === 'Totally Different Name', 'merge: keeps apple sellerName');
  check(merged.app_count === 2, 'merge: app_count counts both apps');
  check(merged.website === 'https://acme.com', 'merge: website carried');

  // is_game_publisher majority
  const g = (v: number) => mkDetail({ store: 'google_play', app_id: `g${Math.random()}`, developer_id: 'd', developer: 'D', is_game: v });
  const gp = buildPublisherRow([g(1), g(1), g(0)], new Map());
  check(gp.is_game_publisher === 1, 'is_game_publisher: 2/3 games → true');
  const ngp = buildPublisherRow([g(1), g(0), g(0)], new Map());
  check(ngp.is_game_publisher === 0, 'is_game_publisher: 1/3 games → false');

  // mergeKeyFor determinism
  check(mergeKeyFor('dev-1', 'Seller', 'Name') === 'p:dev-1', 'mergeKey: prefers play devId');
  check(mergeKeyFor(null, 'Acme Inc', 'Name') === 'a:acme', 'mergeKey: apple seller normalized');
  check(mergeKeyFor(null, null, 'Acme Inc') === 'n:acme', 'mergeKey: falls back to name');

  // mergeKeyFor must never collapse sellers whose name normalizes to EMPTY into one
  // key: merge_key is UNIQUE, so a shared 'a:' silently fuses unrelated companies.
  // Only WHOLLY NON-LATIN names normalize to empty now. Suffix-only Latin names like
  // 'Mobile Apps' survive on their own since descriptors are no longer stripped —
  // which is strictly better: they get a real identity instead of the raw fallback.
  check(normalizeName('Mobile Apps') === 'mobileapps', 'normalize: a descriptor-only Latin name survives');
  check(normalizeName('Games Inc') === 'games', 'normalize: descriptor survives once the legal suffix goes');
  check(
    normalizeName('Mobile Apps') !== normalizeName('Games Inc'),
    'normalize: two descriptor-only names stay distinct',
  );
  const emptyNorm = ['株式会社ミクシィ', '카카오게임즈', 'Кэшбэк'];
  for (const s of emptyNorm) {
    check(normalizeName(s) === '', `premise: normalizeName("${s}") is empty`);
    check(mergeKeyFor(null, s, s) !== 'a:', `mergeKey: "${s}" does not degrade to the bare key 'a:'`);
  }
  check(
    new Set(emptyNorm.map((s) => mergeKeyFor(null, s, s))).size === emptyNorm.length,
    'mergeKey: every empty-normalizing seller gets a DISTINCT key',
  );

  // …and the MERGE PREDICATE must agree with that key. Two Apple artists with a
  // byte-identical non-Latin sellerName used to stay two groups (mergeableNames
  // dropped the empty normalization) while emitting ONE merge_key, so the second
  // group's upsert overwrote the first publisher's whole portfolio.
  const jpA = mkDetail({ store: 'app_store', app_id: '901', seller_name: '株式会社ミクシィ', artist_id: '901' });
  const jpB = mkDetail({ store: 'app_store', app_id: '902', seller_name: '株式会社ミクシィ', artist_id: '902' });
  const krC = mkDetail({ store: 'app_store', app_id: '903', seller_name: '카카오게임즈', artist_id: '903' });
  check(appIdentityKey(jpA) !== appIdentityKey(jpB), 'premise: identical non-Latin sellers start as two raw groups');
  check(
    mergeKeyFor(null, jpA.seller_name, 'x') === mergeKeyFor(null, jpB.seller_name, 'y'),
    'premise: identical non-Latin sellers emit ONE merge_key',
  );
  check(unionRoots([[jpA], [jpB]]) === 1, 'merge: identical non-Latin seller names union into ONE group');
  check(unionRoots([[jpA], [krC]]) === 2, 'merge: DIFFERENT non-Latin seller names stay separate');

  // Identity must survive a merge_key that moves (spec step 9 / verification 5).
  // Run 1 sees only the Apple app of a publisher; run 2 adds the Play app that
  // ENRICH_MAX_APPS_PER_RUN deferred, which changes merge_key from 'a:…' to
  // 'p:…'. Keyed on merge_key alone that INSERTs a second row for one entity.
  const run1Apps = [appleApp];
  const run2Apps = [playApp, appleApp];
  const run1Key = buildPublisherRow(run1Apps, new Map()).merge_key;
  const run2Key = buildPublisherRow(run2Apps, new Map()).merge_key;
  check(run1Key !== run2Key, 'premise: merge_key MOVES when a group gains its first Play app');
  check(
    identityKeysFor(run2Apps).includes(run1Key),
    'identity: run-2 keys still resolve the row run 1 inserted → no duplicate publisher',
  );
  check(
    identityKeysFor(run2Apps).includes(run2Key),
    'identity: the current merge_key is itself one of the identity keys',
  );
  check(
    identityKeysFor(run1Apps).every((k) => identityKeysFor(run2Apps).includes(k)),
    'identity: the key set only grows as the corpus grows (N runs converge on one row)',
  );
  check(
    !identityKeysFor([fbA]).some((k) => identityKeysFor([fbB]).includes(k)),
    'identity: unrelated publishers share NO identity key (a shared host is not one)',
  );

  // Absorbing a duplicate an earlier run created must not drop data.
  const mkPub = (o: Partial<PublisherRow>): PublisherRow => ({
    id: 0, merge_key: 'k', name: 'N', play_developer_id: null, apple_seller_name: null, website: null,
    email: null, countries_charted: '[]', countries_seen: '[]', verticals: '[]', charted_app_count: 0,
    app_count: 1, best_rank: null, both_stores: 0, in_band: 0, source_mix: '{}', gatc_advertiser_id: null,
    gatc_ads_count: null, meta_active_ads: null, confirmed_advertiser: 0, is_game_publisher: 0, is_charted: 0,
    preview_url: null, preview_title: null, score: 0, last_confirm_at: null, created_at: 0, updated_at: 0, ...o,
  });
  const keepRow = mkPub({ id: 1, name: 'Acme', app_count: 1, countries_seen: '["us"]', verticals: '["finance"]', source_mix: '{"chart":1}', score: 10, last_confirm_at: 100 });
  const dropRow = mkPub({ id: 2, name: 'Acme Ltd', app_count: 3, countries_seen: '["de"]', verticals: '["shopping"]', source_mix: '{"chart":2,"search":1}', email: 'a@acme.com', gatc_ads_count: 7, confirmed_advertiser: 1, best_rank: 12, score: 40, last_confirm_at: 900 });
  const absorbed = mergePublisherFields(keepRow, dropRow);
  check(absorbed.email === 'a@acme.com', 'absorb: the orphan’s email is not dropped');
  check((JSON.parse(absorbed.countries_seen) as string[]).join(',') === 'de,us', 'absorb: countries union');
  check((JSON.parse(absorbed.verticals) as string[]).length === 2, 'absorb: verticals union');
  check(absorbed.gatc_ads_count === 7 && absorbed.confirmed_advertiser === 1, 'absorb: confirmation evidence survives');
  check(absorbed.last_confirm_at === 900, 'absorb: keeps the LATER confirmation stamp');
  check(absorbed.app_count === 3 && absorbed.best_rank === 12, 'absorb: keeps the richer portfolio, never the sum');
  check(absorbed.name === 'Acme Ltd', 'absorb: the richer row names the entity');
  // Idempotent: once folded together, absorbing again is the identity.
  const absorbedRow = { ...keepRow, ...absorbed };
  check(
    JSON.stringify(mergePublisherFields(absorbedRow, absorbedRow)) === JSON.stringify(absorbed),
    'absorb: re-running over the merged row changes nothing',
  );

  // countries_seen must carry NON-chart sightings too, else the whole long tail
  // rolls up with markets=[] and ships leads with no country.
  const tailAgg = new Map<string, AppAgg>([
    [
      'google_play|com.tail.app',
      {
        countriesCharted: new Set<string>(),
        countriesSeen: new Set(['de', 'gb']),
        bestRank: null,
        isChart: false,
        sources: new Map([['search', 1]]),
        verticals: new Set(['finance']),
        title: 'Tail App',
      },
    ],
  ]);
  const tailRow = buildPublisherRow(
    [mkDetail({ store: 'google_play', app_id: 'com.tail.app', developer: 'Tail Co', developer_id: 'dev-tail' })],
    tailAgg,
  );
  const seen = JSON.parse(tailRow.countries_seen || '[]') as string[];
  check(seen.includes('de') && seen.includes('gb'), 'countries_seen: non-chart sightings are kept (tail publisher)');
  check(tailRow.is_charted === 0, 'countries_seen premise: the tail publisher really is un-charted');
  check(JSON.parse(tailRow.countries_charted || '[]').length === 0, 'countries_charted: still chart-only');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('publisherRollup.js') || process.argv[1].endsWith('publisherRollup.ts'));
if (isMain) {
  const { passed, failed, failures } = runPublisherRollupTests();
  console.log(`publisherRollup tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
