/**
 * Web (CPS) offer policy — single source of truth.
 *
 * The mobile Affplus path resolves every offer to an app store. The web/CPS
 * path instead keeps offers the operator can actually run on the open web and
 * drops the rest. Affplus has no "scam" flag and no clean "vertical" axis (its
 * tags mix true verticals, payout models, and device platforms), so "can we
 * run this" is reconstructed from three cheap, free signals:
 *
 *   1. verticalDecision()  — coarse keep / screen / drop from the offer's
 *                            vertical tags + CATEGORY string.
 *   2. looksScammy()       — keyword screen over name + CATEGORY + DESCRIPTION
 *                            + creative text. Catches scams hiding under a
 *                            clean vertical tag (see the Buff PS5 example).
 *   3. isIntermediaryHost()— used by the resolver to reject network funnels,
 *                            trackers, shorteners, and LP builders so the CSV
 *                            carries advertiser destinations, not middlemen.
 *
 * Everything that needs tuning lives in the keyword/host sets below. Decisions
 * are binary (keep / drop) by design — there is no "needs review" bucket; the
 * operator cleans the CSV downstream and prefers fewer moving parts.
 *
 * Self-test: runWebPolicyTests() (mirrors storeResolver.runVerifyMatchTests).
 */

export type VerticalDecision = 'block' | 'allow' | 'screen';

// ---------------------------------------------------------------------------
// Config flags (env-overridable, default to the operator's stated policy).
// ---------------------------------------------------------------------------

/**
 * Betting / poker / lottery / bingo are blocked by default. Flip this one flag
 * to move them into the scam-screened "allow" bucket. Casino is NOT gated by
 * this flag — casino is always screened-allow per the operator's decision.
 */
const ALLOW_FLIPPABLE = process.env.AFFPLUS_ALLOW_BETTING === '1';

/**
 * What to do with an offer whose tags carry no recognized vertical signal at
 * all (only payout/platform/format tags, or unknown words). Default 'allow':
 * let the downstream scam screen, intermediary filter, and brand-token check
 * be the real precision gates. Set AFFPLUS_DEFAULT_VERTICAL=block for strict
 * allow-list-only behavior.
 */
const DEFAULT_DECISION: VerticalDecision =
  (process.env.AFFPLUS_DEFAULT_VERTICAL as VerticalDecision) || 'allow';

// ---------------------------------------------------------------------------
// Vertical policy sets (matched against affplus vertical tags + CATEGORY).
// Keywords are lowercase; matching is alnum-boundary (see containsKeyword).
// Precedence: hard-block > screen > flippable-block > allow-clean > default.
// ---------------------------------------------------------------------------

/** Never wanted. Dropped on tag/category alone, before any fetch. */
const HARD_BLOCK_KW = [
  'adult', 'cam', 'cams', 'webcam', 'webcams',
  'dating', 'hookup', 'hookups',
  'sweepstake', 'sweepstakes',
  'nutra', 'diet', 'cbd',
  'bizopp', 'biz opp', 'mlm',
  'payday', 'loan', 'loans',
  'pin', 'pin submit', '1wap', 'mobile content', 'vas',
  'binary', // binary options — banned for retail in several jurisdictions, fraud-associated. Forex stays allowed.
];

/** Allowed only if the scam screen passes. Forex + crypto + casino. */
const SCREEN_KW = ['casino', 'forex', 'crypto'];

/**
 * Blocked by default, one flag (ALLOW_FLIPPABLE) away from screened-allow.
 * "Casino ok, all others block per recommend." Casino is NOT in this list.
 */
const FLIPPABLE_BLOCK_KW = ['betting', 'gambling', 'poker', 'lottery', 'bingo', 'sport', 'sports'];

/**
 * Pass on the vertical gate. Still subject to the scam screen (cheap safety)
 * and the resolver's intermediary + brand-token checks.
 */
