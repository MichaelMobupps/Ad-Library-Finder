/**
 * Store-first discovery — THE single constants file (spec CONSTRAINT #3).
 *
 * Every tunable for the store-first + long-tail pipeline lives here with a
 * comment: markets, the vertical map (Play category + Apple genre), charts, the
 * long-tail caps, the per-vertical search-term battery, throttles, the install
 * band, and the scoring weights. The pipeline and its source modules import from
 * here and nowhere else — there are no magic numbers scattered across the build.
 *
 * DISCOVERY comes from app-store data. GATC + Meta are CONFIRMATION only. A
 * publisher found outside the top charts is never marked a confirmed advertiser
 * without a GATC or Meta hit (enforced in storeConfirm.ts / publisherScore.ts).
 *
 * Values marked "(env: X)" may be overridden by an environment variable for ops
 * tuning without a code change; the seed value is the spec's exact default.
 */

import { normalizeMaxLeads } from './csv.js';

// ── small env helpers (mirror the clampInt pattern used across the codebase) ──
function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Markets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full market universe (ISO-3166 alpha-2, lower-case — Apple RSS wants
 * lower-case; Play/iTunes are case-insensitive): ALL global geos except the
 * obviously irrelevant/embargoed — North Korea, Iran, Syria, Cuba, Antarctica
 * and uninhabited/micro territories. A market one store does not serve degrades
 * gracefully (its fetch returns [] and the run moves on), so breadth here is a
 * SELECTABLE universe, not a promise both stores serve every code.
 */
export const ALL_MARKETS = [
  // Americas
  'us', 'ca', 'mx', 'gt', 'bz', 'hn', 'sv', 'ni', 'cr', 'pa', 'do', 'ht', 'jm', 'tt', 'bs', 'bb',
  'ar', 'bo', 'br', 'cl', 'co', 'ec', 'gy', 'py', 'pe', 'sr', 'uy', 've',
  // Europe
  'gb', 'ie', 'fr', 'de', 'at', 'ch', 'be', 'nl', 'lu', 'es', 'pt', 'it', 'mt', 'gr', 'cy',
  'dk', 'se', 'no', 'fi', 'is', 'ee', 'lv', 'lt', 'pl', 'cz', 'sk', 'hu', 'si', 'hr', 'ba',
  'rs', 'me', 'mk', 'al', 'ro', 'bg', 'md', 'ua', 'by', 'ru',
  // Middle East
  'il', 'tr', 'sa', 'ae', 'qa', 'kw', 'bh', 'om', 'jo', 'lb', 'iq', 'eg', 'ye',
  // Africa
  'za', 'ng', 'ke', 'gh', 'tz', 'ug', 'ci', 'sn', 'cm', 'ma', 'dz', 'tn', 'ly', 'et', 'zm',
  'zw', 'mu', 'mz', 'ao', 'bw', 'na', 'rw', 'cd',
  // Asia
  'in', 'pk', 'bd', 'lk', 'np', 'af', 'mm', 'th', 'vn', 'kh', 'la', 'my', 'sg', 'id', 'ph',
  'bn', 'cn', 'hk', 'tw', 'mo', 'jp', 'kr', 'kz', 'uz', 'kg', 'mn', 'ge', 'am', 'az',
  // Oceania
  'au', 'nz', 'fj', 'pg',
] as const;
export type Market = (typeof ALL_MARKETS)[number];

/**
 * Markets a run touches when the job does not name its own — a CURATED
 * high-value default, NOT the full universe.
 *
 * The capped phases (similar crawl, search battery, enrichment, catalogs,
 * confirmation) rotate least-recently-visited first, so widening only widens
 * coverage there — but the CHART harvest runs in full per (vertical x market),
 * and at ~60 throttled store requests per market the full 130+ market universe
 * would turn the chart phase alone into hours. The default therefore stays the
 * original 12-market core; a job that names its own markets (the UI country
 * picker) can select ANY subset of ALL_MARKETS, accepting the longer run.
 */
export const DEFAULT_ACTIVE_MARKETS: Market[] = ['us', 'gb', 'de', 'fr', 'in', 'br', 'mx', 'id', 'jp', 'kr', 'tr', 'il'];

// ─────────────────────────────────────────────────────────────────────────────
// Vertical map — Play category token + Apple genre id
// ─────────────────────────────────────────────────────────────────────────────

export interface VerticalDef {
  id: string;
  label: string;
  /** google-play-scraper category token (gplay.category.<PLAY>). For the games
   *  vertical this is the base "GAME"; expandGames pulls every GAME_* subcategory
   *  constant at harvest time (playSource.expandPlayCategories). */
  play: string;
  /** Apple RSS / iTunes genre id. */
  appleGenre: string;
  /** True only for the games vertical — expands Play GAME → GAME + GAME_*. */
  expandGames?: boolean;
}

