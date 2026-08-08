#!/usr/bin/env node
/**
 * Chief machine-surface gate (order L-3.3a).
 *
 * Boots the REAL Express assembly (dist/app.js — the same buildApp() index.ts
 * calls) and asserts, over real HTTP, every property the seam rests on:
 *
 *   - the token opens ONLY /api/chief/*, and a session cookie opens NONE of it.
 *     Both directions, on every path, including the admin-only one.
 *   - the 401 is byte-identical for a missing, malformed, wrong and unset token.
 *   - the status contract, with every value proved to be READ (change the fact,
 *     see the number move) rather than asserted, and a 503 when the read fails.
 *   - every documented refusal on the create path, and the status-code ordering
 *     the Chief's contract requires: body-parser errors BEFORE auth, 401 before
 *     404.
 *   - idempotency, including under five simultaneous identical commands, and
 *     including the casing/whitespace variants that must NOT collide.
 *   - a human's job is invisible: same 404, same bytes, as an id that never
 *     existed.
 *   - pagination is stable, complete, and cannot exceed the Chief's 64 KB
 *     response ceiling even with pathological URLs in the data.
 *   - a commanded job produces no email work, proved by the DIFFERENCE against a
 *     human job in the same run.
 *
 * Four env modes, each its own child process because CHIEF_TOKEN and BASE_PATH
 * are read at module load: dark, lit, unset (no secret), padded (a secret
 * stored with surrounding whitespace).
 *
 * SAFETY: startQueue() is never called (buildApp() does not start it), so no
 * job ever executes, nothing scrapes and no mail is sent; each mode gets its
 * own database inside an EPHEMERAL PostgreSQL cluster built by pgtest.mjs
 * seconds earlier, and assertEphemeral() refuses to let a child boot against
 * anything else — the workspace's own DATABASE_URL is stripped from the child
 * environment rather than inherited; the listener binds 127.0.0.1 on an
 * EPHEMERAL port.
 *
 * Run standalone:  node artifacts/api-server/scripts/check-chief-surface.mjs
 * or via `npm test`, which invokes it after the unit suites.
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCluster, assertEphemeral } from './pgtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const PREFIX = '/leadfinder';

/** The test secret. Never a real one; the parent also proves it never appears in the log. */
const TOKEN = 'test-chief-token-3f9a2c7e51b04d8ea6';