const ALLOW_CLEAN_KW = [
  'ecommerce', 'e-commerce', 'commerce', 'shopping', 'cod', 'dropship', 'dropshipping',
  'software', 'saas', 'vpn', 'antivirus', 'app', 'utility',
  'travel', 'insurance', 'education', 'edu',
  'streaming', 'subscription', 'vod', 'music', 'entertainment',
  'finance', 'credit', 'banking', 'mainstream',
  'service', 'auto', 'home', 'solar', 'real estate', 'legal',
  'coupon', 'freebie', 'business', 'job', 'jobs',
  'game', 'games', 'beauty', 'fitness', 'health', 'astrology', 'lifestyle',
];

// ---------------------------------------------------------------------------
// Scam-language screen (run over name + CATEGORY + DESCRIPTION + creative).
// Excludes flow descriptors like "soi"/"doi" deliberately: they appear in a
// huge fraction of legitimate offer names and would over-block. The Buff PS5
// case is caught by "raffle" / "win a" / "sweepstake" instead.
// ---------------------------------------------------------------------------

const SCAM_KEYWORDS = [
  // Impossible returns
  'guaranteed profit', 'guaranteed income', 'guaranteed returns', 'double your',
  '100x', '1000%', '500%', 'risk-free', 'risk free', 'get rich', 'passive income', 'millionaire',
  // Urgency / secrecy
  'act now', 'limited spots', 'secret method', 'loophole', "they don't want you to know",
  // Fake authority
  'as seen on', 'endorsed by', 'elon',
  // Free-trial / rebill bait
  'just pay shipping', 'claim your free', 'free trial',
  // Prize / lottery bait
  "you've won", 'you have won', 'claim your prize', 'spin to win', 'lucky winner',
  'free iphone', 'gift card', 'raffle', 'giveaway', 'sweepstake', 'win a', 'win an', 'prize',
  // Health miracle
  'miracle', 'doctors hate', 'ancient remedy', 'cure',
  // Crypto-specific
  'airdrop', 'presale', 'cloud mining', 'auto-trading', 'auto trading', 'guaranteed apy',
];

/**
 * Known scam-/fraud-associated brand families seen on affplus (crypto auto-
 * trading "robots", quiz-funnels). High signal on the screened buckets. This
 * is a tunable accelerator, not exhaustive — add fragments as you see them.
 */
const SCAM_BRAND_FRAGMENTS = [
  'bitcoin era', 'bitcoin profit', 'bitcoin code', 'bitcoin revolution',
  'immediate edge', 'immediate alpha', 'immediate connect', 'quantum ai',
  'oil profit', 'crypto engine', 'bit gpt', 'bitgpt',
];

// ---------------------------------------------------------------------------
// Intermediary host lists (used by isIntermediaryHost / the web resolver).
// A "final host" matching any of these is NOT the advertiser destination.
// ---------------------------------------------------------------------------

/** Affiliate trackers / smartlink redirectors / MMP click domains. */
const TRACKER_HOSTS = [
  // MMP / app trackers (mirror classifier.MMP_TRACKER_DOMAINS)
  'onelink.me', 'app.link', 'bnc.lt', 'adj.st', 'sng.link', 'singular.link',
  'tenjin.io', 'kochava.com', 'appsflyer.com',
  // Web affiliate trackers / smartlink platforms
  'go2cloud.org', 'affise.com', 'voluum.com', 'voluumtrk.com', 'everflow.io',
  'eflow.team', 'scaleo.io', 'trackier.com', 'trackier.io', 'hasoffers.com',
  'tune.com', 'cake.com', 'lospollos.com', 'lospollos.io', 'redtrack.io',
  'binom.org', 'keitaro.io', 'adsbridge.com', 'thrivetracker.com',
  'clickserve.com', 'go.clickbank.net', 'hop.clickbank.net',
];

/** First-label patterns that mark a tracker subdomain (host must have >=3 labels). */
const TRACKER_PREFIXES = [
  'go', 'track', 'tracking', 'click', 'clicks', 'clk', 'trk', 'redirect',
  'out', 'lnk', 'smartlink', 'offer', 'offers', 'pixel', 'srv', 'serve',
];

/** URL shorteners. */
const SHORTENER_HOSTS = [
  'bit.ly', 'cutt.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 'lnkd.in', 'tiny.cc',
];

