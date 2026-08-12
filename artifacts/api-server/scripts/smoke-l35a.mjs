#!/usr/bin/env node
/**
 * Order L-3.5a smoke — spend reporting, both modes, ephemeral clusters, runner
 * disabled, and NOTHING leaves this machine.
 *
 * WHAT IT PROVES
 *
 *   A. QUANTA FOR A DAY'S LEDGER. A seeded day of `llm_spend` is reported as
 *      exactly the whole $0.50 quanta it owes, one request each, in order, with
 *      the documented idempotent `external_id` on every one — and the sub-quantum
 *      remainder is left as visible lag rather than rounded away.
 *
 *   B. A RESTART REPORTS NOTHING TWICE. Across a REAL process boundary against
 *      the same database: the second process sweeps the same days and sends
 *      nothing, because the cursor says they are settled.
 *
 *   C. 5xx IS RETRIED WITH THE SAME external_id. The Chief refuses twice with
 *      503 and accepts on the third attempt; all three requests carry one id and
 *      the cursor advances exactly one quantum.
 *
 *   D. 4xx LATCHES THE REPORTER OFF, LOUDLY, ONCE. One error line, state
 *      `latched`, and no further request even though more quanta are owed.
 *
 *   E. AN OMITTED initiated_by, REFUSED. The Chief 422s any body without
 *      `initiated_by`. The reporter must latch off rather than retry and must
 *      NOT invent an attribution to get past it. (L-3.5a decision: the field is
 *      omitted; the real Chief must accept its absence as legacy-unattributed.)
 *
 *   F. DORMANT AND LOUD. With the config unset: exactly one warning line per
 *      boot, state `dormant`, and not one request attempted.
 *
 *   G. THE AGREEMENT TEST. `/api/chief/status`'s UTC figure equals the reported
 *      quanta plus the unreported lag, in the same scope and on the same day
 *      boundary — served identically in DARK and LIT. Pinned against the
 *      fixture's own literal timestamps, so moving the UTC day definition in
 *      `spendReporter.ts` breaks this rather than propagating silently.
 *
 *   H. THE JERUSALEM FIGURE IS UNTOUCHED. `spend_today_usd` still answers on the
 *      Asia/Jerusalem day and the cap still reads the same sum. The two windows
 *      are both named in the response.
 *
 * SAFETY: the "Chief" is a node:http server bound to 127.0.0.1 on an ephemeral
 * port, and every request the reporter makes is asserted to have gone there.
 * buildApp() never starts the queue and index.ts is never run, so no job runs,
 * nothing is scraped, no mail is sent and no vendor is called.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCluster, assertEphemeral } from './pgtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const SELF = fileURLToPath(import.meta.url);
const PREFIX = '/leadfinder';
const CHIEF_TOKEN = 'smoke-l35a-inbound-token-not-a-real-secret';
const INGEST_TOKEN = 'smoke-l35a-ingest-token-not-a-real-secret';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  failed++;
};
const check = (c, m) => (c ? ok(m) : bad(m));

// ── the fake Chief ───────────────────────────────────────────────────────────

/**
 * An ingest endpoint on loopback. `behaviour` decides each reply; every request
 * is recorded so the assertions read what was actually sent rather than what we
 * hoped was sent.
 */
async function startFakeChief(behaviour) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null */
      }
      const record = {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        raw,
        body,
      };
      seen.push(record);
      const reply = behaviour(record, seen.length);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? { ok: reply.status < 400 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    seen,
    url: `http://127.0.0.1:${srv.address().port}`,
    stop: () => new Promise((r) => srv.close(r)),
  };
}

/** Capture what a block logs, so "one loud line" is checkable. */
async function captureLogs(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => void lines.push(['log', a.join(' ')]);
  console.warn = (...a) => void lines.push(['warn', a.join(' ')]);
  console.error = (...a) => void lines.push(['error', a.join(' ')]);
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, real);
  }
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ── fixtures ─────────────────────────────────────────────────────────────────

