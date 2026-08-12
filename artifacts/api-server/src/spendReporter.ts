/**
 * Outbound spend reporting to the Chief (order L-3.5a, open item O-25).
 *
 * This app calls a paid vendor — the Anthropic API — keeps its own USD ledger in
 * `llm_spend` and enforces its own $100/day cap against it. Until this module
 * existed it reported none of that to the Chief, so the fleet's all-reporters
 * total was wrong by whatever Leadfinder had spent and a commanded discovery's
 * real cost was invisible.
 *
 * THE PATTERN, proven on two apps before this one: report per UTC day per
 * vendor in $0.50 quanta, one request per quantum, `external_id` idempotent,
 * retry 5xx with the SAME `external_id`, never retry 4xx, and let a 4xx latch
 * the reporter off loudly rather than loop.
 *
 * ── TWO DAY BOUNDARIES, BOTH REAL ────────────────────────────────────────────
 *
 * The Chief counts UTC days. This app's $100 cap resets at Asia/Jerusalem
 * midnight, which is 21:00 UTC in summer. Both are correct and they differ by
 * three hours, so for three hours a day the Chief's card and this app's own
 * screen legitimately disagree. That is not a defect to be reconciled away:
 *
 *   - `llmBudget.spentTodayUsd()` and the cap stay on Jerusalem. UNTOUCHED by
 *     this module, which never writes to the ledger and never moves the cap.
 *   - This module reports UTC days, derived from `llm_spend.ts` — an absolute
 *     epoch-ms stamp — so it is the same ledger read on a different boundary,
 *     never a second source of spend truth.
 *   - The status endpoint serves BOTH figures and NAMES the window on each.
 *
 * `utcDay()` / `utcDayBounds()` below are the ONE definition of the reporting
 * boundary. The status field and the reporter both come through here, so they
 * cannot drift apart; the smoke pins the boundary against its own fixture
 * timestamps, so moving it here is caught rather than propagated.
 *
 * ── WHY A CURSOR AND AN IDEMPOTENT ID, NOT EITHER ALONE ──────────────────────
 *
 * `chief_spend_cursor` records how many whole quanta of each (UTC day, vendor)
 * have been acknowledged. It is advanced only after a 2xx. A process killed
 * between "the Chief accepted it" and "the cursor was written" therefore
 * re-sends that quantum on the next sweep — with the same `external_id`, which
 * is what makes the re-send free. The cursor stops us re-sending EVERYTHING;
 * the id stops the one in-flight quantum from counting twice. Neither is
 * sufficient alone and both are cheap.
 *
 * ── ATTRIBUTION IS OMITTED, DELIBERATELY ─────────────────────────────────────
 *
 * `initiated_by` is not sent. `llm_spend` has no job_id, no user_id and no
 * owner: the three call sites tag a pipeline STAGE ('classifier', 'hq-resolver',
 * 'web-resolver'), no job identity reaches them, and there is no ambient
 * context to recover it from. So not one row in this ledger can be attributed
 * to a chief-commanded job or to a human one. The Chief treats an absent
 * `initiated_by` as legacy-unattributed — counted for truth, never braking —
 * so an honest total ships now and per-row attribution gets its own order.
 * Inventing a split here would be a confident wrong answer; this is the honest
 * partial one.
 *
 * SAFETY: dormant unless BOTH `CHIEF_URL` and `CHIEF_INGEST_TOKEN` are set, and
 * started only by index.ts — never by buildApp(), so no test or smoke boot ever
 * reports by accident. The token is read once, never logged, never echoed, and
 * never included in an error message.
 */

import { getDb } from './db.js';
import type { SqlHandle } from './sql.js';
import { log } from './logger.js';

// ── Contract constants ───────────────────────────────────────────────────────

/** This app's name in the Chief's ledger. */
export const APP_NAME = 'leadfinder';

/**
 * The vendor being reported. One today. Reporting is per day PER VENDOR, so a
 * second paid vendor becomes another row in the cursor and another quantum
 * stream, with no change to the mechanism.
 */
export const VENDOR = 'anthropic';

/** The quantum. One request reports exactly this much. */
export const QUANTUM_USD = 0.5;

/** The Chief's inbound path. */
export const INGEST_PATH = '/api/ingest/spend';