/** Landing-page builders / quiz-funnel hosts. */
const LP_BUILDER_HOSTS = [
  'unbounce.com', 'instapage.com', 'leadpages.co', 'leadpages.net',
  'clickfunnels.com', 'typeform.com', 'getresponse.com', 'systeme.io',
  'carrd.co', 'lpages.co', 'pagewiz.com', 'landerlab.io', 'convertri.com',
  'gr8.com',
];

/** Affplus-internal / its image + sister sites. */
const AFFPLUS_INTERNAL_HOSTS = [
  'affplus.com', 'apimg.net', 'apimg.io', 'affpaying.com', 'affdaily.com',
];

/**
 * Network-name → funnel domain, for the big networks whose funnel domain is
 * not obvious from the brand name. Networks whose domain matches their brand
 * (crakrevenue.com, maxbounty.com, ...) are caught by the generic heuristic
 * in isIntermediaryHost and need no entry here. Best-effort accelerator.
 */
const NETWORK_DOMAINS: Record<string, string[]> = {
  cpamatica: ['cpamatica.io', 'cpamatica.com'],
  mylead: ['mylead.global', 'mylead.eu', 'lead.network'],
  trafficlight: ['cpa.tl'],
  '1winpartners': ['1win.com', '1winpartners.com', '1wpartners.com'],
  acepartners: ['acepartners.io', 'ace-partners.io'],
  leadbit: ['leadbit.com', 'lbsg.net'],
  kmabiz: ['kma.biz'],
  drcash: ['dr.cash', 'welcomekod.com'],
  zeydoo: ['zeydoo.com'],
  adcombo: ['adcombo.com', 'trafficcompany.com'],
  paysale: ['paysale.com'],
  algoaffiliates: ['algo-affiliates.com'],
  terraleads: ['terraleads.com'],
  mobidea: ['mobidea.com'],
  propellerads: ['propellerads.com'],
  maxbounty: ['maxbounty.com'],
  clickdealer: ['clickdealer.com'],
  adsmain: ['adsmain.com', 'publisher.adsmain.com'],
  adsempire: ['adsempire.com'],
  guru: ['guruleads.io', 'gurumedia.io'],
  golden: ['goldengoose.media', 'ggoose.media'],
  webvork: ['webvork.com'],
  shakespro: ['shakes.pro'],
  admitad: ['admitad.com', 'go.admitad.com'],
};

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `kw` appears in `text` (already lowercased by the caller) with
 * alnum boundaries on both sides. Punctuation/spaces inside the keyword are
 * matched literally, so "win a" and "1000%" work; "cure" does not match
 * "secure" / "manicure".
 */
function containsKeyword(lowerText: string, kw: string): boolean {
  const re = new RegExp(`(?<![a-z0-9])${escapeRegex(kw)}(?![a-z0-9])`, 'i');
  return re.test(lowerText);
}

function matchesAny(text: string | null | undefined, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const kw of keywords) if (containsKeyword(lower, kw)) return true;
  return false;
}