// The observed day, rebuilt from its parts. $3.0000 in the morning and $4.6492
// in the final millisecond of the UTC day sum to the $7.6492 the Chief's card
// showed on 2026-08-11 — 15 whole quanta ($7.50) with $0.1492 left lagging.
const DAY_A = '2026-08-11';
const DAY_B = '2026-08-12';
const SEED = [
  { ts: Date.UTC(2026, 7, 11, 10, 0, 0, 0), usd: 3.0 },
  { ts: Date.UTC(2026, 7, 11, 23, 59, 59, 999), usd: 4.6492 },
  // The very first millisecond of the next UTC day. Belongs to DAY_B, and the
  // half-open bounds are what decide that.
  { ts: Date.UTC(2026, 7, 12, 0, 0, 0, 0), usd: 10.0 },
];
const DAY_A_USD = 7.6492;
const DAY_A_QUANTA = 15;
const DAY_A_LAG = 0.1492;
const DAY_B_QUANTA = 20;
/** Noon on DAY_B, so both seeded days sit inside the sweep window. */
const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);

async function seedLedger(db, llmBudget) {
  for (const row of SEED) {
    await db
      .getDb()
      .prepare(
        `INSERT INTO llm_spend
           (ts, spend_day, source, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_searches, usd)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
      )
      .run(row.ts, llmBudget.jerusalemDay(new Date(row.ts)), 'smoke', 'claude-sonnet-4-5', row.usd);
  }
}

// ── child ────────────────────────────────────────────────────────────────────

const phase = (process.argv.find((a) => a.startsWith('--phase=')) || '').slice(8);

if (phase) {
  assertEphemeral(process.env.DATABASE_URL);
  const db = await import(`${DIST}/db.js`);
  const llmBudget = await import(`${DIST}/llmBudget.js`);
  const sr = await import(`${DIST}/spendReporter.js`);
  const { closeDatabase } = await import(`${DIST}/sql.js`);
  await db.initDb();

  const cfg = (url) => ({ baseUrl: url, token: INGEST_TOKEN });
  const allSentTo127 = (seen) =>
    seen.every((r) => /^127\.0\.0\.1:\d+$/.test(r.host || '') && r.url === '/api/ingest/spend');

  // ── phase 1: seed, sweep, and prove A / C-adjacent ordering ──
  if (phase === 'first') {
    await seedLedger(db, llmBudget);

    const chief = await startFakeChief(() => ({ status: 202 }));
    const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => NOW);
    const result = await reporter.sweep();
    await chief.stop();

    const idsA = chief.seen
      .filter((r) => r.body?.day === DAY_A)
      .map((r) => r.body.external_id);
    const idsB = chief.seen
      .filter((r) => r.body?.day === DAY_B)
      .map((r) => r.body.external_id);

    check(allSentTo127(chief.seen), 'A: every request went to 127.0.0.1/api/ingest/spend — nothing left the machine');
    check(
      chief.seen.length === DAY_A_QUANTA + DAY_B_QUANTA,
      `A: one request per quantum (${DAY_A_QUANTA}+${DAY_B_QUANTA}=${DAY_A_QUANTA + DAY_B_QUANTA}, got ${chief.seen.length})`,
    );
    check(result.sent === DAY_A_QUANTA + DAY_B_QUANTA, 'A: the sweep reports what it sent');
    check(idsA.length === DAY_A_QUANTA, `A: ${DAY_A} owes ${DAY_A_QUANTA} quanta for $${DAY_A_USD}`);
    check(idsB.length === DAY_B_QUANTA, `A: ${DAY_B} owes ${DAY_B_QUANTA} quanta`);
    check(
      idsA.every((id, i) => id === `leadfinder:anthropic:${DAY_A}:q${i + 1}`),
      'A: quanta are numbered 1..n in order, with the documented id',
    );
    check(
      chief.seen.every((r) => r.body?.amount_usd === 0.5),
      'A: every request reports exactly one $0.50 quantum',
    );
    check(new Set(chief.seen.map((r) => r.body?.external_id)).size === chief.seen.length, 'A: every id is distinct');
    check(
      chief.seen.every((r) => r.authorization === `Bearer ${INGEST_TOKEN}`),
      'A: every request carries the ingest bearer token',
    );
    check(
      chief.seen.every((r) => r.contentType === 'application/json'),
      'A: every request is application/json',
    );

    // E, first half: the field really is absent on the wire.
    check(
      chief.seen.every((r) => !('initiated_by' in (r.body ?? {}))),
      'E: no request carries initiated_by — no attribution is invented',
    );
    check(
      chief.seen.every((r) => !/initiated_by/.test(r.raw)),
      'E: initiated_by does not appear in the raw request bytes either',
    );

    // The boundary, pinned against the fixture's own literals.
    check(
      await sr.spendForUtcDay(DAY_A) === DAY_A_USD,
      `G: the 23:59:59.999Z row lands in ${DAY_A} (UTC total $${DAY_A_USD})`,
    );
    check(
      await sr.spendForUtcDay(DAY_B) === 10,
      `G: the 00:00:00.000Z row lands in ${DAY_B}, not ${DAY_A} — half-open bounds`,
    );
    check(await sr.readCursor(DAY_A) === DAY_A_QUANTA, 'A: the cursor records what was acknowledged');

    // The boundary's two halves must be inverses over the ACTUAL fixture rows,
    // not only over the unit suite's literals: the day a ledger row is labelled
    // with has to be the day whose sum includes it. Moving the boundary in
    // either function alone breaks this.
    let inverse = true;
    for (const row of SEED) {
      const day = sr.utcDay(row.ts);
      const { start, end } = sr.utcDayBounds(day);
      if (!(row.ts >= start && row.ts < end)) inverse = false;
    }
    check(inverse, 'G: every seeded ledger row falls inside the bounds of the day it is labelled with');

    const status = await sr.spendReportingStatus(reporter, undefined, NOW);
    check(status.spend_today_utc_usd === 10, 'G: the status UTC figure is the ledger sum for the UTC day');
    check(status.spend_reported_quanta === DAY_B_QUANTA, 'G: the status reports quanta acknowledged');
    check(status.spend_unreported_usd === 0, 'G: a fully-settled day has no lag');
    check(status.spend_reporter === 'active', 'G: a configured reporter reads active');

    const lagStatus = await sr.spendReportingStatus(reporter, undefined, Date.UTC(2026, 7, 11, 12));
    check(
      Math.abs(lagStatus.spend_unreported_usd - DAY_A_LAG) < 1e-9,
      `A: the sub-quantum remainder is visible as $${DAY_A_LAG} of lag, not rounded away`,
    );
    check(
      Math.abs(
        lagStatus.spend_today_utc_usd - (lagStatus.spend_reported_quanta * 0.5 + lagStatus.spend_unreported_usd),
      ) < 1e-9,
      'G: AGREEMENT — the UTC figure equals reported quanta + lag, same scope, same boundary',
    );
  }

  // ── phase 2: a real second process against the same database ──
  if (phase === 'replay') {
    const chief = await startFakeChief(() => ({ status: 202 }));
    const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => NOW);
    const result = await reporter.sweep();
    await chief.stop();
    check(chief.seen.length === 0, `B: after a real restart the same days send nothing (got ${chief.seen.length})`);
    check(result.sent === 0, 'B: the sweep agrees it sent nothing');
    check(await sr.readCursor(DAY_A) === DAY_A_QUANTA, 'B: the cursor survived the process boundary');
    check(await sr.readCursor(DAY_B) === DAY_B_QUANTA, 'B: both days stayed settled');
  }

  // ── phase 3: 5xx, 4xx, the refused omission, and dormancy ──
  if (phase === 'failures') {
    await seedLedger(db, llmBudget);

    // Each block below needs the seeded days OWED again — the block before it
    // settles them. Clearing the cursor is the smallest way to rewind, and it
    // touches only this ephemeral cluster's bookkeeping, never the ledger.
    const rewindCursor = () => db.getDb().prepare(`DELETE FROM chief_spend_cursor`).run();

    // C — two 503s then acceptance, on the very first quantum.
    {
      const chief = await startFakeChief((_r, n) => ({ status: n <= 2 ? 503 : 202 }));
      const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => NOW);
      // Only DAY_A matters here; stop after it settles by cutting the sweep
      // short with a Chief that fails everything after the first quantum.
      const captured = await captureLogs(() => reporter.sweep());
      await chief.stop();
      const firstThree = chief.seen.slice(0, 3);
      check(firstThree.length === 3, 'C: the refused quantum was attempted three times');
      check(
        new Set(firstThree.map((r) => r.body?.external_id)).size === 1,
        'C: all three attempts carried the SAME external_id',
      );
      check(
        firstThree[0].body?.external_id === `leadfinder:anthropic:${DAY_A}:q1`,
        'C: and it is the first quantum of the day',
      );
      check(
        chief.seen.length === DAY_A_QUANTA + DAY_B_QUANTA + 2,
        `C: the two refusals cost two extra requests and no quantum was skipped ` +
          `(expected ${DAY_A_QUANTA + DAY_B_QUANTA + 2}, got ${chief.seen.length})`,
      );
      check(
        await sr.readCursor(DAY_A) === DAY_A_QUANTA,
        'C: the retried quantum advanced the cursor once, not twice',
      );
      check(
        captured.lines.every(([, text]) => !text.includes(INGEST_TOKEN)),
        'C: the ingest token appears in no log line, even on failure',
      );
    }

    // C2 — 429 is the one 4xx that RETRIES. Same bounded backoff as a 5xx, same
    // external_id, and it must never latch: a rate-limit reply that silenced
    // reporting until the next boot would reopen the exact blind spot O-25
    // closes. The Chief does not rate-limit ingest today and may later.
    {
      rewindCursor();
      const chief = await startFakeChief((_r, n) => ({ status: n <= 2 ? 429 : 202 }));
      const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => NOW);
      const captured = await captureLogs(() => reporter.sweep());
      await chief.stop();
      const firstThree = chief.seen.slice(0, 3);
      check(firstThree.length === 3, 'C2: a 429 is retried, not latched on');
      check(
        new Set(firstThree.map((r) => r.body?.external_id)).size === 1,
        'C2: every 429 retry carries the SAME external_id',
      );
      check(reporter.state === 'active', 'C2: the reporter is still active after a rate limit');
      check(
        captured.lines.filter(([lvl]) => lvl === 'error').length === 0,
        'C2: a rate limit is not an error — nothing latched',
      );
      check(
        chief.seen.length === DAY_A_QUANTA + DAY_B_QUANTA + 2,
        `C2: reporting completed in full after the rate limit cleared (got ${chief.seen.length})`,
      );
      check(await sr.readCursor(DAY_A) === DAY_A_QUANTA, 'C2: the rate-limited quantum settled exactly once');
      check(
        captured.lines.every(([, text]) => !text.includes(INGEST_TOKEN)),
        'C2: the token appears in no log line during a rate limit',
      );
    }

    // D — a 400 on the first quantum latches the reporter off with one line.
    {
      rewindCursor();
      const chief = await startFakeChief(() => ({ status: 400 }));
      const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => NOW);
      const captured = await captureLogs(() => reporter.sweep());
      await chief.stop();
      const errors = captured.lines.filter(([lvl]) => lvl === 'error');
      check(chief.seen.length === 1, `D: a 4xx is attempted ONCE, never retried (got ${chief.seen.length})`);
      check(reporter.state === 'latched', 'D: the reporter latched off');
      check(errors.length === 1, `D: exactly one loud line (got ${errors.length})`);
      check(/LATCHED OFF/.test(errors[0]?.[1] ?? ''), 'D: and it says so unmistakably');
      check(
        captured.lines.every(([, text]) => !text.includes(INGEST_TOKEN)),
        'D: the token is not echoed by the latch line',
      );
      check(captured.value.latched === true, 'D: the sweep result says it latched');

      // Still latched on the next sweep, with no new request.
      const chief2 = await startFakeChief(() => ({ status: 202 }));
      await reporter.sweep();
      await chief2.stop();
      check(chief2.seen.length === 0, 'D: a latched reporter sends nothing on later sweeps');
    }

    // E — a Chief that REFUSES the omitted field. The reporter must not retry
    // and must not invent an attribution to satisfy it.
    {
      rewindCursor();
      const chief = await startFakeChief((r) => {
        if (!r.body || !('initiated_by' in r.body)) {
          return { status: 422, body: { error: 'initiated_by is required' } };
        }
        return { status: 202 };
      });
      const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => NOW);
      const captured = await captureLogs(() => reporter.sweep());
      await chief.stop();
      check(chief.seen.length === 1, 'E: a Chief refusing the omission is attempted once, not looped on');
      check(reporter.state === 'latched', 'E: the reporter latches off rather than guessing an attribution');
      check(
        captured.lines.filter(([lvl]) => lvl === 'error').length === 1,
        'E: one loud line names the refusal',
      );
      check(
        chief.seen.every((r) => !('initiated_by' in (r.body ?? {}))),
        'E: it never retried WITH the field — no attribution was invented under pressure',
      );
    }

    // F — dormant and loud.
    {
      rewindCursor();
      const chief = await startFakeChief(() => ({ status: 202 }));
      const reporter = new sr.SpendReporter(null, fetch, () => NOW);
      const captured = await captureLogs(async () => {
        reporter.announce();
        return reporter.sweep();
      });
      await chief.stop();
      const warns = captured.lines.filter(([lvl]) => lvl === 'warn');
      check(reporter.state === 'dormant', 'F: no config reads dormant');
      check(warns.length === 1, `F: exactly one loud line per boot (got ${warns.length})`);
      check(/DORMANT/.test(warns[0]?.[1] ?? ''), 'F: and it says DORMANT');
      check(chief.seen.length === 0, 'F: a dormant reporter attempts no request at all');
      check(captured.value.sent === 0, 'F: and reports having sent nothing');
    }
  }

  // ── phase 3b: the adopt-path landmine this order would otherwise have hit ──
  //
  // 002 is the FIRST migration after the baseline, so it is the first one to
  // meet a database that already has 001 recorded and every baseline table
  // present. Until L-3.5a that combination tripped the adopt refusal and the
  // app would not have booted; worse, an operator obeying the error text would
  // have recorded 002 as applied WITHOUT creating chief_spend_cursor.
  if (phase === 'migrate') {
    const { applyMigrations, MIGRATIONS } = await import(`${DIST}/migrations.js`);
    const { sql } = await import(`${DIST}/sql.js`);
    const handle = sql();
    const only001 = MIGRATIONS.filter((m) => m.id === 1);
    const tableExists = async (name) => {
      const row = await handle
        .prepare(
          `SELECT COUNT(*) AS n FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ?`,
        )
        .get(name);
      return Number(row?.n ?? 0) > 0;
    };

    // initDb() in the harness above already brought this database fully up.
    check(await tableExists('chief_spend_cursor'), 'M: a fresh boot creates chief_spend_cursor');
    const current = await handle.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all();
    check(
      JSON.stringify(current.map((r) => Number(r.id))) === JSON.stringify(MIGRATIONS.map((m) => m.id)),
      'M: every shipped migration is recorded',
    );

    // Rewind to "001 applied, 002 pending" — exactly production's state before
    // this order lands — and prove 002 RUNS rather than demanding adoption.
    // The rewind must undo EVERYTHING 002 creates — the cursor table and the
    // llm_spend(ts) index the UTC-range sum needs — or this proves nothing
    // about a genuinely pre-002 database.
    await handle.prepare(`DELETE FROM schema_migrations WHERE id = 2`).run();
    await handle.exec(`DROP TABLE chief_spend_cursor`);
    await handle.exec(`DROP INDEX idx_llm_spend_ts`);
    check(!(await tableExists('chief_spend_cursor')), 'M: (setup) rewound to the pre-002 schema');

    let refused = null;
    let outcome = null;
    try {
      outcome = await applyMigrations(sql(), { migrations: MIGRATIONS });
    } catch (err) {
      refused = err.message;
    }
    check(refused === null, `M: 002 applies to a database that already has 001 — no adopt refusal (${refused ?? 'clean'})`);
    check(outcome?.applied?.includes(2) === true, 'M: and it was RUN, not merely recorded');
    check(await tableExists('chief_spend_cursor'), 'M: the cursor table exists afterwards');
    check((outcome?.adopted ?? []).length === 0, 'M: nothing was adopted on the way');

    // The adopt path still exists for the case it was written for: tables
    // present, migration state completely empty.
    await handle.prepare(`DELETE FROM schema_migrations`).run();
    let adoptRefusal = null;
    try {
      await applyMigrations(sql(), { migrations: only001 });
    } catch (err) {
      adoptRefusal = err.message;
    }
    check(
      adoptRefusal !== null && /Refusing to guess/.test(adoptRefusal),
      'M: an unrecorded schema is still refused — the adopt path is intact',
    );
    const adopted = await applyMigrations(sql(), { migrations: only001, adopt: true });
    check(adopted.adopted.includes(1), 'M: and LEADFINDER_DB_ADOPT=1 still records without running');
  }

  // ── phase 4: the assembly over real HTTP, in this mode ──
  if (phase === 'serve') {
    const { buildApp } = await import(`${DIST}/app.js`);
    const { basePath } = await import(`${DIST}/urls.js`);

    // Seed spend on the CURRENT UTC day so /status has something to answer with,
    // and settle part of it so the lag is non-zero and the agreement is a real
    // subtraction rather than 0 = 0.
    const now = Date.now();
    await db
      .getDb()
      .prepare(
        `INSERT INTO llm_spend
           (ts, spend_day, source, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_searches, usd)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
      )
      .run(now, llmBudget.jerusalemDay(new Date(now)), 'smoke', 'claude-sonnet-4-5', 2.37);

    const chief = await startFakeChief(() => ({ status: 202 }));
    const reporter = new sr.SpendReporter(cfg(chief.url), fetch, () => now);
    sr.setSpendReporterForTests(reporter);
    await reporter.sweep();

    const app = buildApp();
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const res = await get(port, basePath('/api/chief/status'), { authorization: `Bearer ${CHIEF_TOKEN}` });
    const body = JSON.parse(res.body);

    check(res.status === 200, `${phase}: /api/chief/status answers 200`);
    check(body.spend_today_window === 'Asia/Jerusalem', 'H: the app-day figure names its window');
    check(body.spend_today_utc_window === 'UTC', 'G: the UTC figure names its window');
    check(typeof body.spend_today_usd === 'number', 'H: spend_today_usd is still served');
    check(typeof body.spend_today_utc_usd === 'number', 'G: spend_today_utc_usd is served');
    check(body.spend_reporter === 'active', 'G: the reporter state is visible on the card');
    check(body.spend_reported_quanta === 4, 'G: $2.37 settles 4 quanta ($2.00)');
    check(
      Math.abs(body.spend_unreported_usd - 0.37) < 1e-9,
      `G: $0.37 remains as visible lag (got ${body.spend_unreported_usd})`,
    );
    check(
      Math.abs(body.spend_today_utc_usd - (body.spend_reported_quanta * 0.5 + body.spend_unreported_usd)) < 1e-9,
      'G: AGREEMENT over real HTTP — UTC figure = reported quanta + lag',
    );
    check(
      Math.abs(body.spend_today_utc_usd - chief.seen.length * 0.5 - body.spend_unreported_usd) < 1e-9,
      'G: and the quanta actually POSTED are the ones the card accounts for',
    );
    // The cap's own figure is untouched and still reads the Jerusalem sum.
    const jeruSum = await llmBudget.spentTodayUsd();
    check(
      body.spend_today_usd === jeruSum,
      'H: spend_today_usd still equals the Asia/Jerusalem sum the $100 cap enforces',
    );
    check(allSentTo127(chief.seen), `${phase}: nothing left the machine`);

    // Emit the body for the parent's cross-mode comparison, minus the fields
    // that legitimately move between two boots.
    const stable = { ...body };
    delete stable.server_time;
    console.log(`__STATUS__${JSON.stringify(stable)}`);

    await new Promise((r) => srv.close(r));
    await chief.stop();
  }

  await closeDatabase();
  process.exit(failed === 0 ? 0 : 1);
}