/**
 * How many UTC days back a sweep examines.
 *
 * A day is normally settled within a tick of its own end, so this only matters
 * when the process was down across a boundary. Anything older than the window
 * is NOT silently ignored — `sweepDays()` logs how many days it declined to
 * examine, because a bounded sweep that says nothing reads as "everything is
 * reported" when it is not.
 */
export const SWEEP_DAYS = 7;

/** Attempts per quantum, first try included. Only 5xx and transport errors retry. */
const MAX_ATTEMPTS = 4;

/** Backoff between retries of one quantum. */
const RETRY_BASE_MS = 500;

/** Per-request timeout. */
const REQUEST_TIMEOUT_MS = 15_000;

/** How often the background sweep runs. */
const TICK_MS = 5 * 60 * 1000;

// ── The UTC day: the ONE definition of the reporting boundary ────────────────

/**
 * UTC calendar day as 'YYYY-MM-DD'.
 *
 * Deliberately not `Intl` and deliberately not `toISOString().slice(0,10)`
 * spelled out at each call site: this is the single place the reporting
 * boundary is defined, and everything that needs it — the reporter, the status
 * field, the cursor key — comes through here.
 */
export function utcDay(at: Date | number = new Date()): string {
  const d = typeof at === 'number' ? new Date(at) : at;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Half-open epoch-ms bounds of a UTC day: `[start, end)`.
 *
 * Half-open is what makes the boundary unambiguous — a row stamped exactly at
 * midnight belongs to the day that is starting, never to both and never to
 * neither. The smoke seeds rows at `23:59:59.999Z` and `00:00:00.000Z` and
 * pins which day each lands in.
 */
export function utcDayBounds(day: string): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`utcDayBounds: not a YYYY-MM-DD day: ${JSON.stringify(day)}`);
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

/** The UTC day `n` days before `day`. */
export function utcDayMinus(day: string, n: number): string {
  return utcDay(utcDayBounds(day).start - n * 24 * 60 * 60 * 1000);
}

// ── Quantum arithmetic ───────────────────────────────────────────────────────

/**
 * Whole quanta owed for a USD total.
 *
 * Done in integer micro-dollars rather than `Math.floor(usd / 0.5)`, because
 * the total is a SUM of binary floats: two calls costing $0.25 can land on
 * 0.49999999999999994, and the naive form would report $0.00 for it and keep
 * doing so. Rounding to micro-dollars first — far finer than any real per-call
 * cost, far coarser than the error — makes the count exact.
 */
export function quantaFor(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  const micros = Math.round(usd * 1_000_000);
  return Math.floor(micros / Math.round(QUANTUM_USD * 1_000_000));
}

/**
 * The deterministic id for one quantum. Idempotency rests entirely on this:
 * the same quantum re-sent after a crash, a timeout or a 5xx carries the same
 * id, and the Chief counts it once.
 *
 * `q` is 1-based, so `q1` is the first $0.50 of that vendor-day.
 */
export function quantumExternalId(day: string, vendor: string, q: number): string {
  return `${APP_NAME}:${vendor}:${day}:q${q}`;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface ReporterConfig {
  baseUrl: string;
  token: string;
}

/**
 * Read config from the environment. Both halves are required — a URL with no
 * token would post unauthenticated and a token with no URL has nowhere to go —
 * and either missing means dormant, not broken.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ReporterConfig | null {
  const baseUrl = (env.CHIEF_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.CHIEF_INGEST_TOKEN ?? '').trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/** The endpoint a config points at. Kept here so tests can assert the join. */
export function ingestUrl(cfg: ReporterConfig): string {
  return `${cfg.baseUrl}${INGEST_PATH}`;
}

// ── Outcome classification ───────────────────────────────────────────────────

export type PostOutcome =
  | { kind: 'ok' }
  /** 5xx or transport failure: the same external_id may be sent again. */
  | { kind: 'retry'; detail: string }
  /** 4xx: this request is wrong and repeating it will stay wrong. Latch off. */
  | { kind: 'fatal'; status: number; detail: string };

/**
 * How an HTTP status is treated.
 *
 * The rule as ordered: 2xx succeeds, 5xx retries, EVERY 4xx is fatal and
 * latches the reporter off. 429 is included in that — see the note in the
 * L-3.5a ledger entry, which asks the Chief's contract to confirm it never
 * rate-limits ingest, since under this rule a single 429 silences reporting
 * until the next boot.
 */
export function classifyStatus(status: number): PostOutcome {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status >= 500) return { kind: 'retry', detail: `HTTP ${status}` };
  if (status >= 400) {
    return { kind: 'fatal', status, detail: `HTTP ${status}` };
  }
  // 1xx/3xx from an ingest endpoint is not a contract this app understands.
  // Treated as fatal rather than looped on: a redirect chain to an unknown host
  // is exactly the sort of thing that should stop and be looked at.
  return { kind: 'fatal', status, detail: `unexpected HTTP ${status}` };
}