export const VERTICALS: VerticalDef[] = [
  { id: 'finance', label: 'Finance', play: 'FINANCE', appleGenre: '6015' },
  { id: 'shopping', label: 'Shopping', play: 'SHOPPING', appleGenre: '6024' },
  { id: 'health_fitness', label: 'Health & Fitness', play: 'HEALTH_AND_FITNESS', appleGenre: '6013' },
  { id: 'entertainment', label: 'Entertainment', play: 'ENTERTAINMENT', appleGenre: '6016' },
  { id: 'social', label: 'Social', play: 'SOCIAL', appleGenre: '6005' },
  { id: 'productivity', label: 'Productivity', play: 'PRODUCTIVITY', appleGenre: '6007' },
  { id: 'travel', label: 'Travel', play: 'TRAVEL_AND_LOCAL', appleGenre: '6003' },
  { id: 'education', label: 'Education', play: 'EDUCATION', appleGenre: '6017' },
  { id: 'games', label: 'Games', play: 'GAME', appleGenre: '6014', expandGames: true },
];

export const VERTICAL_IDS = VERTICALS.map((v) => v.id);
/**
 * Verticals a run touches when the job does not name its own — ALL of them,
 * subverticals included: `games` carries expandGames, so its single entry fans
 * out to GAME plus all 17 GAME_* Play subcategories at harvest time (18 chart
 * categories), while the other eight map to one Play category each. Same
 * reasoning as DEFAULT_ACTIVE_MARKETS — the capped, rotating phases turn a wider
 * default into wider coverage rather than a longer single run.
 */
export const DEFAULT_ACTIVE_VERTICALS = [...VERTICAL_IDS];