// ── parent ───────────────────────────────────────────────────────────────────

/** Run one child phase against a cluster, in one mode. */
function runPhase(phaseName, databaseUrl, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, `--phase=${phaseName}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CHIEF_TOKEN,
        // The reporter must be built by the test, never from the environment.
        CHIEF_URL: '',
        CHIEF_INGEST_TOKEN: '',
        NODE_ENV: 'test',
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function relay(out) {
  const statuses = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('__STATUS__')) {
      statuses.push(JSON.parse(line.slice('__STATUS__'.length)));
      continue;
    }
    if (/^\s*[✓✗]/.test(line)) {
      console.log(line);
      if (line.includes('✗')) failed++;
    } else if (line.trim() && !/^\[\d{4}-/.test(line)) {
      console.log(`      ${line}`);
    }
  }
  return statuses;
}

console.log('L-3.5a smoke — spend reporting');

const cluster = await startCluster('l35a');
try {
  console.log('\n  — quanta, ids, boundary, agreement —');
  relay((await runPhase('first', cluster.url)).out);

  console.log('\n  — a real process restart —');
  relay((await runPhase('replay', cluster.url)).out);
} finally {
  await cluster.stop();
}

const migrateCluster = await startCluster('l35a-migrate');
try {
  console.log('\n  — migration 002 against an already-migrated database —');
  relay((await runPhase('migrate', migrateCluster.url)).out);
} finally {
  await migrateCluster.stop();
}

// Failures get a clean cluster: the latch tests deliberately leave days unsettled.
const failCluster = await startCluster('l35a-fail');
try {
  console.log('\n  — 5xx retry, 4xx latch, a refused omission, dormancy —');
  relay((await runPhase('failures', failCluster.url)).out);
} finally {
  await failCluster.stop();
}

// Both modes, separate clusters, separate ports.
const bodies = [];
for (const [label, env] of [
  ['DARK  (no BASE_PATH)', {}],
  ['LIT   (BASE_PATH=/leadfinder/)', { BASE_PATH: `${PREFIX}/` }],
]) {
  const c = await startCluster('l35a-serve');
  try {
    console.log(`\n  — ${label} —`);
    const statuses = relay((await runPhase('serve', c.url, env)).out);
    if (statuses[0]) bodies.push({ label, body: statuses[0] });
  } finally {
    await c.stop();
  }
}

console.log('\n  — cross-mode —');
check(bodies.length === 2, 'both modes produced a status body');
if (bodies.length === 2) {
  check(
    JSON.stringify(bodies[0].body) === JSON.stringify(bodies[1].body),
    'the status body is byte-identical in DARK and LIT — the prefix moves the address, never the answer',
  );
  const keys = Object.keys(bodies[0].body);
  check(
    ['spend_today_usd', 'spend_today_window', 'spend_today_utc_usd', 'spend_today_utc_window',
     'spend_unreported_usd', 'spend_reported_quanta', 'spend_reporter'].every((k) => keys.includes(k)),
    'every L-3.5a field is present in both modes',
  );
}

console.log('');
console.log(failed === 0 ? '✓ L-3.5a smoke passed' : `✗ L-3.5a smoke: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