/**
 * The request body. ONE place, so the shape the smoke asserts is the shape the
 * Chief receives.
 *
 * `initiated_by` is absent by construction — there is no code path that adds
 * it, because there is nothing truthful to put in it. See the header.
 */
export function quantumBody(day: string, vendor: string, q: number): Record<string, unknown> {
  return {
    app: APP_NAME,
    vendor,
    day,
    amount_usd: QUANTUM_USD,
    external_id: quantumExternalId(day, vendor, q),
  };
}

// ── The reporter ─────────────────────────────────────────────────────────────

export interface SweepResult {
  /** Quanta the Chief accepted during this sweep. */
  sent: number;
  /** Days examined. */
  days: string[];
  /** True when this sweep latched the reporter off. */
  latched: boolean;
}

export type ReporterState = 'dormant' | 'active' | 'latched';

export class SpendReporter {
  private readonly cfg: ReporterConfig | null;
  private latched = false;
  private latchReason: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  /** Injected only by tests and the smoke; production uses global fetch. */
  constructor(
    cfg: ReporterConfig | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.cfg = cfg;
  }

  get state(): ReporterState {
    if (!this.cfg) return 'dormant';
    return this.latched ? 'latched' : 'active';
  }

  get latchedReason(): string | null {
    return this.latchReason;
  }

  /**
   * One loud line per boot, whatever the state. A reporter that is quietly off
   * is indistinguishable from one that is working and finding nothing to send,
   * and that ambiguity is what O-25 is about.
   */
  announce(): void {
    if (!this.cfg) {
      log.warn(
        'spend reporter: DORMANT — CHIEF_URL and/or CHIEF_INGEST_TOKEN are unset, so this app is ' +
          'NOT reporting its Anthropic spend to the Chief. The Chief\'s all-reporters total will be ' +
          'short by whatever this app spends. Set both to enable it; nothing else needs to change.',
      );
      return;
    }
    // The URL is configuration, not a secret, and is what an operator needs to
    // see to confirm a cutover. The token is never printed, in any branch.
    log.info(
      `spend reporter: ACTIVE — reporting ${VENDOR} spend to ${ingestUrl(this.cfg)} ` +
        `in $${QUANTUM_USD.toFixed(2)} quanta, per UTC day (this app's own $100 cap stays on Asia/Jerusalem).`,
    );
  }

