/**
 * LLM daily spend cap, ledger, and Jerusalem-day reset.
 *
 * One global pool shared across all jobs and users. Every LLM call records its
 * exact USD cost into the `llm_spend` table (created in db.ts initDb), tagged
 * with the Asia/Jerusalem calendar day it landed on. Before each call, the
 * pipeline gate sums today's Jerusalem spend; at or above the cap it throws a
 * BudgetExceededError, which the job pipelines convert into a deferral to the
 * next Jerusalem midnight rather than a failure.
 *
 * The cap defaults to $100 and reads LLM_DAILY_CAP_USD when set.
 *
 * Pricing is verified for claude-sonnet-4-5: $3 / $15 per MTok (input / output),
 * $3.75 / $0.30 per MTok (5-minute cache write / cache read), and the web_search
 * server tool at $10 per 1,000 searches ($0.01 each). Unknown models fall back
 * to the sonnet rate so a model swap never silently bills as free.
 */

import { getDb } from './db.js';
import { log } from './logger.js';

/** Global daily cap in USD. Override with LLM_DAILY_CAP_USD. */
export const DAILY_CAP_USD: number = (() => {
  const v = Number(process.env.LLM_DAILY_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 100;
})();

/** Thrown by the budget gate. Pipelines catch this to defer (not fail) the job. */
export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly capUsd: number;
  constructor(spentUsd: number, capUsd: number) {
    super(
      `LLM daily cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent today (Asia/Jerusalem)`,
    );
    this.name = 'BudgetExceededError';
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

// ── Pricing (USD per million tokens) ───────────────────────────────────────

interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheRead: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 },
};
const DEFAULT_PRICE: ModelPrice = PRICES['claude-sonnet-4-5'];

/** $10 per 1,000 web searches. */
const WEB_SEARCH_USD_PER_CALL = 0.01;

function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? DEFAULT_PRICE;
}

/** Structural subset of the Anthropic Messages `usage` object. */
export interface LlmUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** Exact USD cost of one call from its usage object. */
export function costUsd(model: string, usage: LlmUsage | null | undefined): number {
  const p = priceFor(model);
  const u = usage ?? {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const webSearches = u.server_tool_use?.web_search_requests || 0;
  const tokenUsd =
    (inTok * p.input + outTok * p.output + cacheWrite * p.cacheWrite5m + cacheRead * p.cacheRead) /
    1_000_000;
  return tokenUsd + webSearches * WEB_SEARCH_USD_PER_CALL;
}

// ── Jerusalem calendar day (DST-safe via Intl) ─────────────────────────────

// en-CA formats as YYYY-MM-DD, which sorts lexically and matches the spend_day column.
const JERU_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Asia/Jerusalem calendar day as 'YYYY-MM-DD'. */
export function jerusalemDay(at: Date = new Date()): string {
  return JERU_DAY_FMT.format(at);
}

/**
 * Epoch ms of the first instant of the next Asia/Jerusalem calendar day.
 * Uses the formatter as ground truth, so DST transitions are handled without a
 * timezone library. Resolved to the nearest minute, which is the resume
 * granularity the deferral needs.
 */
export function nextJerusalemMidnightMs(from: Date = new Date()): number {
  const today = jerusalemDay(from);
  const step = 15 * 60 * 1000;
  const limit = from.getTime() + 26 * 60 * 60 * 1000;
  let t = from.getTime();
  while (t < limit) {
    t += step;
    if (jerusalemDay(new Date(t)) !== today) {
      // Crossed the boundary somewhere in (t - step, t]; refine to the minute.
      let lo = t - step;
      let hi = t;
      while (hi - lo > 60 * 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if (jerusalemDay(new Date(mid)) === today) lo = mid;
        else hi = mid;
      }
      return hi;
    }
  }
  // Fallback: 24h out. Reached only if the formatter never rolls over, which
  // does not happen for a valid timezone.
  return from.getTime() + 24 * 60 * 60 * 1000;
}

// ── Ledger ─────────────────────────────────────────────────────────────────

/**
 * Record one call's cost. Never throws (a ledger write failure must not break a
 * resolved result). Returns the USD charged for logging by the caller.
 */
export function recordSpend(
  source: string,
  model: string,
  usage: LlmUsage | null | undefined,
): number {
  const usd = costUsd(model, usage);
  const u = usage ?? {};
  try {
    getDb()
      .prepare(
        `INSERT INTO llm_spend
           (ts, spend_day, source, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_searches, usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        jerusalemDay(),
        source,
        model,
        u.input_tokens || 0,
        u.output_tokens || 0,
        u.cache_creation_input_tokens || 0,
        u.cache_read_input_tokens || 0,
        u.server_tool_use?.web_search_requests || 0,
        usd,
      );
  } catch (err) {
    log.warn(`llm_spend insert failed (${source}): ${(err as Error).message}`);
  }
  log.debug(`[budget] ${source} +$${usd.toFixed(4)} (cap $${DAILY_CAP_USD}/day, Asia/Jerusalem)`);
  return usd;
}

/** Total USD spent on the current Asia/Jerusalem day. */
export function spentTodayUsd(): number {
  try {
    const row = getDb()
      .prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM llm_spend WHERE spend_day = ?`)
      .get(jerusalemDay()) as { total: number } | undefined;
    return row?.total || 0;
  } catch (err) {
    log.warn(`spentTodayUsd query failed: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Budget gate. Call immediately before an LLM request. Throws
 * BudgetExceededError when today's Jerusalem spend is at or above the cap.
 */
export function assertBudget(source: string): void {
  const spent = spentTodayUsd();
  if (spent >= DAILY_CAP_USD) {
    log.warn(
      `[budget] ${source}: daily cap reached ($${spent.toFixed(2)}/$${DAILY_CAP_USD}); deferring`,
    );
    throw new BudgetExceededError(spent, DAILY_CAP_USD);
  }
}