export function verticalById(id: string): VerticalDef | undefined {
  return VERTICALS.find((v) => v.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────────────────────────────────────

/** Play collections harvested. google-play-scraper collection tokens. */
export const PLAY_CHARTS = ['TOP_FREE', 'TOP_GROSSING'] as const;
export type PlayChart = (typeof PLAY_CHARTS)[number];

/** Apple RSS feeds harvested. Only top-free per the spec. */
export const APPLE_CHARTS = ['top-free'] as const;
export type AppleChart = (typeof APPLE_CHARTS)[number];

/**
 * How deep the charts go per store — REQUESTED depth. Both stores cap the real
 * response well below the spec's asks, measured live rather than assumed:
 *   • Play  — gplay.list() returns at most 200 rows per (category, collection),
 *             whatever num says. The spec's 500 is kept as the request so a
 *             future server-side increase is picked up for free; expect 200.
 *   • Apple — the legacy iTunes RSS chart feed hard-caps at 100 entries however
 *             large `limit=` is, so asking for more just inflates the URL.
 */
export const PLAY_CHART_NUM = clampInt(process.env.STORE_PLAY_CHART_NUM, 500, 50, 500); // (env: STORE_PLAY_CHART_NUM)
export const APPLE_CHART_NUM = clampInt(process.env.STORE_APPLE_CHART_NUM, 100, 25, 200); // (env: STORE_APPLE_CHART_NUM)

// ─────────────────────────────────────────────────────────────────────────────
// Long-tail tunables (spec CONFIG)
// ─────────────────────────────────────────────────────────────────────────────

/** Max depth the similar-apps crawl descends. Depth-0 = chart apps; a depth-N
 *  app is never crawled FROM once N === SIMILAR_MAX_DEPTH. */
export const SIMILAR_MAX_DEPTH = clampInt(process.env.STORE_SIMILAR_MAX_DEPTH, 2, 0, 5); // (env)
/** Hard cap on NEW apps the similar crawl adds per run. */
export const SIMILAR_MAX_APPS_PER_RUN = clampInt(process.env.STORE_SIMILAR_MAX_APPS, 5000, 0, 50_000); // (env)
/**
 * Hard cap on similar-apps REQUESTS per run, independent of how many new apps
 * they yield. SIMILAR_MAX_APPS_PER_RUN alone only bounds NEW rows, so once the
 * graph is saturated a re-run inserts nothing, never trips that cap, and walks
 * every seed at 1 req/s for hours to discover zero apps. At the 1 req/s Play
 * throttle this bound is roughly its own value in seconds (1000 ≈ 17 min).
 */
export const SIMILAR_MAX_REQUESTS_PER_RUN = clampInt(process.env.STORE_SIMILAR_MAX_REQUESTS, 1000, 0, 50_000); // (env)
/**
 * Hard cap on store-search REQUESTS per run (Play + iTunes counted together).
 *
 * The battery is verticals x markets x terms, so it is the ONE phase whose cost
 * grows with the active scope rather than with a cap of its own: at the full
 * default scope that is 9 x 12 x 15 = 1620 cells, and because each cell awaits an
 * iTunes slot (6s) alongside its Play slot (1s), an uncapped battery runs ~2.7h
 * and dominates every other phase combined.
 *
 * This bounds ONE RUN, not total coverage: cells are ordered least-recently
 * -searched first (search_battery_cell), so successive runs sweep the whole grid
 * instead of re-running the first N cells forever. At the default 600 the full
 * 1620-cell grid completes in ~6 runs.
 */
export const SEARCH_MAX_REQUESTS_PER_RUN = clampInt(process.env.STORE_SEARCH_MAX_REQUESTS, 600, 0, 50_000); // (env)
/** Install band for non-chart Play apps — outside this range they are stored but
 *  skip enrichment & confirmation (chart apps are exempt). */
export const TAIL_MIN_INSTALLS = clampInt(process.env.STORE_TAIL_MIN_INSTALLS, 50_000, 0, 1_000_000_000); // (env)
export const TAIL_MAX_INSTALLS = clampInt(process.env.STORE_TAIL_MAX_INSTALLS, 5_000_000, 1, 5_000_000_000); // (env)
/**
 * Ceiling on confirmation API calls (GATC + Meta) per run.
 *
 * This is the ONLY paid surface in the pipeline (~$0.002 per RPC round-trip
 * through the residential proxy), and at ~3 calls per publisher it is what decides
 * how much of the corpus carries an Ads Transparency verdict. It matters more now
 * that the export is confirmed-only (EXPORT_CONFIRMED_ONLY): a publisher the budget
 * never reached is absent from the deliverable, so the budget is effectively the
 * size of each run's Excel. 2000 ≈ 650 publishers ≈ $4/run; coverage accumulates
 * because listPublishersForConfirmation orders by last_confirm_at ascending.
 */
export const CONFIRMATION_MAX_API_CALLS_PER_RUN = clampInt(process.env.STORE_CONFIRM_MAX_CALLS, 2_000, 0, 10_000); // (env)

/**
 * Export only publishers with an Ads Transparency (or Meta) hit.
 *
 * The deliverable is "app companies that actually advertise on Google", so an
 * unconfirmed publisher — whether it was checked and had no ads, or was never
 * reached by the confirmation budget — is not a lead yet and stays out of the CSV
 * and the Excel. It remains in the Publishers table and in the DB, and becomes
 * exportable the run its verdict comes back positive. Set false to export the full
 * discovered set with a `confirmed` column instead.
 */
export const EXPORT_CONFIRMED_ONLY = process.env.STORE_EXPORT_CONFIRMED_ONLY !== 'false'; // (env)
/**
 * Absolute ceiling on the confirmation budget a JOB BODY may request. GATC
 * confirmation is the only paid surface in this pipeline (residential proxy), and
 * the per-job override is caller-supplied, so without an operator-owned hard cap
 * any request could ask for 50x the configured default and spend accordingly.
 */
export const CONFIRMATION_HARD_MAX_API_CALLS = clampInt(
  process.env.STORE_CONFIRM_HARD_MAX_CALLS,
  Math.max(1000, CONFIRMATION_MAX_API_CALLS_PER_RUN * 4),
  0,
  10_000,
); // (env)

// ─────────────────────────────────────────────────────────────────────────────
// Throttles (store endpoints)
// ─────────────────────────────────────────────────────────────────────────────

/** Play: 1 request / second PER STREAM across google-play-scraper calls. */
export const PLAY_REQUEST_INTERVAL_MS = clampInt(process.env.STORE_PLAY_INTERVAL_MS, 1_000, 0, 30_000); // (env)
/**
 * How many Play requests may be in flight at once.
 *
 * This is THE speed lever for the whole pipeline. Enrichment is one Play detail
 * fetch per app, and at concurrency 1 a measured run spent 5,682 serialized
 * fetches = 1h50m, i.e. 71% of a 2h34m job, while the Apple stream sat idle
 * after 48 seconds. The limiter divides the interval by this number, so the
 * aggregate target rate is `concurrency` req/s — five polite 1-req/s streams,
 * not a five-fold increase in per-stream aggression.
 *
 * Play answers these from public listing pages and tolerates this comfortably
 * from a residential exit; `playRequestBlocked()` additionally trips an adaptive
 * backoff across every stream on a 429/403/block page. Set to 1 to restore the
 * old strictly-serial behaviour.
 */
export const PLAY_CONCURRENCY = clampInt(process.env.STORE_PLAY_CONCURRENCY, 5, 1, 16); // (env)
/**
 * iTunes: interval between requests across ALL itunes.apple.com endpoints.
 *
 * Was 6000ms (10 req/min) — deliberately far under Apple's practical tolerance,
 * and the binding constraint on the developer-catalog phase, which is one
 * un-batchable request per catalog: a measured run spent 26 minutes there, of
 * which Apple's 250 catalogs were ~25 min while Play's 250 finished in ~8 and
 * idled. 3000ms (20 req/min) halves that phase and still leaves generous
 * headroom; the /lookup path batches 100 ids per request either way.
 */
export const ITUNES_REQUEST_INTERVAL_MS = clampInt(process.env.STORE_ITUNES_INTERVAL_MS, 3_000, 0, 60_000); // (env)
/** In-flight cap for iTunes. Deliberately 1: Apple is stricter than Play and the
 *  interval above already doubled the rate. Raise only with evidence. */
export const ITUNES_CONCURRENCY = clampInt(process.env.STORE_ITUNES_CONCURRENCY, 1, 1, 8); // (env)
/** How long a detected Play block backs off EVERY Play stream. */
export const PLAY_BLOCK_BACKOFF_MS = clampInt(process.env.STORE_PLAY_BLOCK_BACKOFF_MS, 30_000, 0, 600_000); // (env)
/** iTunes /lookup batch size (Apple tolerates ~200; stay at 100). */
export const ITUNES_LOOKUP_BATCH = clampInt(process.env.STORE_ITUNES_BATCH, 100, 1, 200); // (env)
/** iTunes store search page size (max 200). */
export const ITUNES_SEARCH_LIMIT = clampInt(process.env.STORE_ITUNES_SEARCH_LIMIT, 200, 1, 200); // (env)
/** Play store search page size (spec: 30). */
export const PLAY_SEARCH_NUM = clampInt(process.env.STORE_PLAY_SEARCH_NUM, 30, 1, 250); // (env)
/**
 * Fast-lane winner enrichment (confirm-before-enrich).
 *
 * A publisher confirmed from list-payload identity alone still needs contact
 * details before it can ship as a lead, so its apps are detail-fetched on
 * demand. These bound ONE checkpoint's on-demand pass so a single harvest cannot
 * balloon into a full enrichment run; the remaining publishers are picked up by
 * the next pass. Spend comes out of the run's shared ENRICH_MAX_APPS_PER_RUN
 * pool, so this re-prioritises fetches toward leads rather than adding any.
 */
export const WINNER_ENRICH_MAX_PUBLISHERS = clampInt(process.env.STORE_WINNER_ENRICH_MAX_PUBS, 40, 0, 2_000); // (env)
/** Apps per confirmed publisher to enrich for contact details. A developer's
 *  email/website is identical across their portfolio, so the first few charted
 *  apps almost always answer it — fetching the whole catalog would be waste. */
export const WINNER_ENRICH_APPS_PER_PUBLISHER = clampInt(process.env.STORE_WINNER_ENRICH_APPS, 3, 1, 50); // (env)

/** Retry a failed enrichment at most this many times across runs, then give up. */
export const MAX_ENRICH_ATTEMPTS = clampInt(process.env.STORE_MAX_ENRICH_ATTEMPTS, 3, 1, 10); // (env)
/** Ceiling on apps enriched (network) per run — bounds a huge long-tail from
 *  running the 1-req/sec Play detail fetch for hours. Cache hits don't count. */
export const ENRICH_MAX_APPS_PER_RUN = clampInt(process.env.STORE_ENRICH_MAX_APPS, 4000, 0, 50_000); // (env)
// ── Liveness sweep (the catalog is permanent, so it must be kept honest) ─────
/**
 * How many known apps a run re-checks for "still listed on the store".
 *
 * discovered_apps and store_app_detail accumulate forever and are never
 * re-fetched once enriched — which is exactly what makes repeat runs fast, and
 * also what lets the catalog drift: an app pulled from the store keeps counting
 * toward its publisher's portfolio indefinitely. This sweep re-checks the
 * least-recently-checked apps within a bounded budget.
 *
 * Play and Apple cost wildly different amounts here, so they get separate
 * budgets: a Play check is one throttled request PER APP (1 req/s), while Apple
 * checks 100 ids per request (~6s per 100). Hence Apple's budget is ~20x Play's
 * for a comparable slice of wall-clock.
 */
export const LIVENESS_MAX_PLAY_PER_RUN = clampInt(process.env.STORE_LIVENESS_MAX_PLAY, 300, 0, 50_000); // (env)
export const LIVENESS_MAX_APPLE_PER_RUN = clampInt(process.env.STORE_LIVENESS_MAX_APPLE, 6_000, 0, 200_000); // (env)
/** An app checked more recently than this many days ago is not re-checked. */
export const LIVENESS_RECHECK_AFTER_DAYS = clampInt(process.env.STORE_LIVENESS_RECHECK_DAYS, 30, 1, 3650); // (env)

/** Per-store-request timeout. */
export const STORE_FETCH_TIMEOUT_MS = clampInt(process.env.STORE_FETCH_TIMEOUT_MS, 15_000, 2_000, 60_000); // (env)
/**
 * Play developer-catalog page size (step 8 developer_catalog expansion).
 * google-play-scraper treats `num` as a HARD cap, not a page hint: processPages'
 * checkFinished slices the accumulated apps to opts.num and stops paginating, so
 * a developer with a 200-app portfolio comes back TRUNCATED at this value. 120
 * covers the overwhelming majority of portfolios at ~2 paginated requests per
 * catalog under the 1 req/sec Play throttle; raise it when a run must capture
 * the full portfolio of very large publishers.
 */
export const PLAY_DEV_CATALOG_NUM = clampInt(process.env.STORE_PLAY_DEV_CATALOG_NUM, 120, 1, 500); // (env)
/** Ceiling on developer catalogs fetched per run (step 8 expansion) — one Play
 *  and/or Apple catalog fetch per publisher-with-contact can be large, so bound
 *  it. Each catalog is throttled like any other store call. */
export const DEV_CATALOG_MAX_PER_RUN = clampInt(process.env.STORE_DEV_CATALOG_MAX, 500, 0, 10_000); // (env)
/** Cap on NEW apps the catalog expansion may add per run. The per-developer cap
 *  bounds each request, not the total: DEV_CATALOG_MAX_PER_RUN catalogs x up to
 *  PLAY_DEV_CATALOG_NUM apps each (500 x 120) could add ~60k rows in one run,
 *  which every later run then reloads and re-enriches. */
export const DEV_CATALOG_MAX_APPS_PER_RUN = clampInt(process.env.STORE_DEV_CATALOG_MAX_APPS, 5_000, 0, 100_000); // (env)

// ─────────────────────────────────────────────────────────────────────────────
// Scoring weights (0..100). Two profiles: charted publishers vs tail-only.
// (spec IMPLEMENTATION step 11.)
// ─────────────────────────────────────────────────────────────────────────────

export const CHARTED_WEIGHTS = {
  bestRank: 25, // best chart rank, scaled (rank 1 → full, deeper → less)
  multiCountry: 15, // charted in 2+ countries
  multiApp: 10, // 2+ charted apps
  bothStores: 10, // present on Play AND Apple
  gatcAds: 25, // GATC ads_count, scaled
  metaAds: 15, // Meta store-link active ads, scaled
} as const;

export const TAIL_WEIGHTS = {
  gatcAds: 40, // GATC ads_count, scaled
  metaAds: 20, // Meta store-link active ads, scaled
  installBand: 20, // proximity to the install-band midpoint (log scale)
  portfolio: 10, // 2+ apps in portfolio
  freshUpdate: 10, // an app updated within FRESH_UPDATE_DAYS
} as const;

/** Additive bonus when a publisher is NOT a game publisher. Default 0 (spec). */
export const NON_GAME_BONUS = clampInt(process.env.STORE_NON_GAME_BONUS, 0, 0, 50); // (env)

/** "Recently updated" window used by the tail freshUpdate component. */
export const FRESH_UPDATE_DAYS = clampInt(process.env.STORE_FRESH_UPDATE_DAYS, 90, 1, 3650); // (env)

/** ads_count that saturates the scaled GATC/Meta components (>= this → full). */
export const GATC_ADS_SATURATION = clampInt(process.env.STORE_GATC_ADS_SATURATION, 40, 1, 10_000); // (env)
export const META_ADS_SATURATION = clampInt(process.env.STORE_META_ADS_SATURATION, 20, 1, 10_000); // (env)
/** Chart depth that saturates the bestRank component (rank <= this scales from 1). */
export const BEST_RANK_SATURATION = clampInt(process.env.STORE_BEST_RANK_SATURATION, 200, 1, 1000); // (env)

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation providers
// ─────────────────────────────────────────────────────────────────────────────

/** Meta (ScrapeCreators) confirmation runs only when this key is present; absent
 *  ⇒ Meta is skipped and its score component stays 0 (spec DATA SOURCES). */
export const META_CONFIRM_ENABLED = !!process.env.SCRAPECREATORS_API_KEY;
/** Store-link host fragments that mark a Meta ad as an app-install ad. */
export const META_STORE_LINK_HOSTS = [
  'play.google.com',
  'apps.apple.com',
  'itunes.apple.com',
  'onelink.me',
  'app.link',
  'adj.st',
  'go.link',
  'sng.link',
  'smart.link',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Publisher-merge safety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hosts that MANY unrelated publishers legitimately share, so a domain match on
 * them proves nothing about common ownership (spec step 9 merges on website
 * domain). Without this, every developer who lists a Facebook page or a
 * sites.google.com page as their store website would union into ONE giant
 * publisher, silently collapsing dozens of distinct leads into a single row.
 *
 * Only EXACT-host platforms belong here. Hosts where each publisher gets its own
 * subdomain (`acme.wixsite.com`, `acme.github.io`, `acme.wordpress.com`) are
 * already safe, because registrableDomain() keeps the full hostname.
 */
export const SHARED_HOST_DOMAINS: ReadonlySet<string> = new Set([
  // Social / link-in-bio
  'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me',
  'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be',
  'linkedin.com', 'tiktok.com', 'pinterest.com', 'reddit.com',
  'linktr.ee', 'linkin.bio', 'beacons.ai', 't.me', 'telegram.me', 'discord.gg', 'wa.me',
  // Generic site builders / doc hosts that expose a shared apex
  'sites.google.com', 'docs.google.com', 'drive.google.com', 'groups.google.com',
  'google.com', 'blogger.com', 'medium.com', 'notion.so', 'about.me',
  // App stores themselves (a store URL is not a brand website)
  'play.google.com', 'apps.apple.com', 'itunes.apple.com', 'appstore.com',
  // URL shorteners
  'bit.ly', 'tinyurl.com', 'goo.gl', 'cutt.ly',
  // Mail hosts, in case a mail domain leaks into a website field
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'qq.com', '163.com',
]);

/** True when a domain is too widely shared to imply common ownership. */
export function isSharedHost(domain: string): boolean {
  return SHARED_HOST_DOMAINS.has(domain.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Long-tail search-term battery — 15 terms / vertical (spec CONFIG).
// finance is the spec seed verbatim; the rest are equivalent intent lists.
// ─────────────────────────────────────────────────────────────────────────────

export const TAIL_SEARCH_TERMS: Record<string, string[]> = {
  finance: [
    'loan app', 'personal loan', 'budget tracker', 'money transfer', 'crypto wallet',
    'trading app', 'cashback', 'credit score', 'invoice app', 'savings app',
    'bnpl', 'forex', 'stock alerts', 'expense manager', 'instant loan',
  ],
  shopping: [
    'online shopping', 'deals app', 'coupons', 'price comparison', 'cashback shopping',
    'marketplace', 'fashion store', 'grocery delivery', 'wishlist', 'flash sale',
    'thrift resale', 'buy now pay later', 'discount codes', 'shopping list', 'auction app',
  ],
  health_fitness: [
    'workout tracker', 'calorie counter', 'step counter', 'home workout', 'meditation app',
    'sleep tracker', 'yoga app', 'running tracker', 'weight loss', 'period tracker',
    'water reminder', 'fasting tracker', 'gym log', 'meal planner', 'heart rate monitor',
  ],
  entertainment: [
    'streaming app', 'movies app', 'live tv', 'music player', 'podcast app',
    'anime app', 'short video', 'ringtones', 'radio app', 'ebook reader',
    'comics app', 'karaoke', 'wallpaper app', 'trivia game', 'fan community',
  ],
  social: [
    'chat app', 'dating app', 'video call', 'social network', 'anonymous chat',
    'group messaging', 'live streaming', 'community app', 'friends finder', 'voice chat',
    'photo sharing', 'status maker', 'meetup app', 'forum app', 'social feed',
  ],
  productivity: [
    'to do list', 'note taking', 'calendar app', 'pdf scanner', 'password manager',
    'file manager', 'email client', 'time tracker', 'habit tracker', 'document editor',
    'cloud storage', 'reminder app', 'mind map', 'project planner', 'qr scanner',
  ],
  travel: [
    'flight booking', 'hotel booking', 'trip planner', 'maps offline', 'ride hailing',
    'car rental', 'travel guide', 'currency converter', 'translator app', 'metro map',
    'road trip', 'campground finder', 'travel deals', 'itinerary app', 'parking app',
  ],
  education: [
    'language learning', 'math solver', 'flashcards', 'online courses', 'kids learning',
    'exam prep', 'dictionary app', 'coding tutorial', 'homework help', 'quiz app',
    'study planner', 'vocabulary builder', 'science app', 'history app', 'test prep',
  ],
  games: [
    'puzzle game', 'match 3', 'idle game', 'racing game', 'card game',
    'word game', 'strategy game', 'casino slots', 'shooter game', 'simulation game',
    'trivia quiz', 'board game', 'rpg game', 'arcade game', 'merge game',
  ],
};

/** The 15-term list for a vertical (empty array for an unknown id). */
export function tailSearchTerms(verticalId: string): string[] {
  return TAIL_SEARCH_TERMS[verticalId] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Job-parameter resolution — a run's active markets/verticals/charts/caps come
// from the job's source_params, falling back to the defaults above.
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreDiscoveryParams {
  verticals: string[];
  markets: Market[];
  playCharts: PlayChart[];
  appleCharts: AppleChart[];
  similarMaxAppsPerRun: number;
  searchTermsLimit: number | null; // cap terms/vertical (smoke uses 5); null = all 15
  confirmationMaxApiCalls: number;
  /** Operator-chosen cap on EXPORTED leads (best-scored first); null = all found. */
  maxLeads: number | null;
}

/** Normalize an arbitrary source_params blob into a fully-defaulted param set. */
export function resolveStoreParams(raw: unknown): StoreDiscoveryParams {
  const p = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) ?? {};

  const verticals = Array.isArray(p.verticals)
    ? (p.verticals as unknown[]).map((v) => String(v).trim()).filter((v) => VERTICAL_IDS.includes(v))
    : [];
  const markets = Array.isArray(p.markets)
    ? (p.markets as unknown[])
        .map((m) => String(m).trim().toLowerCase())
        .filter((m): m is Market => (ALL_MARKETS as readonly string[]).includes(m))
    : [];

  // NB: an ABSENT tunable must fall back to its default, not to 0. Number(null)
  // is 0 and Number.isFinite(0) is true, so a bare `Number(v)` check silently
  // turned every omitted cap into 0 — a store_first job posted without a
  // storeFirst body (the route stores nulls for the ones it did not receive) ran
  // with similarMaxAppsPerRun=0 and confirmationMaxApiCalls=0, i.e. no long-tail
  // crawl and no confirmation at all, while reporting success.
  const num = (v: unknown, def: number, min: number, max: number) => {
    if (v == null || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : def;
  };

  return {
    verticals: verticals.length ? [...new Set(verticals)] : [...DEFAULT_ACTIVE_VERTICALS],
    markets: markets.length ? [...new Set(markets)] : [...DEFAULT_ACTIVE_MARKETS],
    playCharts: [...PLAY_CHARTS],
    appleCharts: [...APPLE_CHARTS],
    similarMaxAppsPerRun: num(p.similarMaxAppsPerRun, SIMILAR_MAX_APPS_PER_RUN, 0, 50_000),
    searchTermsLimit:
      p.searchTermsLimit == null ? null : num(p.searchTermsLimit, 15, 0, 15),
    // Clamped to the operator-owned hard ceiling, not to the schema max — this is
    // the authoritative read of a caller-supplied paid-API budget.
    confirmationMaxApiCalls: num(
      p.confirmationMaxApiCalls,
      CONFIRMATION_MAX_API_CALLS_PER_RUN,
      0,
      CONFIRMATION_HARD_MAX_API_CALLS,
    ),
    // Absent/invalid ⇒ null ⇒ "as many as found". NOT defaulted to a number:
    // silently capping an operator who never asked for a cap would look like the
    // search simply stopped finding leads.
    maxLeads: normalizeMaxLeads(p.maxLeads),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline self-tests (no network / no DB). Run via `node dist/storeDiscoveryConfig.js`.
// ─────────────────────────────────────────────────────────────────────────────

export function runStoreConfigTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // Global universe: all geos minus the embargoed/irrelevant exclusions.
  check(ALL_MARKETS.length >= 100, `markets: global universe (got ${ALL_MARKETS.length})`);
  check(new Set(ALL_MARKETS).size === ALL_MARKETS.length, 'markets: no duplicate codes');
  check(ALL_MARKETS.every((m) => /^[a-z]{2}$/.test(m)), 'markets: all lower-case ISO alpha-2');
  for (const excluded of ['kp', 'ir', 'sy', 'cu', 'aq']) {
    check(!(ALL_MARKETS as readonly string[]).includes(excluded), `markets: ${excluded} stays excluded (embargoed/irrelevant)`);
  }
  check(DEFAULT_ACTIVE_MARKETS.every((m) => (ALL_MARKETS as readonly string[]).includes(m)), 'default markets ⊆ universe');
  check(VERTICALS.length === 9, 'verticals: 9 defined');
  check(verticalById('finance')?.appleGenre === '6015', 'finance apple genre 6015');
  check(verticalById('games')?.expandGames === true, 'games vertical expands GAME_*');
  // Every vertical has exactly 15 search terms.
  for (const v of VERTICALS) {
    check(tailSearchTerms(v.id).length === 15, `${v.id}: 15 search terms`);
    check(new Set(tailSearchTerms(v.id)).size === 15, `${v.id}: search terms unique`);
  }
  // finance seed is the spec's verbatim first/last term.
  check(tailSearchTerms('finance')[0] === 'loan app', 'finance seed[0] = "loan app"');
  check(tailSearchTerms('finance')[14] === 'instant loan', 'finance seed[14] = "instant loan"');

  // resolveStoreParams defaults + filtering
  const d = resolveStoreParams(undefined);
  // Assert the CONTRACT (an absent field resolves to the configured default),
  // not the literal scope — the scope is an operator tunable and pinning it here
  // means every retune breaks a test that was not testing the retune.
  check(d.verticals.join(',') === DEFAULT_ACTIVE_VERTICALS.join(','), 'params: absent verticals → configured default');
  check(d.markets.join(',') === DEFAULT_ACTIVE_MARKETS.join(','), 'params: absent markets → configured default');
  // The scope itself is pinned separately. Markets: the default is deliberately
  // the curated 12-market core (the chart harvest is uncapped per market, so
  // "all 130+ by default" would make every unpinned run take hours) while the
  // UNIVERSE is global — the UI picker exposes all of it per job. Verticals:
  // all of them, unchanged.
  check(DEFAULT_ACTIVE_MARKETS.length === 12, 'scope: default markets stay the curated 12-market core');
  check(ALL_MARKETS.length > DEFAULT_ACTIVE_MARKETS.length, 'scope: the selectable universe is wider than the default');
  check(DEFAULT_ACTIVE_VERTICALS.length === VERTICALS.length, 'scope: every vertical is active by default');
  check(DEFAULT_ACTIVE_VERTICALS.includes('games'), 'scope: games (and its GAME_* subcategories) is active by default');
  check(
    VERTICALS.filter((v) => v.expandGames).length === 1,
    'scope: exactly one vertical fans out to Play subcategories',
  );
  const r = resolveStoreParams({ verticals: ['finance', 'bogus'], markets: ['US', 'zz'], searchTermsLimit: 5 });
  check(r.verticals.join(',') === 'finance', 'params: unknown vertical dropped');
  check(r.markets.join(',') === 'us', 'params: unknown market dropped, US lower-cased');
  check(r.searchTermsLimit === 5, 'params: searchTermsLimit honored');
  // Regression: an ABSENT/null cap must fall back to its default, never to 0.
  // The route stores null for tunables the client omitted, and Number(null) is 0.
  check(d.similarMaxAppsPerRun === SIMILAR_MAX_APPS_PER_RUN, 'params: absent similar cap → default, not 0');
  check(d.confirmationMaxApiCalls === CONFIRMATION_MAX_API_CALLS_PER_RUN, 'params: absent confirm cap → default, not 0');
  const nulls = resolveStoreParams({ similarMaxAppsPerRun: null, confirmationMaxApiCalls: null, verticals: null, markets: null });
  check(nulls.similarMaxAppsPerRun === SIMILAR_MAX_APPS_PER_RUN, 'params: null similar cap → default, not 0');
  check(nulls.confirmationMaxApiCalls === CONFIRMATION_MAX_API_CALLS_PER_RUN, 'params: null confirm cap → default, not 0');
  check(nulls.verticals.join(',') === DEFAULT_ACTIVE_VERTICALS.join(','), 'params: null verticals → configured default');
  // An EXPLICIT 0 is still honored (a caller may legitimately disable a stage).
  check(resolveStoreParams({ confirmationMaxApiCalls: 0 }).confirmationMaxApiCalls === 0, 'params: explicit 0 honored');
  // Lead cap: absent means "as many as found", never a silent default.
  check(resolveStoreParams({}).maxLeads === null, 'leads: absent cap → null (uncapped)');
  check(resolveStoreParams({ maxLeads: null }).maxLeads === null, 'leads: explicit null → uncapped');
  check(resolveStoreParams({ maxLeads: 20 }).maxLeads === 20, 'leads: 20 honored');
  check(resolveStoreParams({ maxLeads: 50 }).maxLeads === 50, 'leads: 50 honored');
  check(resolveStoreParams({ maxLeads: 100 }).maxLeads === 100, 'leads: 100 honored');
  check(resolveStoreParams({ maxLeads: '50' }).maxLeads === 50, 'leads: numeric string coerced');
  check(resolveStoreParams({ maxLeads: 0 }).maxLeads === null, 'leads: 0 → uncapped, never an empty export');
  check(resolveStoreParams({ maxLeads: -5 }).maxLeads === null, 'leads: negative → uncapped');
  check(resolveStoreParams({ maxLeads: 'abc' }).maxLeads === null, 'leads: junk → uncapped');
  // A job body cannot exceed the operator-owned paid-API ceiling.
  check(
    resolveStoreParams({ confirmationMaxApiCalls: 999_999 }).confirmationMaxApiCalls === CONFIRMATION_HARD_MAX_API_CALLS,
    'params: confirmation budget clamped to the hard ceiling',
  );
  check(CONFIRMATION_HARD_MAX_API_CALLS >= CONFIRMATION_MAX_API_CALLS_PER_RUN, 'params: hard ceiling >= default budget');

  // Page-size caps are tunables and must live HERE (spec CONSTRAINT 3), not as
  // literals at the call site: the Play developer-catalog `num` is a hard cap
  // that silently truncates a large portfolio, so ops must be able to raise it.
  check(
    Number.isInteger(PLAY_DEV_CATALOG_NUM) && PLAY_DEV_CATALOG_NUM > 0,
    'play developer-catalog page size is a positive integer tunable',
  );
  check(
    process.env.STORE_PLAY_DEV_CATALOG_NUM != null || PLAY_DEV_CATALOG_NUM === 120,
    'play developer-catalog page size defaults to the shipped 120',
  );

  // Scoring weights sum to 100 in each profile.
  const chartedSum = Object.values(CHARTED_WEIGHTS).reduce((a, b) => a + b, 0);
  const tailSum = Object.values(TAIL_WEIGHTS).reduce((a, b) => a + b, 0);
  check(chartedSum === 100, `charted weights sum to 100 (got ${chartedSum})`);
  check(tailSum === 100, `tail weights sum to 100 (got ${tailSum})`);

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeDiscoveryConfig.js') || process.argv[1].endsWith('storeDiscoveryConfig.ts'));
if (isMain) {
  const { passed, failed, failures } = runStoreConfigTests();
  console.log(`storeDiscoveryConfig tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