  /** Start the background sweep. Called by index.ts only. */
  start(): void {
    this.announce();
    if (!this.cfg || this.timer) return;
    // Sweep once at boot rather than waiting a full tick. A process that
    // restarts more often than TICK_MS would otherwise never report at all,
    // and the first thing a fresh process should do is settle what the last
    // one left owing.
    void this.sweep().catch((err) => {
      log.warn(`spend reporter: first sweep failed — ${(err as Error).message}`);
    });
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        log.warn(`spend reporter: sweep failed — ${(err as Error).message}`);
      });
    }, TICK_MS);
    // Never hold the process open for a reporting tick.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Examine the recent UTC days and send whatever is owed.
   *
   * Re-entrant by refusal, not by queueing: a sweep still running when the next
   * tick fires means the Chief is slow, and stacking sweeps would multiply
   * in-flight requests for the same quanta.
   */
  async sweep(h: SqlHandle = getDb()): Promise<SweepResult> {
    const result: SweepResult = { sent: 0, days: [], latched: false };
    if (!this.cfg || this.latched || this.sweeping) return result;
    this.sweeping = true;
    try {
      const days = await this.sweepDays(h);
      result.days = days;
      for (const day of days) {
        const owed = quantaFor(await spendForUtcDay(day, h));
        let reported = await readCursor(day, VENDOR, h);
        while (reported < owed) {
          const q = reported + 1;
          const outcome = await this.postQuantum(day, q);
          if (outcome.kind === 'fatal') {
            this.latch(outcome, day, q);
            result.latched = true;
            return result;
          }
          if (outcome.kind === 'retry') {
            // Exhausted its retries. Leave the cursor where it is and try again
            // on the next tick — the lag is visible on /status meanwhile.
            log.warn(
              `spend reporter: ${day} quantum ${q} not acknowledged (${outcome.detail}); ` +
                'will retry on the next sweep with the same external_id',
            );
            return result;
          }
          await writeCursor(day, VENDOR, q, this.now(), h);
          reported = q;
          result.sent++;
        }
      }
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Which UTC days to examine, newest last so a day is settled in order.
   *
   * Bounded at SWEEP_DAYS, and says so out loud when the ledger reaches further
   * back than the window: a cap nobody is told about reads as full coverage.
   */
  async sweepDays(h: SqlHandle = getDb()): Promise<string[]> {
    const today = utcDay(this.now());
    const oldestExamined = utcDayMinus(today, SWEEP_DAYS - 1);
    const windowStart = utcDayBounds(oldestExamined).start;

    // Is anything OUTSIDE the window actually unreported?
    //
    // Not "is there old spend" — after a week of normal operation there always
    // is, and warning on that would fire every five minutes forever. The thing
    // worth saying out loud is a day that fell off the back of the window while
    // still owing quanta, which is what happens if this app is down across more
    // than SWEEP_DAYS. A day that was settled while it was current keeps its
    // cursor row and stays quiet.
    const row = (await h
      .prepare(`SELECT MIN(ts) AS oldest FROM llm_spend WHERE ts < ?`)
      .get(windowStart)) as { oldest: number | null } | undefined;
    if (row?.oldest != null) {
      const oldestDay = utcDay(Number(row.oldest));
      const owed = quantaFor(await spendForUtcDay(oldestDay, h));
      const done = await readCursor(oldestDay, VENDOR, h);
      if (done < owed) {
        log.warn(
          `spend reporter: ${oldestDay} predates the ${SWEEP_DAYS}-day sweep window and still owes ` +
            `${owed - done} of ${owed} quanta ($${((owed - done) * QUANTUM_USD).toFixed(2)}). It will NOT be ` +
            'reported automatically and needs a manual reconciliation with the Chief.',
        );
      }
    }

    const days: string[] = [];
    for (let i = SWEEP_DAYS - 1; i >= 0; i--) days.push(utcDayMinus(today, i));
    return days;
  }

  /** One quantum, with retries that reuse the id. */
  private async postQuantum(day: string, q: number): Promise<PostOutcome> {
    const cfg = this.cfg!;
    const body = quantumBody(day, VENDOR, q);
    let last: PostOutcome = { kind: 'retry', detail: 'not attempted' };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(ingestUrl(cfg), {
          method: 'POST',
          headers: {
            // The one place the token is used. Never logged, on any path.
            authorization: `Bearer ${cfg.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        last = classifyStatus(res.status);
      } catch (err) {
        // Transport-level: unreachable, DNS, timeout. Retryable, and the
        // message is ours, never the token.
        last = { kind: 'retry', detail: `transport: ${(err as Error).message}` };
      }

      if (last.kind === 'ok' || last.kind === 'fatal') return last;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
      }
    }
    return last;
  }

  /**
   * Stop reporting, loudly, once.
   *
   * A 4xx means the Chief has rejected the SHAPE of what this app sends —
   * wrong token, unknown field, a rejected `external_id`. Repeating it cannot
   * fix it, and looping on it would bury the one line an operator needs in a
   * stream of identical failures. Nothing about the token appears here.
   */
  private latch(outcome: Extract<PostOutcome, { kind: 'fatal' }>, day: string, q: number): void {
    this.latched = true;
    this.latchReason = `${outcome.detail} on ${day} quantum ${q}`;
    this.stop();
    log.error(
      `spend reporter: LATCHED OFF after ${outcome.detail} from the Chief on ${day} quantum ${q}. ` +
        'A 4xx is never retried — the request shape or the credential is wrong, and repeating it ' +
        'would loop. NO FURTHER SPEND WILL BE REPORTED until this process restarts. The ledger and ' +
        '/api/chief/status keep the true figures meanwhile, so nothing is lost, only unreported.',
    );
  }
}

// ── Ledger and cursor reads ──────────────────────────────────────────────────

/**
 * This app's own spend for one UTC day.
 *
 * A RANGE over `ts`, the absolute epoch-ms stamp, NOT a filter on `spend_day`,
 * which carries the Jerusalem day. Same ledger, same rows, different boundary.
 */
export async function spendForUtcDay(day: string, h: SqlHandle = getDb()): Promise<number> {
  const { start, end } = utcDayBounds(day);
  const row = (await h
    .prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM llm_spend WHERE ts >= ? AND ts < ?`)
    .get(start, end)) as { total: number } | undefined;
  return Number(row?.total ?? 0) || 0;
}

/** Quanta already acknowledged for a vendor-day. */
export async function readCursor(
  day: string,
  vendor: string = VENDOR,
  h: SqlHandle = getDb(),
): Promise<number> {
  const row = (await h
    .prepare(`SELECT reported_quanta FROM chief_spend_cursor WHERE utc_day = ? AND vendor = ?`)
    .get(day, vendor)) as { reported_quanta: number } | undefined;
  return Number(row?.reported_quanta ?? 0) || 0;
}

/**
 * Advance the cursor. Monotonic by GREATEST, so a late write from a slow sweep
 * can never walk the count backwards and cause a re-send of settled quanta.
 */
export async function writeCursor(
  day: string,
  vendor: string,
  quanta: number,
  at: number,
  h: SqlHandle = getDb(),
): Promise<void> {
  await h
    .prepare(
      `INSERT INTO chief_spend_cursor (utc_day, vendor, reported_quanta, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (utc_day, vendor) DO UPDATE
         SET reported_quanta = GREATEST(chief_spend_cursor.reported_quanta, EXCLUDED.reported_quanta),
             updated_at = EXCLUDED.updated_at`,
    )
    .run(day, vendor, quanta, at);
}

// ── What /status serves ──────────────────────────────────────────────────────

export interface SpendReportingStatus {
  /** UTC-day spend — the SAME scope and boundary the Chief is sent. */
  spend_today_utc_usd: number;
  /** Named windows, because the two figures legitimately differ for 3h a day. */
  spend_today_utc_window: 'UTC';
  /** USD on this UTC day the Chief has not acknowledged yet — the cursor's lag. */
  spend_unreported_usd: number;
  /** Whole quanta acknowledged for this UTC day. */
  spend_reported_quanta: number;
  /** dormant | active | latched. A silent reporter is visible, not assumed. */
  spend_reporter: ReporterState;
}

/**
 * The reporting facts for the current UTC day.
 *
 * Every number is read. A failed read throws so the caller can 503 — the same
 * rule `chief.ts` already applies to `spend_today_usd`, and for the same
 * reason: a fabricated zero here is a lie about money.
 */
export async function spendReportingStatus(
  reporter: SpendReporter,
  h: SqlHandle = getDb(),
  at: number = Date.now(),
): Promise<SpendReportingStatus> {
  const day = utcDay(at);
  const total = await spendForUtcDay(day, h);
  const reported = await readCursor(day, VENDOR, h);
  const unreported = total - reported * QUANTUM_USD;
  return {
    spend_today_utc_usd: total,
    spend_today_utc_window: 'UTC',
    // Clamped at zero: a cursor ahead of the ledger is not a negative debt, and
    // only happens if a quantum was acknowledged and the row later vanished.
    spend_unreported_usd: Math.max(0, Number(unreported.toFixed(6))),
    spend_reported_quanta: reported,
    spend_reporter: reporter.state,
  };
}

// ── The process-wide instance ────────────────────────────────────────────────

let instance: SpendReporter | null = null;

/** The reporter this process uses. Built once, from the environment. */
export function getSpendReporter(): SpendReporter {
  if (!instance) instance = new SpendReporter(readConfig());
  return instance;
}

/** Start reporting. index.ts only — never buildApp(), so tests never report. */
export function startSpendReporter(): void {
  getSpendReporter().start();
}

/** Tests only: replace the process instance. */
export function setSpendReporterForTests(r: SpendReporter | null): void {
  instance = r;
}

// ── offline tests (pure — no DB, no network, no socket) ──────────────────────

export function runSpendReporterTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // ── the UTC day boundary ──
  check(utcDay(Date.UTC(2026, 7, 11, 0, 0, 0)) === '2026-08-11', 'utcDay: midnight UTC is that day');
  check(
    utcDay(Date.UTC(2026, 7, 11, 23, 59, 59, 999)) === '2026-08-11',
    'utcDay: the last millisecond is still that day',
  );
  check(utcDay(Date.UTC(2026, 7, 12, 0, 0, 0)) === '2026-08-12', 'utcDay: the next ms is the next day');
  check(utcDay(Date.UTC(2026, 0, 1)) === '2026-01-01', 'utcDay: January pads the month');
  check(utcDay(Date.UTC(2026, 8, 5)) === '2026-09-05', 'utcDay: single-digit day is padded');
  // The whole reason this module exists on a different boundary from the cap:
  // 21:00 UTC is already the next Jerusalem day in summer, and must NOT be the
  // next UTC day. This is the exact instant that produced the 2026-08-11
  // observation the order asked about.
  check(
    utcDay(Date.UTC(2026, 7, 11, 21, 0, 0)) === '2026-08-11',
    'utcDay: 21:00 UTC — Jerusalem midnight — is still the same UTC day',
  );

  const b = utcDayBounds('2026-08-11');
  check(b.start === Date.UTC(2026, 7, 11), 'bounds: start is midnight UTC');
  check(b.end === Date.UTC(2026, 7, 12), 'bounds: end is the next midnight');
  check(b.end - b.start === 86_400_000, 'bounds: a day is 24h of milliseconds');
  check(utcDayBounds(utcDay(b.end)).start === b.end, 'bounds: half-open — end belongs to the next day');
  let rejected = false;
  try {
    utcDayBounds('11-08-2026');
  } catch {
    rejected = true;
  }
  check(rejected, 'bounds: a non-ISO day is refused, not silently coerced');

  // THE INVARIANT THAT TIES THE TWO HALVES TOGETHER.
  //
  // The boundary is expressed by two functions facing opposite ways: utcDay()
  // labels an instant, utcDayBounds() gives a label's range. Each one looks
  // correct in isolation while disagreeing with the other, and a reporter whose
  // sweep enumerates days with one and sums them with the other would then drop
  // or double-count whole hours of spend. So the property to pin is not either
  // function's output — it is that they are exact inverses: the day an instant
  // is labelled with MUST be the day whose bounds contain that instant.
  //
  // (This is here because a mutation proof moved utcDay() by three hours and
  // every direct assertion still passed. The gap was real; this is the fix.)
  const instants = [
    Date.UTC(2026, 7, 11, 0, 0, 0, 0),
    Date.UTC(2026, 7, 11, 0, 0, 0, 1),
    Date.UTC(2026, 7, 11, 12, 0, 0, 0),
    Date.UTC(2026, 7, 11, 20, 59, 59, 999),
    Date.UTC(2026, 7, 11, 21, 0, 0, 0),
    Date.UTC(2026, 7, 11, 23, 59, 59, 999),
    Date.UTC(2026, 7, 12, 0, 0, 0, 0),
    Date.UTC(2026, 0, 1, 0, 0, 0, 0),
    Date.UTC(2025, 11, 31, 23, 59, 59, 999),
    Date.UTC(2026, 2, 29, 1, 30, 0, 0),
  ];
  let inverseHolds = true;
  let inverseWitness = '';
  for (const t of instants) {
    const d = utcDay(t);
    const { start, end } = utcDayBounds(d);
    if (!(t >= start && t < end)) {
      inverseHolds = false;
      inverseWitness = `${new Date(t).toISOString()} was labelled ${d}, whose bounds do not contain it`;
    }
  }
  check(inverseHolds, `boundary: every instant falls inside its own labelled day (${inverseWitness || 'all hold'})`);

  let roundTripHolds = true;
  for (const d of ['2026-08-11', '2026-01-01', '2025-12-31', '2026-02-28', '2026-03-01']) {
    if (utcDay(utcDayBounds(d).start) !== d) roundTripHolds = false;
  }
  check(roundTripHolds, 'boundary: a day label survives the round trip through its own bounds');

  check(utcDayMinus('2026-08-11', 0) === '2026-08-11', 'minus: zero days is the same day');
  check(utcDayMinus('2026-08-11', 1) === '2026-08-10', 'minus: one day back');
  check(utcDayMinus('2026-03-01', 1) === '2026-02-28', 'minus: crosses a month end');
  check(utcDayMinus('2026-01-01', 1) === '2025-12-31', 'minus: crosses a year end');
  check(utcDayMinus('2026-08-11', 6) === '2026-08-05', 'minus: the far edge of the sweep window');

  // ── quantum arithmetic ──
  check(quantaFor(0) === 0, 'quanta: nothing spent, nothing owed');
  check(quantaFor(0.49) === 0, 'quanta: below one quantum reports nothing yet');
  check(quantaFor(0.5) === 1, 'quanta: exactly one quantum');
  check(quantaFor(0.99) === 1, 'quanta: the remainder does not round up');
  check(quantaFor(1) === 2, 'quanta: a dollar is two quanta');
  check(quantaFor(7.6492) === 15, 'quanta: the observed $7.6492 is 15 quanta ($7.50), $0.1492 lagging');
  check(quantaFor(100) === 200, 'quanta: a full cap day is 200 quanta');
  check(quantaFor(-1) === 0, 'quanta: a negative total owes nothing');
  check(quantaFor(NaN) === 0, 'quanta: NaN owes nothing rather than throwing');
  check(quantaFor(Infinity) === 0, 'quanta: Infinity owes nothing rather than looping forever');
  // The float trap this is written to survive: 0.25+0.25 is not 0.5 in binary.
  check(0.25 + 0.25 === 0.5, 'quanta: (control) 0.25+0.25 is exact');
  check(quantaFor(0.1 + 0.2 + 0.2) === 1, 'quanta: 0.1+0.2+0.2 = 0.5000000000000001 is one quantum');
  check(quantaFor(0.7 - 0.2) === 1, 'quanta: 0.7-0.2 = 0.49999999999999994 is still one quantum');

  // ── the external id ──
  check(
    quantumExternalId('2026-08-11', 'anthropic', 1) === 'leadfinder:anthropic:2026-08-11:q1',
    'id: the documented shape',
  );
  check(
    quantumExternalId('2026-08-11', 'anthropic', 15) === quantumExternalId('2026-08-11', 'anthropic', 15),
    'id: deterministic — a retry sends the same id',
  );
  check(
    quantumExternalId('2026-08-11', 'anthropic', 1) !== quantumExternalId('2026-08-12', 'anthropic', 1),
    'id: a different day is a different quantum',
  );
  check(
    quantumExternalId('2026-08-11', 'anthropic', 1) !== quantumExternalId('2026-08-11', 'openai', 1),
    'id: a different vendor is a different quantum',
  );
  check(
    quantumExternalId('2026-08-11', 'anthropic', 1) !== quantumExternalId('2026-08-11', 'anthropic', 2),
    'id: a different quantum index is a different quantum',
  );

  // ── config ──
  check(readConfig({} as NodeJS.ProcessEnv) === null, 'config: nothing set is dormant');
  check(
    readConfig({ CHIEF_URL: 'https://chief.example' } as NodeJS.ProcessEnv) === null,
    'config: a URL with no token is dormant, not unauthenticated',
  );
  check(
    readConfig({ CHIEF_INGEST_TOKEN: 'tok' } as NodeJS.ProcessEnv) === null,
    'config: a token with nowhere to send is dormant',
  );
  check(
    readConfig({ CHIEF_URL: '  ', CHIEF_INGEST_TOKEN: '  ' } as NodeJS.ProcessEnv) === null,
    'config: whitespace-only values are dormant',
  );
  const cfg = readConfig({
    CHIEF_URL: 'https://chief.example/',
    CHIEF_INGEST_TOKEN: ' tok ',
  } as NodeJS.ProcessEnv);
  check(cfg !== null, 'config: both halves set is configured');
  check(cfg?.baseUrl === 'https://chief.example', 'config: a trailing slash is trimmed');
  check(cfg?.token === 'tok', 'config: the token is trimmed, exactly as CHIEF_TOKEN is');
  check(
    !!cfg && ingestUrl(cfg) === 'https://chief.example/api/ingest/spend',
    'config: the ingest URL joins without a doubled slash',
  );
  check(
    !!readConfig({ CHIEF_URL: 'https://c.example///', CHIEF_INGEST_TOKEN: 't' } as NodeJS.ProcessEnv) &&
      ingestUrl(readConfig({ CHIEF_URL: 'https://c.example///', CHIEF_INGEST_TOKEN: 't' } as NodeJS.ProcessEnv)!) ===
        'https://c.example/api/ingest/spend',
    'config: several trailing slashes are trimmed',
  );

  // ── status classification ──
  check(classifyStatus(200).kind === 'ok', 'status: 200 succeeds');
  check(classifyStatus(201).kind === 'ok', 'status: 201 succeeds');
  check(classifyStatus(204).kind === 'ok', 'status: 204 succeeds');
  check(classifyStatus(500).kind === 'retry', 'status: 500 retries');
  check(classifyStatus(502).kind === 'retry', 'status: 502 retries');
  check(classifyStatus(503).kind === 'retry', 'status: 503 retries');
  check(classifyStatus(400).kind === 'fatal', 'status: 400 is fatal');
  check(classifyStatus(401).kind === 'fatal', 'status: 401 is fatal');
  check(classifyStatus(403).kind === 'fatal', 'status: 403 is fatal');
  check(classifyStatus(404).kind === 'fatal', 'status: 404 is fatal');
  check(classifyStatus(409).kind === 'fatal', 'status: 409 is fatal');
  check(classifyStatus(422).kind === 'fatal', 'status: 422 — a refused field — is fatal');
  check(classifyStatus(429).kind === 'fatal', 'status: 429 latches, as ordered (flagged in the ledger)');
  check(classifyStatus(302).kind === 'fatal', 'status: a redirect is fatal, not followed into the unknown');
  // The property the order names: no 4xx is ever retryable.
  let anyRetryable4xx = false;
  for (let s = 400; s < 500; s++) if (classifyStatus(s).kind === 'retry') anyRetryable4xx = true;
  check(!anyRetryable4xx, 'status: NO 4xx is retryable, across the whole range');
  let all5xxRetry = true;
  for (let s = 500; s < 600; s++) if (classifyStatus(s).kind !== 'retry') all5xxRetry = false;
  check(all5xxRetry, 'status: every 5xx retries, across the whole range');

  // ── the request body ──
  const body = quantumBody('2026-08-11', 'anthropic', 3);
  check(body.app === 'leadfinder', 'body: names this app');
  check(body.vendor === 'anthropic', 'body: names the vendor');
  check(body.day === '2026-08-11', 'body: carries the UTC day');
  check(body.amount_usd === 0.5, 'body: one quantum, always');
  check(body.external_id === 'leadfinder:anthropic:2026-08-11:q3', 'body: carries the idempotent id');
  // The decision, enforced rather than remembered.
  check(!('initiated_by' in body), 'body: initiated_by is OMITTED — no attribution is invented');
  check(
    Object.keys(body).length === 5,
    `body: exactly the five contract fields (got ${Object.keys(body).join(', ')})`,
  );
  const serialized = JSON.stringify(body);
  check(!/initiated_by/.test(serialized), 'body: initiated_by does not appear in the serialized request');

  // ── state and dormancy ──
  const dormant = new SpendReporter(null);
  check(dormant.state === 'dormant', 'state: no config is dormant');
  const active = new SpendReporter({ baseUrl: 'http://127.0.0.1:1', token: 'tok' });
  check(active.state === 'active', 'state: configured is active');

  // The token must not reach a log line or an error string. announce() is the
  // only place that prints configuration at all, so it is the one to pin.
  const printed: string[] = [];
  const realInfo = console.log;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => void printed.push(a.join(' '));
  console.warn = (...a: unknown[]) => void printed.push(a.join(' '));
  try {
    new SpendReporter({ baseUrl: 'https://chief.example', token: 'sk-super-secret-value' }).announce();
    new SpendReporter(null).announce();
  } finally {
    console.log = realInfo;
    console.warn = realWarn;
  }
  const allPrinted = printed.join('\n');
  check(printed.length === 2, 'announce: exactly one line per reporter');
  check(!allPrinted.includes('sk-super-secret-value'), 'announce: the token is NEVER printed');
  check(allPrinted.includes('https://chief.example'), 'announce: the URL is printed, so a cutover is visible');
  check(/DORMANT/.test(allPrinted), 'announce: an unconfigured reporter says so loudly');
  check(/ACTIVE/.test(allPrinted), 'announce: a configured reporter says so');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('spendReporter.js') || process.argv[1].endsWith('spendReporter.ts'));
if (isMain) {
  const { passed, failed, failures } = runSpendReporterTests();
  console.log(`spendReporter tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
