/**
 * Publisher scoring (spec step 11), 0..100.
 *
 * Two profiles by whether the publisher is charted:
 *   CHARTED: bestRank(25, scaled) + 2-countries(15) + 2-charted-apps(10) +
 *            both-stores(10) + GATC-ads(25, scaled) + Meta-ads(15, scaled).
 *   TAIL-ONLY: GATC-ads(40, scaled) + Meta-ads(20, scaled) +
 *              install-band-midpoint-proximity(20) + portfolio-2+(10) +
 *              updated-within-90d(10).
 * NON_GAME_BONUS is added when the publisher is not a game publisher; the total is
 * clamped to 100.
 *
 * The scoring function is PURE (all inputs passed in) so it is unit-testable with
 * no DB; scoreAllPublishers() pulls the rows + per-publisher app signals and
 * writes the result back with setPublisherScore().
 */

import {
  CHARTED_WEIGHTS,
  TAIL_WEIGHTS,
  NON_GAME_BONUS,
  FRESH_UPDATE_DAYS,
  GATC_ADS_SATURATION,
  META_ADS_SATURATION,
  BEST_RANK_SATURATION,
  TAIL_MIN_INSTALLS,
  TAIL_MAX_INSTALLS,
} from './storeDiscoveryConfig.js';
import { listPublishersByScore, setPublisherScore, type PublisherRow } from './storeDiscoveryDb.js';
import { allPublisherAppSignals } from './publisherRollup.js';

export type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Scaled saturation helper: value/saturation, clamped to [0,1]. */
function scaled(value: number | null | undefined, saturation: number): number {
  if (!value || value <= 0) return 0;
  return clamp01(value / saturation);
}

/** bestRank → [0,1]: rank 1 = 1.0, decaying linearly to 0 at BEST_RANK_SATURATION. */
export function rankFraction(bestRank: number | null | undefined): number {
  if (bestRank == null || bestRank < 1) return 0;
  return clamp01((BEST_RANK_SATURATION - (bestRank - 1)) / BEST_RANK_SATURATION);
}

/** Install-band midpoint proximity on a log scale → [0,1]. Geometric midpoint of
 *  [TAIL_MIN, TAIL_MAX] scores 1; the band edges score 0; outside the band → 0. */
export function installBandProximity(installs: number | null | undefined): number {
  if (installs == null || installs < TAIL_MIN_INSTALLS || installs > TAIL_MAX_INSTALLS) return 0;
  const lMin = Math.log(TAIL_MIN_INSTALLS);
  const lMax = Math.log(TAIL_MAX_INSTALLS);
  const lMid = (lMin + lMax) / 2;
  const half = (lMax - lMin) / 2;
  if (half <= 0) return 1;
  return clamp01(1 - Math.abs(Math.log(installs) - lMid) / half);
}

export interface ScoreInput {
  is_charted: boolean;
  best_rank: number | null;
  countries_charted_count: number;
  charted_app_count: number;
  both_stores: boolean;
  gatc_ads_count: number | null;
  meta_active_ads: number | null;
  app_count: number;
  is_game_publisher: boolean;
  /** Tail-only: the publisher's in-band install closest to the band midpoint. */
  representative_installs: number | null;
  /** Tail-only: most-recent portfolio store-update, ms epoch. */
  latest_update: number | null;
  /** "now" for the fresh-update window (ms). Injected for deterministic tests. */
  now: number;
}