// ── parent: run each mode as a child, because the env is read at import ──────
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
if (!mode) {
  let failed = 0;
  const cluster = await startCluster('chief');
  for (const [m, env] of [
    ['dark', { CHIEF_TOKEN: TOKEN }],
    ['lit', { CHIEF_TOKEN: TOKEN, BASE_PATH: `${PREFIX}/`, PUBLIC_BASE_URL: `https://tools.mobupps.net${PREFIX}` }],
    ['unset', {}],
    ['padded', { CHIEF_TOKEN: `  ${TOKEN}\n` }],
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), `chief-${m}-`));
    // Strip inherited values so each mode is genuinely what it claims to be,
    // even in a workspace whose own env carries some of them (this one does).
    const childEnv = { ...process.env };
    delete childEnv.BASE_PATH;
    delete childEnv.PUBLIC_BASE_URL;
    delete childEnv.CHIEF_TOKEN;
    // Each mode gets its OWN database in the throwaway cluster, so one mode's
    // fixtures can never be visible to another's assertions.
    childEnv.DATABASE_URL = cluster.createDatabase(`chief_${m.replace(/-/g, '_')}`);
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--mode=${m}`], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...childEnv, ...env },
    });
    rmSync(dir, { recursive: true, force: true });
    const out = `${res.stdout || ''}${res.stderr || ''}`;

    // THE SECRET MUST NOT BE IN THE LOG. The child prints its own boot lines,
    // every request line, and every failure message; if the token can reach any
    // of them it shows up here.
    if (out.includes(TOKEN)) {
      console.log(`FAIL [${m}] the token appears in the server's own output`);
      failed++;
    }
    // The boot line must be there, and it must say the right thing.
    const wantBoot = m === 'unset' ? 'CHIEF_TOKEN is not set' : 'CHIEF_TOKEN loaded';
    if (!out.includes(wantBoot)) {
      console.log(`FAIL [${m}] boot log does not report "${wantBoot}"`);
      failed++;
    }
    const hasWhitespaceWarning = out.includes('carried surrounding whitespace');
    if (m === 'padded' && !hasWhitespaceWarning) {
      console.log('FAIL [padded] no boot warning about the trimmed whitespace');
      failed++;
    }
    if (m !== 'padded' && hasWhitespaceWarning) {
      console.log(`FAIL [${m}] a whitespace warning was printed for a clean secret`);
      failed++;
    }

    for (const line of out.trim().split('\n')) {
      if (!/^\[\d{4}-/.test(line) && line.trim()) console.log(line);
    }
    if (res.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

// ── child ────────────────────────────────────────────────────────────────────
const LIT = mode === 'lit';
const FULL = mode === 'dark' || mode === 'lit';
let passed = 0;
const failures = [];
const check = (cond, desc) => (cond ? passed++ : failures.push(`FAIL [${mode}] ${desc}`));

assertEphemeral(process.env.DATABASE_URL);
const db = await import(`${DIST}/db.js`);
const { closeDatabase } = await import(`${DIST}/sql.js`);
const { buildApp } = await import(`${DIST}/app.js`);
const chief = await import(`${DIST}/chief.js`);
const notifier = await import(`${DIST}/notifier.js`);
const { jerusalemDay } = await import(`${DIST}/llmBudget.js`);
const CHIEF_ID = chief.CHIEF_PRINCIPAL_ID;

await db.initDb();

/**
 * Chief-owned jobs that exist BEFORE this gate creates any.
 *
 * initDb() seeds the jobs rescued from the live seam (rescueSeed.ts), and those
 * are owned by the machine principal, so "the Chief has no jobs yet" stopped
 * being true at boot in order L-3.4g. Every count below is therefore a DELTA
 * against this baseline rather than an absolute — which is also the stronger
 * assertion, since it stays honest however many jobs are seeded later.
 */
const chiefJobsAtBoot = (
  await db.getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE created_by_user_id = ?`).get(CHIEF_ID)
).n;

const human = await db.upsertUserByEmail('gate-human@mobupps.com', 'Gate Human');
const humanSession = await db.createSession(human.id, 30 * 24 * 3600 * 1000);
// ADMIN_EMAILS defaults to michael@mobupps.com — this is the admin surface.
const admin = await db.upsertUserByEmail('michael@mobupps.com', 'Gate Admin');
const adminSession = await db.createSession(admin.id, 30 * 24 * 3600 * 1000);
const humanJob = await db.createJob({
  id: 'job_HUMAN00001',
  productType: 'mobile',
  countries: ['US'],
  createdByUserId: human.id,
});

const app = buildApp();
const srv = await new Promise((r) => {
  const s = app.listen(0, '127.0.0.1', () => r(s));
});
const PORT = srv.address().port;
const P = (p) => (LIT ? `${PREFIX}${p}` : p);
const CHIEF = (p) => P(`/api/chief${p}`);

function request(method, target, { token, cookie, body, contentType } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (token !== undefined) headers.Authorization = token;
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
      if (contentType !== null) headers['Content-Type'] = contentType || 'application/json';
    }
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          /* not JSON — the caller asserts on .type instead */
        }
        resolve({
          status: res.statusCode,
          type: (res.headers['content-type'] || '').split(';')[0],
          cacheControl: res.headers['cache-control'] ?? null,
          headers: res.headers,
          bytes: raw.length,
          body: raw.toString('utf8'),
          json,
        });
      });
    });
    // A 413 is answered while the client is still writing, so the socket can
    // die under us. Resolve with what we have rather than crashing the gate.
    r.on('error', (err) => resolve({ status: 0, error: err.code || err.message, body: '', json: null }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const bearer = (t = TOKEN) => `Bearer ${t}`;
const { SESSION_COOKIE_NAME } = await import(`${DIST}/urls.js`);
const humanCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(humanSession.token)}`;
const adminCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(adminSession.token)}`;

/** Nothing above may have taught Object.prototype a `source` (or anything else). */
const validateCreateBodyStillSane = () =>
  ({}).source === undefined &&
  ({}).lead_count === undefined &&
  chief.validateCreateBody({}).ok === false;

const command = (over = {}) => ({
  source: 'meta',
  target_type: 'mobile',
  countries: ['US'],
  lead_count: 50,
  external_id: 'chief-ext-1',
  ...over,
});
const post = (bodyObj, opts = {}) =>
  request('POST', CHIEF('/jobs'), { token: bearer(), body: JSON.stringify(bodyObj), ...opts });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE 401 — indistinguishable for every cause, on every path.
// ─────────────────────────────────────────────────────────────────────────────
const CHIEF_PATHS = [
  ['GET', CHIEF('/status')],
  ['GET', CHIEF('/jobs/job_anything')],
  ['GET', CHIEF('/jobs/job_anything/leads')],
  ['POST', CHIEF('/jobs')],
  ['GET', CHIEF('/nope')],
  // The bare mount, with and without its trailing slash: both are inside the
  // gate, so neither can fall through to the SPA catch-all unauthenticated.
  ['GET', P('/api/chief')],
  ['GET', CHIEF('/')],
];

const bare = await request('GET', CHIEF('/status'));
check(bare.status === 401, `bare GET status -> 401 (got ${bare.status})`);
check(bare.json?.error === 'unauthorized', 'the 401 body is {"error":"unauthorized"}');
check(bare.cacheControl === 'no-store', 'the 401 carries Cache-Control: no-store');
check(!('www-authenticate' in bare.headers), 'the 401 does not advertise the scheme back');

for (const [m, p] of CHIEF_PATHS) {
  for (const [label, header] of [
    ['no header', undefined],
    ['empty header', ''],
    ['bare token', TOKEN],
    ['lowercase scheme', `bearer ${TOKEN}`],
    ['uppercase scheme', `BEARER ${TOKEN}`],
    ['other scheme', `Basic ${TOKEN}`],
    ['doubled space', `Bearer  ${TOKEN}`],
    ['empty credential', 'Bearer '],
    ['wrong token', bearer('not-the-token-not-the-token-not-th')],
    ['wrong token, same length', bearer('x'.repeat(TOKEN.length))],
  ]) {
    const res = await request(m, p, { token: header });
    check(res.status === 401, `${m} ${p} with ${label} -> 401 (got ${res.status})`);
    check(res.body === bare.body, `${m} ${p} with ${label}: body identical to the bare 401`);
    check(res.cacheControl === bare.cacheControl, `${m} ${p} with ${label}: headers identical`);
  }
}

// WHERE THE TRIMMING ACTUALLY HAPPENS, pinned rather than assumed. Leading and
// trailing optional whitespace around a header VALUE is removed by the HTTP
// parser itself (RFC 7230 §3.2.4) — llhttp does it before Express, let alone
// this app, sees the field. So `Bearer <token> ` is not a request this app can
// distinguish from `Bearer <token>`: it IS that request by the time it arrives.
// Whitespace INSIDE the value is not touched, which is why the doubled space
// above is a 401. Recorded because "the credential is not trimmed" is a claim
// about our code, and this is the boundary where that claim stops applying.
{
  const owsStripped = await request('GET', CHIEF('/status'), { token: `Bearer ${TOKEN} ` });
  check(
    owsStripped.status === (chief.CHIEF_TOKEN_LOADED ? 200 : 401),
    `a trailing OWS is stripped by the HTTP parser, so this is the same request (got ${owsStripped.status})`,
  );
  // A credential carrying CR/LF cannot be transmitted at all — there is no
  // header-injection path into this comparison to begin with.
  let threw = false;
  try {
    await request('GET', CHIEF('/status'), { token: `Bearer ${TOKEN}\r\nX-Injected: 1` });
  } catch {
    threw = true;
  }
  check(threw, 'a CR/LF credential cannot even be sent');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEPARATION, both directions.
// ─────────────────────────────────────────────────────────────────────────────
// A cookie session — even an ADMIN one — opens nothing here.
for (const [who, cookie] of [['a human session', humanCookie], ['an ADMIN session', adminCookie]]) {
  for (const [m, p] of CHIEF_PATHS) {
    const res = await request(m, p, { cookie });
    check(res.status === 401, `${who} does not open ${m} ${p} (got ${res.status})`);
    check(res.body === bare.body, `${who} on ${m} ${p}: the same indistinguishable 401`);
  }
}
// And the token opens nothing on the cookie surface.
for (const [m, p, want] of [
  ['GET', P('/api/me'), 'not signed in'],
  ['GET', P('/api/jobs'), 'authentication required'],
  ['POST', P('/api/jobs'), 'authentication required'],
  ['GET', P('/api/jobs/activity'), 'authentication required'],
  ['GET', P('/api/jobs/publishers'), 'authentication required'],
  ['GET', P(`/api/jobs/${humanJob.id}`), 'authentication required'],
  ['GET', P(`/api/jobs/${humanJob.id}/csv`), 'authentication required'],
  ['GET', P('/api/settings'), 'authentication required'],
]) {
  const res = await request(m, p, { token: bearer(), body: m === 'POST' ? '{}' : undefined });
  check(res.status === 401, `the chief token does not open ${m} ${p} (got ${res.status})`);
  check(res.json?.error === want, `${m} ${p} still answers its own 401 body`);
}

if (FULL) {
  // ───────────────────────────────────────────────────────────────────────────
  // 3. STATUS — every value read, not asserted.
  // ───────────────────────────────────────────────────────────────────────────
  const st = await request('GET', CHIEF('/status'), { token: bearer() });
  check(st.status === 200, `status -> 200 (got ${st.status})`);
  check(st.cacheControl === 'no-store', 'status carries Cache-Control: no-store');
  check(st.type === 'application/json', 'status answers JSON');
  check(
    Object.keys(st.json).join(',') === 'app,ok,accepting_jobs,active_jobs,spend_today_usd,server_time',
    `status has exactly the contracted fields (got ${Object.keys(st.json).join(',')})`,
  );
  check(st.json.app === 'leadfinder', 'status: app is leadfinder');
  check(st.json.ok === true, 'status: ok is true');
  check(st.json.accepting_jobs === true, 'status: accepting_jobs is true');
  check(st.json.active_jobs === 0, `status: active_jobs starts at 0 (got ${st.json.active_jobs})`);
  check(st.json.spend_today_usd === 0, 'status: spend is 0 on a fresh ledger');
  const t = Date.parse(st.json.server_time);
  check(Number.isFinite(t) && Math.abs(Date.now() - t) < 60_000, 'status: server_time is a fresh ISO-8601 instant');
  check(st.json.server_time.endsWith('Z'), 'status: server_time is UTC');

  // active_jobs is a COUNT, not a constant: move a job and it moves.
  await db.markJobRunning(humanJob.id);
  const st2 = await request('GET', CHIEF('/status'), { token: bearer() });
  check(st2.json.active_jobs === 1, `status: active_jobs counts a running job (got ${st2.json.active_jobs})`);
  await db.markJobFailed(humanJob.id, 'gate: settled back');
  const st3 = await request('GET', CHIEF('/status'), { token: bearer() });
  check(st3.json.active_jobs === 0, 'status: active_jobs falls back when the job settles');

  // spend_today_usd comes off this app's OWN ledger. It is 0 above because the
  // ledger is empty, not because a literal was hardcoded — write a row and it
  // moves. (This app DOES have a paid vendor: the Anthropic API.)
  await db.getDb()
    .prepare(
      `INSERT INTO llm_spend (ts, spend_day, source, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_searches, usd)
       VALUES (?, ?, 'gate', 'claude-sonnet-4-5', 0, 0, 0, 0, 0, ?)`,
    )
    .run(Date.now(), jerusalemDay(), 1.23);
  const st4 = await request('GET', CHIEF('/status'), { token: bearer() });
  check(st4.json.spend_today_usd === 1.23, `status: spend is READ from the ledger (got ${st4.json.spend_today_usd})`);
  await db.getDb().prepare(`DELETE FROM llm_spend WHERE source = 'gate'`).run();

  // ───────────────────────────────────────────────────────────────────────────
  // 4. CREATE — ordering, refusals, and the happy path.
  // ───────────────────────────────────────────────────────────────────────────
  // Body-parser errors precede auth. No token at all, and still not a 401.
  const malformed = await request('POST', CHIEF('/jobs'), { body: '{"source":' });
  check(malformed.status === 400, `malformed JSON with NO token -> 400, before auth (got ${malformed.status})`);
  check(malformed.json?.error === 'malformed JSON body', 'malformed JSON answers JSON, not an HTML error page');
  check(!malformed.body.includes('source'), 'the parse error does not echo the body back');
  const oversize = await request('POST', CHIEF('/jobs'), { body: `{"x":"${'a'.repeat(2 * 1024 * 1024)}"}` });
  check(
    oversize.status === 413,
    `an oversize body with NO token -> 413, before auth (got ${oversize.status}${oversize.error ? ` / ${oversize.error}` : ''})`,
  );
  check(oversize.json?.error === 'request body too large', '413 answers JSON, not an HTML error page');
  // …but a well-formed body still needs the token.
  const goodBodyNoToken = await request('POST', CHIEF('/jobs'), { body: JSON.stringify(command()) });
  check(goodBodyNoToken.status === 401, 'a valid body without a token is still 401');

  // Content-Type is required, and checked after auth.
  const noType = await request('POST', CHIEF('/jobs'), {
    token: bearer(),
    body: JSON.stringify(command()),
    contentType: null,
  });
  check(noType.status === 415, `no Content-Type -> 415 (got ${noType.status})`);
  const wrongType = await request('POST', CHIEF('/jobs'), {
    token: bearer(),
    body: JSON.stringify(command()),
    contentType: 'text/plain',
  });
  check(wrongType.status === 415, `Content-Type: text/plain -> 415 (got ${wrongType.status})`);
  const charsetType = await request('POST', CHIEF('/jobs'), {
    token: bearer(),
    body: JSON.stringify(command({ external_id: 'chief-charset' })),
    contentType: 'application/json; charset=utf-8',
  });
  check(charsetType.status === 201, 'application/json; charset=utf-8 is accepted');

  // Every documented refusal.
  for (const [label, body, wantFragment] of [
    ['an unknown field', command({ nope: 1 }), 'unknown field: nope'],
    ['a human field name', command({ maxLeads: 20 }), 'unknown field: maxLeads'],
    ['an identity in the body', command({ createdByUserId: 'usr_x' }), 'unknown field: createdByUserId'],
    ['a recipient in the body', command({ recipientEmail: 'a@b.c' }), 'unknown field: recipientEmail'],
    ['a missing source', command({ source: undefined }), 'source is required'],
    ['an unknown source', command({ source: 'store_first' }), 'source must be one of'],
    ['a mis-cased source', command({ source: 'Meta' }), 'source must be one of'],
    ['a missing target_type', command({ target_type: undefined }), 'target_type is required'],
    ['an unknown target_type', command({ target_type: 'web' }), 'target_type must be one of'],
    // NB: google_ads + mobile is NOT here. It is the pair L-3.3c fixed — it runs
    // the store-first engine, exactly as the human form's "Google Ads" + Mobile
    // does. Its acceptance is proved in section 4.
    ['appgoblin + cps', command({ source: 'appgoblin', target_type: 'cps' }), 'source appgoblin supports target_type mobile only'],
    ['appgoblin with no axis', command({ source: 'appgoblin' }), 'appgoblin jobs require'],
    ['an axis on a meta job', command({ appgoblin_category: 'games' }), 'apply to source appgoblin only'],
    ['no countries', command({ countries: [] }), 'countries must be a non-empty array'],
    ['a bare string for countries', command({ countries: 'US' }), 'countries must be a non-empty array'],
    ['an unsupported country', command({ countries: ['US', 'XX'] }), 'unsupported country: XX'],
    ['an embargoed country', command({ countries: ['KP'] }), 'unsupported country: KP'],
    ['a duplicate country', command({ countries: ['US', 'us'] }), 'duplicate country: US'],
    ['an off-menu lead_count', command({ lead_count: 25 }), 'lead_count must be one of'],
    ['an unlimited lead_count', command({ lead_count: null }), 'lead_count must be one of'],
    ['a missing lead_count', command({ lead_count: undefined }), 'lead_count must be one of'],
    ['a missing external_id', command({ external_id: undefined }), 'external_id is required'],
    ['an empty external_id', command({ external_id: '' }), 'external_id must not be empty'],
    ['a control char in external_id', command({ external_id: 'a\nb' }), 'control characters'],
    ['an over-length external_id', command({ external_id: 'x'.repeat(201) }), 'at most 200 bytes'],
  ]) {
    const res = await post(body);
    check(res.status === 400, `${label} -> 400 (got ${res.status})`);
    check(
      typeof res.json?.error === 'string' && res.json.error.includes(wantFragment),
      `${label}: the error names the problem (got ${JSON.stringify(res.json?.error)})`,
    );
  }
  // Prototype-shaped keys, sent as RAW JSON — an object literal's `__proto__:`
  // sets the prototype instead of a field, so only a raw body actually puts the
  // key on the wire. JSON.parse makes it an OWN property, Object.keys sees it,
  // and the closed-body check refuses it like any other unknown field. Pinned
  // because reading fields off a body with a poisoned prototype is a classic
  // way for a validator to be talked out of its own defaults.
  for (const [label, raw, want] of [
    [
      'a raw __proto__ key',
      '{"source":"meta","target_type":"mobile","countries":["US"],"lead_count":50,"external_id":"proto-1","__proto__":{"source":"store_first"}}',
      'unknown field: __proto__',
    ],
    [
      'a raw constructor key',
      '{"source":"meta","target_type":"mobile","countries":["US"],"lead_count":50,"external_id":"proto-2","constructor":{"x":1}}',
      'unknown field: constructor',
    ],
  ]) {
    const res = await request('POST', CHIEF('/jobs'), { token: bearer(), body: raw });
    check(res.status === 400, `${label} -> 400 (got ${res.status})`);
    check(res.json?.error === want, `${label}: refused by name (got ${JSON.stringify(res.json?.error)})`);
  }
  check(
    validateCreateBodyStillSane(),
    'the closed-body check did not have its own prototype poisoned by those attempts',
  );

  // A refusal must not have created anything.
  const afterRefusals =
    (await db.getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE created_by_user_id = ?`).get(CHIEF_ID)).n -
    chiefJobsAtBoot;
  check(afterRefusals === 1, `refusals create no jobs (only the charset one exists, got ${afterRefusals})`);

  // The happy path.
  const created = await post(command({ external_id: 'chief-ext-happy' }));
  check(created.status === 201, `create -> 201 (got ${created.status})`);
  check(created.json?.created === true, 'create reports created:true');
  const job = created.json.job;
  check(/^job_[A-Za-z0-9_-]{10}$/.test(job.job_id), `create returns a job id (${job.job_id})`);
  check(job.state === 'pending' && job.phase === 'queued', 'create returns the initial state');
  check(job.step === 'waiting for worker', 'create returns the initial step');
  check(job.external_id === 'chief-ext-happy', 'create echoes the idempotency key');
  check(job.source === 'meta' && job.target_type === 'mobile', 'create echoes source and target_type');
  check(job.countries.join(',') === 'US' && job.lead_count === 50, 'create echoes countries and the lead cap');
  check(job.final === false && job.leads_found === 0 && job.progress_pct === 0, 'create returns zeroed progress');
  check(
    Object.keys(job).join(',') ===
      'job_id,external_id,source,target_type,countries,lead_count,state,phase,step,progress_pct,leads_found,error,created_at,started_at,completed_at,run_after,final',
    `the job object has exactly the 17 contracted fields (got ${Object.keys(job).join(',')})`,
  );

  // …and the row it wrote is an ordinary job owned by the principal.
  const row = await db.getJob(job.job_id);
  check(row.created_by_user_id === chief.CHIEF_PRINCIPAL_ID, 'the job is owned by the system principal');
  check(row.recipient_email === null, 'the job has no recipient');
  check(row.status === 'pending', 'the job is queued, not started');
  check(row.source_params === '{"maxLeads":50}', `source_params matches the human shape (got ${row.source_params})`);
  check(row.countries === '["US"]', 'countries are stored in this app\'s own format');

  // Every pair the matrix allows actually creates, and lands on the engine the
  // matrix names. `stored` differs from `src` for exactly one pair — that pair
  // is the whole point of order L-3.3c.
  for (const [src, target, stored, extra] of [
    ['meta', 'cps', 'meta', {}],
    ['meta', 'mobile', 'meta', {}],
    ['affplus', 'mobile', 'affplus', {}],
    ['affplus', 'cps', 'affplus', {}],
    ['google_ads', 'cps', 'google_ads', {}],
    ['google_ads', 'mobile', 'store_first', {}],
    ['appgoblin', 'mobile', 'appgoblin', { appgoblin_category: 'game_casino' }],
  ]) {
    const res = await post(command({ source: src, target_type: target, external_id: `chief-src-${src}-${target}`, ...extra }));
    check(res.status === 201, `${src}/${target} creates (got ${res.status})`);
    const created2 = await db.getJob(res.json.job.job_id);
    check(
      created2.source === stored && created2.product_type === target,
      `${src}/${target} runs the ${stored} engine (stored ${created2.source}/${created2.product_type})`,
    );
    // Whatever engine it landed on, the Chief reads its own vocabulary back.
    check(
      res.json.job.source === src && res.json.job.target_type === target,
      `${src}/${target} echoes the vocabulary it was commanded in`,
    );
    const readBack = await request('GET', CHIEF(`/jobs/${res.json.job.job_id}`), { token: bearer() });
    check(
      readBack.json.job.source === src,
      `${src}/${target} still reads back as ${src} on a later GET (got ${readBack.json.job.source})`,
    );
  }
  const gaMobileRow = await db.getJob(
    (await db.getDb().prepare(`SELECT job_id FROM chief_jobs WHERE external_id = 'chief-src-google_ads-mobile'`).get()).job_id,
  );
  check(
    gaMobileRow.source_params ===
      '{"verticals":null,"markets":["us"],"similarMaxAppsPerRun":null,"searchTermsLimit":null,' +
        '"confirmationMaxApiCalls":null,"maxLeads":50}',
    `a commanded google_ads+mobile job steers the store engine with its own countries (got ${gaMobileRow.source_params})`,
  );

  // The Chief's actual first commanded discovery, byte for byte as it was sent
  // when it came back 400. This is the regression that named order L-3.3c.
  const theOriginal = await post({
    source: 'google_ads',
    target_type: 'mobile',
    countries: ['US'],
    lead_count: 20,
    external_id: 'chief-first-command',
  });
  check(theOriginal.status === 201, `the Chief's original command is accepted (got ${theOriginal.status})`);
  check(
    theOriginal.json?.job?.source === 'google_ads' && theOriginal.json?.job?.target_type === 'mobile',
    'the Chief\'s original command reads back in the vocabulary it was sent in',
  );
  check(theOriginal.json?.job?.state === 'pending', 'the Chief\'s original command sits queued, not started');
  const originalRow = await db.getJob(theOriginal.json.job.job_id);
  check(originalRow.source === 'store_first', 'and it is stored against the engine that actually does mobile');
  check(
    JSON.parse(originalRow.source_params).maxLeads === 20,
    'and its lead cap reached the engine — store_first honours maxLeads',
  );
  const gaRow = await db.getJob(
    (await db.getDb().prepare(`SELECT job_id FROM chief_jobs WHERE external_id = 'chief-src-google_ads-cps'`).get()).job_id,
  );
  check(
    gaRow.source_params ===
      '{"verticals":null,"languages":null,"maxKeywords":null,"customKeywords":null,"region":null,"maxLeads":50}',
    'a commanded google_ads job carries the same params a human empty form writes',
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 5. IDEMPOTENCY.
  // ───────────────────────────────────────────────────────────────────────────
  const again = await post(command({ external_id: 'chief-ext-happy' }));
  check(again.status === 200, `a repeated external_id -> 200, not 201 (got ${again.status})`);
  check(again.json?.created === false, 'the repeat reports created:false');
  check(again.json.job.job_id === job.job_id, 'the repeat returns the SAME job');
  const countAfterRepeat = (await db.getDb()
    .prepare(`SELECT COUNT(*) AS n FROM chief_jobs WHERE external_id = 'chief-ext-happy'`)
    .get()).n;
  check(countAfterRepeat === 1, 'the repeat wrote no second mapping');

  // Casing and whitespace are NOT the same key — the bytes are the key.
  const upper = await post(command({ external_id: 'CHIEF-EXT-HAPPY' }));
  check(upper.status === 201 && upper.json.job.job_id !== job.job_id, 'a differently-cased key is a different job');
  const padded = await post(command({ external_id: ' chief-ext-happy ' }));
  check(padded.status === 201 && padded.json.job.job_id !== job.job_id, 'a whitespace-padded key is a different job');
  const paddedRow = await db.getDb().prepare(`SELECT external_id FROM chief_jobs WHERE job_id = ?`).get(padded.json.job.job_id);
  check(paddedRow.external_id === ' chief-ext-happy ', 'the key is stored byte for byte');

  // Five simultaneous identical commands: exactly one job.
  const racers = await Promise.all(
    Array.from({ length: 5 }, () => post(command({ external_id: 'chief-race' }))),
  );
  const raceIds = new Set(racers.map((r) => r.json?.job?.job_id));
  check(racers.every((r) => r.status === 200 || r.status === 201), 'every racer got a success');
  check(raceIds.size === 1, `five simultaneous identical commands produce ONE job (got ${raceIds.size})`);
  check(racers.filter((r) => r.json?.created === true).length === 1, 'exactly one racer reports created:true');
  const raceRows = (await db.getDb().prepare(`SELECT COUNT(*) AS n FROM chief_jobs WHERE external_id = 'chief-race'`).get()).n;
  check(raceRows === 1, 'one mapping row for the race');

  // The uniqueness is the DATABASE's, not the read-then-write above: prove the
  // constraint fires, and that it fires with exactly the error code the
  // create path catches to return the winner's job (chief.ts
  // isUniqueConstraintError). A renamed code would silently turn a race into a
  // 500 instead of an idempotent answer.
  let constraintCode = null;
  try {
    await db.getDb()
      .prepare(`INSERT INTO chief_jobs (external_id, job_id, created_at) VALUES (?, ?, ?)`)
      .run('chief-ext-happy', humanJob.id, Date.now());
  } catch (err) {
    constraintCode = err.code;
  }
  // 23505 = PostgreSQL unique_violation. One SQLSTATE now covers both the
  // PRIMARY KEY and the UNIQUE collision below, where SQLite raised two
  // different codes; createCommandedJob's isUniqueConstraintError() keys on the
  // same value, and this is the assertion that keeps the two in step.
  check(
    constraintCode === '23505',
    `a duplicate external_id is refused by the database itself (got ${constraintCode})`,
  );
  let jobUniqueCode = null;
  try {
    await db.getDb()
      .prepare(`INSERT INTO chief_jobs (external_id, job_id, created_at) VALUES (?, ?, ?)`)
      .run('a-second-key-for-the-same-job', job.job_id, Date.now());
  } catch (err) {
    jobUniqueCode = err.code;
  }
  check(
    jobUniqueCode === '23505',
    `one job cannot carry two idempotency keys (got ${jobUniqueCode})`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 6. READ — and the invisibility of everything else.
  // ───────────────────────────────────────────────────────────────────────────
  const got = await request('GET', CHIEF(`/jobs/${job.job_id}`), { token: bearer() });
  check(got.status === 200, `read the commanded job -> 200 (got ${got.status})`);
  check(got.json.job.job_id === job.job_id && got.json.job.external_id === 'chief-ext-happy', 'the read echoes the key');
  check(got.cacheControl === 'no-store', 'the read is no-store');

  const missing = await request('GET', CHIEF('/jobs/job_DOESNOTEXIST'), { token: bearer() });
  const human404 = await request('GET', CHIEF(`/jobs/${humanJob.id}`), { token: bearer() });
  check(human404.status === 404, `a human's job -> 404 (got ${human404.status})`);
  check(human404.body === missing.body, 'a human\'s job is byte-identical to one that never existed');
  const humanLeads404 = await request('GET', CHIEF(`/jobs/${humanJob.id}/leads`), { token: bearer() });
  const missingLeads = await request('GET', CHIEF('/jobs/job_DOESNOTEXIST/leads'), { token: bearer() });
  check(humanLeads404.status === 404 && humanLeads404.body === missingLeads.body, 'the same for its leads');
  // A path-traversal-shaped id is a miss, not a surprise.
  for (const weird of ['..', '%2e%2e', 'job_x%00', "job_' OR 1=1--"]) {
    const res = await request('GET', CHIEF(`/jobs/${encodeURIComponent(weird)}`), { token: bearer() });
    check(res.status === 404, `a hostile job id (${weird}) -> 404 (got ${res.status})`);
  }

  // The human surface does not show the chief's jobs to a human…
  const humanList = await request('GET', P('/api/jobs'), { cookie: humanCookie });
  check(humanList.status === 200, 'the human job list still works');
  check(
    humanList.json.jobs.every((j) => j.created_by_user_id !== chief.CHIEF_PRINCIPAL_ID),
    'a human never sees a commanded job in their own list',
  );
  const humanReadsChief = await request('GET', P(`/api/jobs/${job.job_id}`), { cookie: humanCookie });
  check(humanReadsChief.status === 404, `a non-admin human cannot read a commanded job (got ${humanReadsChief.status})`);
  // …but an ADMIN sees it in Activity, clearly labelled. (Reported as the answer
  // to "do commanded jobs appear anywhere in the human UI?")
  const activity = await request('GET', P('/api/jobs/activity'), { cookie: adminCookie });
  const chiefInActivity = activity.json.jobs.filter((j) => j.created_by_user_id === chief.CHIEF_PRINCIPAL_ID);
  check(chiefInActivity.length > 0, 'commanded jobs appear in the admin Activity view');
  check(
    chiefInActivity.every((j) => j.creator_email === chief.CHIEF_PRINCIPAL_EMAIL && j.creator_name === chief.CHIEF_PRINCIPAL_NAME),
    'and every one of them is labelled as the Chief',
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 7. LEADS — selection, ordering, bounds, and the 64 KB ceiling.
  // ───────────────────────────────────────────────────────────────────────────
  const leadJobRes = await post(
    command({ source: 'meta', target_type: 'cps', lead_count: 100, external_id: 'chief-leads' }),
  );
  const leadJobId = leadJobRes.json.job.job_id;
  // 120 exportable rows, plus 5 that this app does not consider cps leads.
  for (let i = 1; i <= 120; i++) {
    await db.insertResult({
      job_id: leadJobId,
      advertiser_name: `Advertiser ${String(i).padStart(3, '0')}`,
      page_url: null,
      landing_url: `https://example.com/lead/${i}`,
      classification: 'cps_web',
      store_url: null,
      ad_text: 'AD COPY '.repeat(200), // must never reach the wire
      country: 'US',
    });
  }
  for (let i = 0; i < 5; i++) {
    await db.insertResult({
      job_id: leadJobId,
      advertiser_name: `Rejected ${i}`,
      page_url: null,
      landing_url: 'https://example.com/rejected',
      classification: 'unrelated',
      store_url: null,
      ad_text: null,
      country: 'US',
    });
  }

  const page1 = await request('GET', CHIEF(`/jobs/${leadJobId}/leads`), { token: bearer() });
  check(page1.status === 200, `leads -> 200 (got ${page1.status})`);
  check(page1.json.limit === 50 && page1.json.offset === 0, 'leads: the default page is offset 0, limit 50');
  check(page1.json.total === 100, `leads: total honours the job's lead cap of 100 (got ${page1.json.total})`);
  check(page1.json.count === 50 && page1.json.leads.length === 50, 'leads: a full first page');
  check(page1.json.has_more === true && page1.json.next_offset === 50, 'leads: the walk continues');
  check(page1.json.state === 'pending' && page1.json.final === false, 'leads: the page says whether it can still change');
  check(!page1.body.includes('AD COPY'), 'leads: ad_text is not on the wire');
  check(!page1.body.includes('Rejected'), 'leads: rows this app does not count as leads are excluded');
  check(
    page1.json.leads.every((l) => Object.keys(l).join(',') === 'lead_id,advertiser_name,country,classification,store_url,landing_url,page_url,app_category,is_game,found_at'),
    'leads: every lead has exactly the 10 contracted fields',
  );
  check(
    page1.json.leads.every((l, i) => i === 0 || l.lead_id > page1.json.leads[i - 1].lead_id),
    'leads: ordering is strictly ascending by lead_id',
  );

  // A complete walk: every lead exactly once, no gaps, no repeats.
  const seen = [];
  let offset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const res = await request('GET', CHIEF(`/jobs/${leadJobId}/leads?offset=${offset}&limit=30`), { token: bearer() });
    check(res.status === 200, `walk: page at offset ${offset} -> 200`);
    check(res.bytes < 64 * 1024, `walk: page at offset ${offset} is under 64 KB (${res.bytes} bytes)`);
    seen.push(...res.json.leads.map((l) => l.lead_id));
    if (!res.json.has_more) break;
    offset = res.json.next_offset;
  }
  check(seen.length === 100, `walk: 100 leads collected (got ${seen.length})`);
  check(new Set(seen).size === 100, 'walk: no lead appeared twice');
  check(seen.every((id, i) => i === 0 || id > seen[i - 1]), 'walk: the walk stayed in order');

  const capped = await request('GET', CHIEF(`/jobs/${leadJobId}/leads?limit=9999`), { token: bearer() });
  check(capped.json.limit === 100, `leads: limit is capped at 100 (got ${capped.json.limit})`);
  check(capped.json.count === 100 && capped.bytes < 64 * 1024, 'leads: a full 100-lead page still fits the ceiling');
  const past = await request('GET', CHIEF(`/jobs/${leadJobId}/leads?offset=1000`), { token: bearer() });
  check(past.status === 200 && past.json.count === 0 && past.json.has_more === false, 'leads: an offset past the end is an empty final page');
  for (const [q, why] of [
    ['?limit=abc', 'a non-numeric limit'],
    ['?limit=0', 'limit 0'],
    ['?limit=-1', 'a negative limit'],
    ['?offset=-1', 'a negative offset'],
    ['?offset=1.5', 'a fractional offset'],
    ['?offset=1&offset=2', 'a repeated offset'],
  ]) {
    const res = await request('GET', CHIEF(`/jobs/${leadJobId}/leads${q}`), { token: bearer() });
    check(res.status === 400, `leads: ${why} -> 400 (got ${res.status})`);
  }

  // THE CEILING, with pathological data: 100 leads whose URLs are 4 KB each.
  const fatRes = await post(command({ source: 'meta', target_type: 'cps', lead_count: 100, external_id: 'chief-fat' }));
  const fatJobId = fatRes.json.job.job_id;
  for (let i = 0; i < 100; i++) {
    await db.insertResult({
      job_id: fatJobId,
      advertiser_name: `Fat ${i}`,
      page_url: null,
      landing_url: `https://example.com/${'p'.repeat(4000)}?i=${i}`,
      classification: 'cps_web',
      store_url: null,
      ad_text: null,
      country: 'US',
    });
  }
  const fatSeen = [];
  let fatOffset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const res = await request('GET', CHIEF(`/jobs/${fatJobId}/leads?offset=${fatOffset}&limit=100`), { token: bearer() });
    check(res.bytes < 64 * 1024, `ceiling: a 100-limit page of 4 KB URLs is still under 64 KB (${res.bytes} bytes)`);
    check(res.json.count > 0, 'ceiling: a budget-bound page still carries leads');
    fatSeen.push(...res.json.leads.map((l) => l.lead_id));
    if (!res.json.has_more) break;
    fatOffset = res.json.next_offset;
  }
  check(fatSeen.length === 100 && new Set(fatSeen).size === 100, `ceiling: the whole set is still reachable (got ${fatSeen.length})`);

  // ───────────────────────────────────────────────────────────────────────────
  // 8. NO EMAIL — proved by the difference against a human job.
  // ───────────────────────────────────────────────────────────────────────────
  await notifier.notifyJobCompleted(await db.getJob(job.job_id));
  await notifier.notifyJobFailed(await db.getJob(job.job_id));
  const afterNotify = await db.getJob(job.job_id);
  check(afterNotify.notification_status === null, 'a commanded job records no notification status at all');
  const chiefLogs = (await db.getLogs(job.job_id)).map((l) => l.message).join('\n');
  check(chiefLogs.includes('email suppressed: commanded job'), 'the suppression is recorded in the job log');
  check(!chiefLogs.includes('Gmail'), 'no sender was ever resolved for it');
  // The same call on a HUMAN job takes the ordinary path and marks it failed
  // (no Gmail connected in this sandbox) — so the difference is the guard.
  await notifier.notifyJobCompleted(await db.getJob(humanJob.id));
  check((await db.getJob(humanJob.id)).notification_status === 'failed', 'a human job DOES go down the email path');
  check(
    (await db.getLogs(humanJob.id)).some((l) => l.message.includes('sender Gmail not connected')),
    'and says so in its own log — the two paths are distinguishable',
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 9. THE MOUNT — nothing falls through to the SPA, nothing else moved.
  // ───────────────────────────────────────────────────────────────────────────
  for (const [m, p] of [
    ['GET', CHIEF('/nope')],
    ['GET', CHIEF('/')],
    ['POST', CHIEF('/status')],
    ['DELETE', CHIEF(`/jobs/${job.job_id}`)],
    ['GET', CHIEF('/jobs')],
    ['GET', CHIEF(`/jobs/${job.job_id}/leads/extra`)],
  ]) {
    const res = await request(m, p, { token: bearer(), body: m === 'POST' ? '{}' : undefined });
    check(res.status === 404, `${m} ${p} -> 404 (got ${res.status})`);
    check(res.type === 'application/json', `${m} ${p} answers JSON, never the SPA page`);
  }
  // A prefix LOOKALIKE is not the mount: /api/chiefX must not be adopted.
  const lookalike = await request('GET', P('/api/chiefX/status'), { token: bearer() });
  const control = await request('GET', P('/some/unknown/path'), { token: bearer() });
  check(lookalike.json?.app === undefined, '/api/chiefX/status is not served by the chief router');
  check(
    lookalike.status === control.status && lookalike.type === control.type,
    `a lookalike path is treated exactly like any other unknown path (${lookalike.status} ${lookalike.type} vs ${control.status} ${control.type})`,
  );

  // Mount matching is case-INSENSITIVE app-wide (O-15, unchanged by this
  // order): /API/CHIEF/status reaches the same router. Pinned so it is known
  // behaviour rather than a discovery — the token is still required, and the
  // Chief's contract names the lower-case path.
  const shouty = await request('GET', P('/API/CHIEF/status').toUpperCase().replace('/LEADFINDER', PREFIX), {
    token: bearer(),
  });
  check(shouty.status === 200 || shouty.status === 404, `an upper-cased path is answered predictably (${shouty.status})`);
  const shoutyAnon = await request('GET', P('/API/CHIEF/status'));
  check(shoutyAnon.status === 401 || shoutyAnon.status === 404, 'and it is never open without the token');

  // The health surface and the SPA are untouched.
  const health = await request('GET', P('/api/health'));
  check(health.status === 200 && health.json.ok === true, 'health still answers');
  const spa = await request('GET', P('/'));
  check(spa.status === 200 && spa.type === 'text/html', 'the SPA root still answers');
  if (LIT) {
    // L2's legacy layer is an enumerated list; /api/chief is not on it, and the
    // machine surface is not reachable at an unprefixed address.
    const unprefixed = await request('GET', '/api/chief/status', { token: bearer() });
    check(unprefixed.status === 404, `unprefixed /api/chief/status -> 404 while prefixed (got ${unprefixed.status})`);
    check(!(unprefixed.status >= 300 && unprefixed.status < 400), 'no legacy redirect adopted the chief surface');
    const legacyCsv = await request('GET', `/api/jobs/${humanJob.id}/csv`);
    check(legacyCsv.status === 307, `the L2 legacy redirect still answers 307 (got ${legacyCsv.status})`);
    check(legacyCsv.headers.location === `${PREFIX}/api/jobs/${humanJob.id}/csv`, 'and still points where it did');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 10. 503 — a failed read is never a fabricated value. Runs LAST: it closes
  //     the database under the server on purpose.
  // ───────────────────────────────────────────────────────────────────────────
  await closeDatabase();
  const dead = await request('GET', CHIEF('/status'), { token: bearer() });
  check(dead.status === 503, `status with an unreadable database -> 503 (got ${dead.status})`);
  check(dead.json?.error === 'status unavailable', '503 says so, and reports no numbers');
  check(!('ok' in (dead.json || {})), 'the 503 body carries no fabricated status fields');
  const deadCreate = await post(command({ external_id: 'chief-dead' }));
  check(deadCreate.status === 503, `create with an unreadable database -> 503 (got ${deadCreate.status})`);
  const deadRead = await request('GET', CHIEF(`/jobs/${job.job_id}`), { token: bearer() });
  check(deadRead.status === 503, `a job read with a dead database -> 503, not 500 (got ${deadRead.status})`);
  check(deadRead.json?.error === 'temporarily unavailable', 'the read 503 says retry, and reports nothing else');
  const deadLeads = await request('GET', CHIEF(`/jobs/${job.job_id}/leads`), { token: bearer() });
  check(deadLeads.status === 503, `a leads read with a dead database -> 503 (got ${deadLeads.status})`);
  check(!('leads' in (deadLeads.json || {})), 'and never an empty lead list that would read as "no leads"');
  // …and the token still gates it: no database, still 401 first.
  const deadAnon = await request('GET', CHIEF('/status'));
  check(deadAnon.status === 401, 'auth still precedes the database');
}

if (mode === 'unset') {
  // No secret: the surface exists but nothing can open it, and the answer is
  // the same one a wrong token gets — an attacker cannot tell them apart.
  const withToken = await request('GET', CHIEF('/status'), { token: bearer() });
  check(withToken.status === 401, `with CHIEF_TOKEN unset, the right-looking token is still 401 (got ${withToken.status})`);
  check(withToken.body === bare.body, 'unset and wrong are indistinguishable');
  check(chief.CHIEF_TOKEN_LOADED === false, 'the loader reports the token as NOT loaded');
  const createAttempt = await post(command());
  check(createAttempt.status === 401, 'no job can be commanded without a secret');
  check(
    (await db.getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE created_by_user_id = ?`).get(CHIEF_ID)).n ===
      chiefJobsAtBoot,
    'and none was created',
  );
}

if (mode === 'padded') {
  // The stored secret was "  <token>\n". The trimmed value authenticates…
  const trimmed = await request('GET', CHIEF('/status'), { token: bearer() });
  check(trimmed.status === 200, `the trimmed value authenticates (got ${trimmed.status})`);
  check(chief.CHIEF_TOKEN_LOADED === true, 'the loader reports the token as loaded');
  check(chief.CHIEF_TOKEN_TRIMMED_WHITESPACE === true, 'the loader noticed the whitespace');
  // …and a credential with INTERIOR padding does not, so the trim on load is
  // not a way in. (A leading or trailing space around the whole field value is
  // removed by the HTTP parser before this app sees it — see the note in the
  // 401 section — so those two forms are not distinct requests to test here.)
  for (const variant of [` ${TOKEN}`, ` ${TOKEN} `, `${TOKEN} x`]) {
    const res = await request('GET', CHIEF('/status'), { token: `Bearer ${variant}` });
    check(res.status === 401, `an interior-padded credential (${JSON.stringify(variant)}) does not authenticate`);
  }
  // A newline in the stored secret is trimmed at load, not smuggled in: the
  // padded env value ends in "\n" and the surface still works, above.
  const wrongEntirely = await request('GET', CHIEF('/status'), { token: bearer('nope') });
  check(wrongEntirely.status === 401, 'and a wrong token is still 401');
}

srv.close();
try {
  await closeDatabase();
} catch {
  /* mode 10 already closed it */
}

console.log(`chief-surface [${mode}]: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