function normalizeNetwork(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Crude registrable (second-level) label of a hostname. */
function registrableLabel(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || '';
}

function hostEndsWithAny(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => h === s || h.endsWith('.' + s));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide keep / screen / drop from an offer's vertical tags + CATEGORY string.
 * `category` may be empty (search-card stage, before the detail-page fetch).
 */
export function verticalDecision(verticals: string[], category = ''): VerticalDecision {
  const corpus = `${verticals.join(' ')} ${category}`;
  if (matchesAny(corpus, HARD_BLOCK_KW)) return 'block';
  if (matchesAny(corpus, SCREEN_KW)) return 'screen';
  if (matchesAny(corpus, FLIPPABLE_BLOCK_KW)) return ALLOW_FLIPPABLE ? 'screen' : 'block';
  if (matchesAny(corpus, ALLOW_CLEAN_KW)) return 'allow';
  return DEFAULT_DECISION;
}

/**
 * True if the combined text shows scam-language. Feed it as much as you have:
 * offer name, CATEGORY, DESCRIPTION, and any creative text.
 */
export function looksScammy(text: string | null | undefined): boolean {
  if (!text) return false;
  return matchesAny(text, SCAM_KEYWORDS) || matchesAny(text, SCAM_BRAND_FRAGMENTS);
}

/**
 * True if `host` is an intermediary (network funnel / tracker / shortener /
 * LP builder / affplus-internal) rather than the advertiser destination.
 * `offerNetwork` is the network name from the offer card (used for the
 * own-network-domain check).
 */
export function isIntermediaryHost(host: string | null | undefined, offerNetwork = ''): boolean {
  if (!host) return true; // no host == dead end, treat as intermediary/drop
  const h = host.toLowerCase().replace(/^www\./, '');

  if (hostEndsWithAny(h, AFFPLUS_INTERNAL_HOSTS)) return true;
  if (hostEndsWithAny(h, TRACKER_HOSTS)) return true;
  if (hostEndsWithAny(h, SHORTENER_HOSTS)) return true;
  if (hostEndsWithAny(h, LP_BUILDER_HOSTS)) return true;

  // Explicit network-domain map.
  const nn = normalizeNetwork(offerNetwork);
  if (nn && NETWORK_DOMAINS[nn] && hostEndsWithAny(h, NETWORK_DOMAINS[nn])) return true;

  // Generic own-network heuristic: the host's registrable label appears inside
  // the (normalized) network name, e.g. network "AdsMain" vs publisher.adsmain.com.
  const reg = registrableLabel(h).replace(/[^a-z0-9]/g, '');
  if (nn && reg.length >= 4 && (nn.includes(reg) || reg.includes(nn))) return true;

  // Tracker subdomain prefix (only for true subdomains, host has >=3 labels).
  const labels = h.split('.').filter(Boolean);
  if (labels.length >= 3 && TRACKER_PREFIXES.includes(labels[0])) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Self-tests (mirror storeResolver.runVerifyMatchTests / nameCleaner)
// ---------------------------------------------------------------------------

interface VerticalCase { verticals: string[]; category?: string; expect: VerticalDecision; desc?: string; }
interface ScamCase { text: string; expect: boolean; desc?: string; }
interface InterCase { host: string; network?: string; expect: boolean; desc?: string; }

const VERTICAL_TESTS: VerticalCase[] = [
  { verticals: ['Adult'], expect: 'block', desc: 'adult tag' },
  { verticals: ['Dating', 'Mobile', 'SOI'], expect: 'block', desc: 'dating tag' },
  { verticals: ['Cam', 'CPL'], expect: 'block', desc: 'cam tag' },
  { verticals: ['Nutra'], expect: 'block', desc: 'nutra tag' },
  { verticals: ['Crypto'], expect: 'screen', desc: 'crypto -> screen' },
  { verticals: ['Forex'], expect: 'screen', desc: 'forex -> screen' },
  { verticals: ['Forex', 'BizOpp'], expect: 'block', desc: 'hard-block (BizOpp) beats screen (Forex)' },
  { verticals: ['Casino', 'Gambling', 'Betting', 'RevShare'], expect: 'screen', desc: 'casino presence beats betting block' },
  { verticals: ['Betting', 'RevShare'], expect: 'block', desc: 'pure betting -> flippable block' },
  { verticals: ['Gambling'], expect: 'block', desc: 'bare gambling -> flippable block' },
  { verticals: ['Ecommerce', 'Beauty', 'CPS'], expect: 'allow', desc: 'clean ecommerce' },
  { verticals: ['Insurance', 'Auto', 'CPS', 'Incent'], expect: 'allow', desc: 'auto insurance CPS' },
  { verticals: ['CPS'], expect: 'allow', desc: 'payout-only tag -> default allow' },
  { verticals: [], category: 'Browser Extensions / Can be Incentivized / Desktop / Mac OS / Windows', expect: 'allow', desc: 'no vertical signal -> default allow (downstream gates filter)' },
  { verticals: ['Mobile', 'Android'], category: 'Dating - Casual', expect: 'block', desc: 'category carries the dating signal' },
  { verticals: ['Binary', 'Trading'], expect: 'block', desc: 'binary options blocked even with trading' },
];

const SCAM_TESTS: ScamCase[] = [
  { text: 'Buff SOI [US,UK] Windows — WIN A PS5! 3 consoles up for grabs, JOIN THE PS5 RAFFLE', expect: true, desc: 'Buff PS5 raffle (canonical regression)' },
  { text: 'MoneyMutual.com US CPS Non Incent', expect: false, desc: 'real lending marketplace' },
  { text: 'New Auto Insurance US CPS Non Incent', expect: false, desc: 'auto insurance' },
  { text: 'Godlike.Host [CPS] WW', expect: false, desc: 'web hosting' },
  { text: 'Acredit RO CPA', expect: false, desc: 'mainstream finance' },
  { text: 'Prize Stash - Amazon $1,000', expect: true, desc: 'prize bait' },
  { text: 'Bitcoin Profit ES', expect: true, desc: 'scam brand family' },
  { text: 'Immediate Alpha Norwegian Smart Links - Guaranteed APY 1000%', expect: true, desc: 'scam brand + impossible returns' },
  { text: 'Earn passive income with our secret method, get rich fast', expect: true, desc: 'urgency + impossible returns' },
  { text: 'Free iPhone giveaway, spin to win!', expect: true, desc: 'prize/lottery bait' },
  { text: 'Secure checkout for premium cosmetics', expect: false, desc: '"cure" must not match "secure"' },
];

const INTER_TESTS: InterCase[] = [
  { host: 'paysale.com', network: 'Paysale', expect: true, desc: 'own network domain (map)' },
  { host: 'publisher.adsmain.com', network: 'AdsMain', expect: true, desc: 'network funnel (map + heuristic)' },
  { host: 'tracker.algo-affiliates.com', network: 'Algo-Affiliates', expect: true, desc: 'network subdomain via heuristic' },
  { host: 'go2cloud.org', network: 'X', expect: true, desc: 'tracker' },
  { host: 'track.somecpa.com', network: 'X', expect: true, desc: 'tracker subdomain prefix' },
  { host: 'bit.ly', network: 'X', expect: true, desc: 'shortener' },
  { host: 'unbounce.com', network: 'X', expect: true, desc: 'LP builder' },
  { host: 'clickfunnels.com', network: 'X', expect: true, desc: 'LP builder' },
  { host: 'www.affplus.com', network: 'X', expect: true, desc: 'affplus internal' },
  { host: 'apimg.io', network: 'X', expect: true, desc: 'affplus image cdn' },
  { host: 'moneymutual.com', network: 'WhaaatAds', expect: false, desc: 'real advertiser' },
  { host: 'godlike.host', network: 'Admitad', expect: false, desc: 'real advertiser' },
  { host: 'nike.com', network: 'X', expect: false, desc: 'real advertiser' },
  { host: 'go.com', network: 'X', expect: false, desc: '2-label host, "go" is registrable not a tracker subdomain' },
];

export function runWebPolicyTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  for (const tc of VERTICAL_TESTS) {
    const got = verticalDecision(tc.verticals, tc.category || '');
    if (got === tc.expect) passed++;
    else failures.push(`FAIL verticalDecision(${JSON.stringify(tc.verticals)}, ${JSON.stringify(tc.category || '')}) -> ${got} (expected ${tc.expect})${tc.desc ? ` [${tc.desc}]` : ''}`);
  }
  for (const tc of SCAM_TESTS) {
    const got = looksScammy(tc.text);
    if (got === tc.expect) passed++;
    else failures.push(`FAIL looksScammy(${JSON.stringify(tc.text)}) -> ${got} (expected ${tc.expect})${tc.desc ? ` [${tc.desc}]` : ''}`);
  }
  for (const tc of INTER_TESTS) {
    const got = isIntermediaryHost(tc.host, tc.network || '');
    if (got === tc.expect) passed++;
    else failures.push(`FAIL isIntermediaryHost(${JSON.stringify(tc.host)}, ${JSON.stringify(tc.network || '')}) -> ${got} (expected ${tc.expect})${tc.desc ? ` [${tc.desc}]` : ''}`);
  }

  return { passed, failed: failures.length, failures };
}

// Script entry point (mirror storeResolver.ts / nameCleaner.ts).
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('webPolicy.js') || process.argv[1].endsWith('webPolicy.ts'));
if (isMain) {
  const { passed, failed, failures } = runWebPolicyTests();
  console.log(`webPolicy: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