/** Pure score (0..100). */
export function scorePublisher(inp: ScoreInput): number {
  let score = 0;
  if (inp.is_charted) {
    score += CHARTED_WEIGHTS.bestRank * rankFraction(inp.best_rank);
    score += inp.countries_charted_count >= 2 ? CHARTED_WEIGHTS.multiCountry : 0;
    score += inp.charted_app_count >= 2 ? CHARTED_WEIGHTS.multiApp : 0;
    score += inp.both_stores ? CHARTED_WEIGHTS.bothStores : 0;
    score += CHARTED_WEIGHTS.gatcAds * scaled(inp.gatc_ads_count, GATC_ADS_SATURATION);
    score += CHARTED_WEIGHTS.metaAds * scaled(inp.meta_active_ads, META_ADS_SATURATION);
  } else {
    score += TAIL_WEIGHTS.gatcAds * scaled(inp.gatc_ads_count, GATC_ADS_SATURATION);
    score += TAIL_WEIGHTS.metaAds * scaled(inp.meta_active_ads, META_ADS_SATURATION);
    score += TAIL_WEIGHTS.installBand * installBandProximity(inp.representative_installs);
    score += inp.app_count >= 2 ? TAIL_WEIGHTS.portfolio : 0;
    const freshMs = FRESH_UPDATE_DAYS * 24 * 60 * 60 * 1000;
    const fresh = inp.latest_update != null && inp.now - inp.latest_update <= freshMs;
    score += fresh ? TAIL_WEIGHTS.freshUpdate : 0;
  }
  if (!inp.is_game_publisher) score += NON_GAME_BONUS;
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Pick the in-band install closest to the band midpoint (for tail proximity). */
function bestBandInstall(installs: number[]): number | null {
  const lMid = (Math.log(TAIL_MIN_INSTALLS) + Math.log(TAIL_MAX_INSTALLS)) / 2;
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const m of installs) {
    if (m < TAIL_MIN_INSTALLS || m > TAIL_MAX_INSTALLS) continue;
    const dist = Math.abs(Math.log(m) - lMid);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return best;
}

/** Score every publisher and persist. Returns count scored. `now` defaults to the
 *  wall clock; callers may pass a fixed value in tests. */
export function scoreAllPublishers(onLog?: LogFn, now: number = Date.now()): number {
  const publishers = listPublishersByScore(1_000_000);
  // One pass for the whole table: signals are resolved per PUBLISHER (over its full
  // merged portfolio), so they cannot be derived from a publishers row alone.
  const signals = allPublisherAppSignals();
  let n = 0;
  for (const p of publishers) {
    const score = scorePublisher(toScoreInput(p, now, signals.get(p.id)));
    setPublisherScore(p.id, score);
    n++;
  }
  onLog?.('info', `scoring: ${n} publishers scored`);
  return n;
}

function toScoreInput(
  p: PublisherRow,
  now: number,
  sig?: { installs: number[]; latestUpdate: number | null },
): ScoreInput {
  let representative: number | null = null;
  let latestUpdate: number | null = null;
  if (p.is_charted === 0) {
    // Only the tail profile uses per-app signals; charted publishers score on rank.
    representative = bestBandInstall(sig?.installs ?? []);
    latestUpdate = sig?.latestUpdate ?? null;
  }
  let countries = 0;
  try {
    countries = Array.isArray(JSON.parse(p.countries_charted)) ? JSON.parse(p.countries_charted).length : 0;
  } catch {
    countries = 0;
  }
  return {
    is_charted: p.is_charted === 1,
    best_rank: p.best_rank,
    countries_charted_count: countries,
    charted_app_count: p.charted_app_count,
    both_stores: p.both_stores === 1,
    gatc_ads_count: p.gatc_ads_count,
    meta_active_ads: p.meta_active_ads,
    app_count: p.app_count,
    is_game_publisher: p.is_game_publisher === 1,
    representative_installs: representative,
    latest_update: latestUpdate,
    now,
  };
}

// ── offline unit tests ───────────────────────────────────────────────────────

export function runPublisherScoreTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  const base: ScoreInput = {
    is_charted: true, best_rank: 1, countries_charted_count: 3, charted_app_count: 3,
    both_stores: true, gatc_ads_count: GATC_ADS_SATURATION, meta_active_ads: META_ADS_SATURATION,
    app_count: 5, is_game_publisher: true, representative_installs: null, latest_update: null, now: 1_000_000_000_000,
  };
  // Fully-maxed charted publisher → 100.
  check(scorePublisher(base) === 100, `charted max → 100 (got ${scorePublisher(base)})`);
  // rankFraction monotonic
  check(rankFraction(1) === 1, 'rankFraction: rank 1 = 1');
  check(rankFraction(BEST_RANK_SATURATION + 5) === 0, 'rankFraction: beyond saturation = 0');
  check(rankFraction(1) > rankFraction(50) && rankFraction(50) > rankFraction(150), 'rankFraction: strictly decreasing');
  // Charted with no ads loses the GATC+Meta 40 → 60.
  const noAds = { ...base, gatc_ads_count: 0, meta_active_ads: 0 };
  check(scorePublisher(noAds) === 60, `charted, no ads → 60 (got ${scorePublisher(noAds)})`);

  // Tail profile: install-band proximity + portfolio + fresh + gatc.
  const mid = Math.round(Math.sqrt(TAIL_MIN_INSTALLS * TAIL_MAX_INSTALLS));
  check(installBandProximity(mid) > 0.98, 'proximity: midpoint ≈ 1');
  check(installBandProximity(TAIL_MIN_INSTALLS) < 0.02, 'proximity: min edge ≈ 0');
  check(installBandProximity(TAIL_MAX_INSTALLS + 1) === 0, 'proximity: above band = 0');
  const tail: ScoreInput = {
    is_charted: false, best_rank: null, countries_charted_count: 0, charted_app_count: 0,
    both_stores: false, gatc_ads_count: GATC_ADS_SATURATION, meta_active_ads: 0,
    app_count: 3, is_game_publisher: true, representative_installs: mid, latest_update: base.now - 1000, now: base.now,
  };
  // gatc 40 + installBand 20 + portfolio 10 + fresh 10 = 80.
  check(scorePublisher(tail) === 80, `tail: gatc+band+portfolio+fresh → 80 (got ${scorePublisher(tail)})`);
  const stale = { ...tail, latest_update: base.now - (FRESH_UPDATE_DAYS + 1) * 86_400_000 };
  check(scorePublisher(stale) === 70, `tail: stale update drops fresh 10 → 70 (got ${scorePublisher(stale)})`);

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('publisherScore.js') || process.argv[1].endsWith('publisherScore.ts'));
if (isMain) {
  const { passed, failed, failures } = runPublisherScoreTests();
  console.log(`publisherScore tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
