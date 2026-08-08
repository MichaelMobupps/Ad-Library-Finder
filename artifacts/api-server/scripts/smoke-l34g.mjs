#!/usr/bin/env node
/**
 * Order L-3.4g smoke — both modes, separate ports, ephemeral clusters, runner
 * disabled.
 *
 * WHAT IT PROVES
 *
 *   A. SEAM PARITY WITH LIVE. The rescued chief job is served out of the
 *      migrated database and compared, FIELD BY FIELD, against the bytes the
 *      LIVE deployment returned when this order paged it off the seam. The
 *      fixture is not a hand-written expectation — it is the recorded truth, so
 *      "the seeded job answers exactly as live does" is checkable rather than
 *      asserted. Both the job DTO and every one of its leads.
 *
 *   B. BASELINE PROBES ARE BYTE-IDENTICAL BETWEEN MODES. Every probe below is
 *      served in DARK (no BASE_PATH) and in LIT (BASE_PATH=/leadfinder/) and
 *      the bodies must match byte for byte. The prefix moves the ADDRESS of a
 *      route, never its answer; a body that differs between modes is a bug this
 *      catches (V1 found one where a broken download answered `200 index.html`).
 *
 *   C. DOWNLOADS SURVIVE A RESTART, over real HTTP, in both modes.
 *
 * SAFETY: buildApp() does not start the queue, so no job runs, nothing is
 * scraped and no mail is sent. Each mode gets its own database inside an
 * ephemeral cluster and its own ephemeral port on 127.0.0.1. No live call is
 * made — the "live" side of the parity check is the committed fixture.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startCluster, assertEphemeral } from './pgtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const SELF = fileURLToPath(import.meta.url);
const PREFIX = '/leadfinder';
const TOKEN = 'smoke-l34g-token-not-a-real-secret';

const RESCUED = JSON.parse(readFileSync(path.join(ROOT, 'rescue', 'job_u5I0sjFlo_.json'), 'utf8'));
const SMOKE_JOB = 'job_SMOKEL34G01';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  failed++;
};
const check = (c, m) => (c ? ok(m) : bad(m));

// ── child: boot the assembly and print its port ──────────────────────────────

const mode = (process.argv.find((a) => a.startsWith('--serve=')) || '').slice(8);
if (mode) {
  assertEphemeral(process.env.DATABASE_URL);
  const db = await import(`${DIST}/db.js`);
  const { buildApp } = await import(`${DIST}/app.js`);
  const { SESSION_COOKIE_NAME } = await import(`${DIST}/urls.js`);
  await db.initDb();

  // A signed-in owner with a downloadable job, created idempotently so a
  // RESTARTED server in the same database reuses the same user rather than
  // colliding on the unique email. The session is fresh each boot; the cookie
  // is reprinted, so the parent always has a valid one.
  const user = await db.upsertUserByEmail('smoke@mobupps.com', 'Smoke');
  if (!(await db.getJob(SMOKE_JOB))) {
    await db.createJob({
      id: SMOKE_JOB,
      productType: 'mobile',
      countries: ['GB'],
      createdByUserId: user.id,
      source: 'store_first',
      sourceParams: { maxLeads: 20 },
    });
    await db.markJobRunning(SMOKE_JOB);
    for (let i = 1; i <= 3; i++) {
      await db.insertResult({
        job_id: SMOKE_JOB,
        advertiser_name: `Smoke Advertiser ${i}`,
        page_url: null,
        landing_url: null,
        classification: 'mobile_google_play',
        store_url: `https://play.google.com/store/apps/details?id=com.smoke.${i}`,
        ad_text: 'copy',
        country: 'GB',
      });
    }
    await db.markJobCompleted(SMOKE_JOB, '/nonexistent/smoke.csv', { ads: 9, advertisers: 3 });
  }
  const session = await db.createSession(user.id, 30 * 24 * 3600 * 1000);

  const srv = http.createServer(buildApp());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  console.log(`COOKIE=${SESSION_COOKIE_NAME}=${session.token}`);
  console.log(`PORT=${srv.address().port}`);
  await new Promise(() => {});
}

// ── parent ───────────────────────────────────────────────────────────────────

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          type: (res.headers['content-type'] || '').split(';')[0],
          disposition: res.headers['content-disposition'] ?? null,
          raw: Buffer.concat(chunks),
          get text() {
            return this.raw.toString('utf8');
          },
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const cluster = await startCluster('smoke-l34g');

const startServer = (label, env) =>
  new Promise((resolve, reject) => {
    const base = { ...process.env, ...env };
    delete base.BASE_PATH;
    delete base.PUBLIC_BASE_URL;
    const child = spawn(process.execPath, [SELF, `--serve=${label}`], {
      cwd: ROOT,
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const t = setTimeout(() => reject(new Error(`${label} did not report a port:\n${buf}`)), 45_000);
    const onData = (d) => {
      buf += d;
      const m = buf.match(/^PORT=(\d+)$/m);
      if (m) {
        clearTimeout(t);
        const c = buf.match(/^COOKIE=(.+)$/m);
        resolve({ child, port: Number(m[1]), cookie: c ? c[1] : null, output: () => buf });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`${label} exited early (${code}):\n${buf}`));
    });
  });

const stop = (child) =>
  new Promise((r) => {
    child.removeAllListeners('exit');
    child.once('exit', r);
    child.kill('SIGKILL');
  });

try {
  const dark = await startServer('dark', {
    DATABASE_URL: cluster.createDatabase('smoke_dark'),
    CHIEF_TOKEN: TOKEN,
  });
  const lit = await startServer('lit', {
    DATABASE_URL: cluster.createDatabase('smoke_lit'),
    CHIEF_TOKEN: TOKEN,
    BASE_PATH: `${PREFIX}/`,
    PUBLIC_BASE_URL: `https://tools.mobupps.net${PREFIX}`,
  });
  check(dark.port !== lit.port, `both modes are up on separate ports (${dark.port}, ${lit.port})`);

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const JOB = RESCUED.job_id;

  // ── A. seam parity with what LIVE returned ────────────────────────────────
  for (const [label, srv, prefix] of [
    ['dark', dark, ''],
    ['lit', lit, PREFIX],
  ]) {
    const jobRes = await request(srv.port, `${prefix}/api/chief/jobs/${JOB}`, auth);
    check(jobRes.status === 200, `[${label}] the seeded chief job resolves over the seam (got ${jobRes.status})`);
    const gotJob = JSON.parse(jobRes.text).job;

    // Field-by-field against the recorded live answer.
    const diffs = [];
    for (const key of Object.keys(RESCUED.job)) {
      const a = JSON.stringify(RESCUED.job[key]);
      const b = JSON.stringify(gotJob[key]);
      if (a !== b) diffs.push(`${key}: live=${a} local=${b}`);
    }
    const extra = Object.keys(gotJob).filter((k) => !(k in RESCUED.job));
    check(
      diffs.length === 0,
      `[${label}] every job field matches what LIVE returned${diffs.length ? ` — ${diffs.join('; ')}` : ''}`,
    );
    check(extra.length === 0, `[${label}] the job DTO grew no new field${extra.length ? ` (${extra})` : ''}`);

    const leadsRes = await request(srv.port, `${prefix}/api/chief/jobs/${JOB}/leads?offset=0&limit=100`, auth);
    check(leadsRes.status === 200, `[${label}] the leads page answers (got ${leadsRes.status})`);
    const page = JSON.parse(leadsRes.text);
    check(
      page.total === RESCUED.leads_endpoint.total,
      `[${label}] the lead total matches live (${page.total} vs ${RESCUED.leads_endpoint.total})`,
    );
    check(page.state === RESCUED.leads_endpoint.state, `[${label}] the state matches live (${page.state})`);
    check(page.final === true, `[${label}] the job still reports final:true`);

    // The leads themselves, as bytes. ad_text is not on this wire and never was
    // (leadToChiefDto omits it), so the rescued rows can be compared whole.
    const liveLeads = JSON.stringify(RESCUED.leads);
    const gotLeads = JSON.stringify(page.leads);
    check(
      liveLeads === gotLeads,
      `[${label}] ALL ${RESCUED.leads.length} leads are byte-identical to what live returned` +
        (liveLeads === gotLeads
          ? ''
          : ` — first difference at ${(() => {
              for (let i = 0; i < Math.max(liveLeads.length, gotLeads.length); i++) {
                if (liveLeads[i] !== gotLeads[i]) return `char ${i}: ${liveLeads.slice(i, i + 80)} | ${gotLeads.slice(i, i + 80)}`;
              }
              return 'length';
            })()}`),
    );

    // lf_lead_id is the value the Chief already recorded against its prospects.
    check(
      page.leads.every((l, i) => l.lead_id === RESCUED.leads[i].lead_id),
      `[${label}] lead ids are the originals (${page.leads[0]?.lead_id}..${page.leads.at(-1)?.lead_id})`,
    );
    // The ICP backfill's three fields specifically.
    check(
      page.leads.every(
        (l, i) =>
          l.page_url === RESCUED.leads[i].page_url &&
          l.is_game === RESCUED.leads[i].is_game &&
          l.found_at === RESCUED.leads[i].found_at,
      ),
      `[${label}] page_url / is_game / found_at survive — the ICP backfill can still read them`,
    );
  }

  // ── B. baseline probes byte-identical between modes ───────────────────────
  const PROBES = [
    ['health', '/api/health'],
    ['chief status', '/api/chief/status', auth],
    ['chief 401 (no token)', '/api/chief/status'],
    ['chief 404 (unknown path)', '/api/chief/nope', auth],
    ['chief 404 (unknown job)', '/api/chief/jobs/job_doesnotexist', auth],
    ['chief 400 (bad limit)', `/api/chief/jobs/${JOB}/leads?limit=abc`, auth],
    ['api/me anonymous', '/api/me'],
    ['jobs unauthenticated', '/api/jobs'],
  ];
  // Fields that legitimately move between two independently-booted processes.
  const VOLATILE = /("ts":\d+|"server_time":"[^"]+"|"builtAt":"[^"]+")/g;
  for (const [label, p, headers] of PROBES) {
    const a = await request(dark.port, p, headers ?? {});
    const b = await request(lit.port, `${PREFIX}${p}`, headers ?? {});
    const norm = (r) => r.raw.toString('utf8').replace(VOLATILE, '<volatile>');
    check(
      a.status === b.status && norm(a) === norm(b) && a.type === b.type,
      `probe "${label}" is identical in both modes (${a.status}/${b.status}, ${JSON.stringify(norm(a)).slice(0, 90)})`,
    );
  }

  // A LIT server must not answer the unprefixed address with a chief payload.
  const unprefixed = await request(lit.port, '/api/chief/status', auth);
  check(
    unprefixed.status !== 200 || !/accepting_jobs/.test(unprefixed.text),
    `[lit] the unprefixed chief path does not serve the seam (got ${unprefixed.status})`,
  );

  // ── C. downloads survive a restart, in both modes ─────────────────────────
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  for (const [label, srv, prefix, env] of [
    ['dark', dark, '', { DATABASE_URL: cluster.urlFor('smoke_dark'), CHIEF_TOKEN: TOKEN }],
    [
      'lit',
      lit,
      PREFIX,
      {
        DATABASE_URL: cluster.urlFor('smoke_lit'),
        CHIEF_TOKEN: TOKEN,
        BASE_PATH: `${PREFIX}/`,
        PUBLIC_BASE_URL: `https://tools.mobupps.net${PREFIX}`,
      },
    ],
  ]) {
    // AUTHENTICATED, because an anonymous 401 compared against another 401
    // would prove nothing about downloads at all. The job below is owned by the
    // signed-in smoke user; its csv_path deliberately names a file that does
    // not exist, so a route that went back to the filesystem answers 404 here.
    const cookieBefore = { Cookie: srv.cookie };
    const before = await request(srv.port, `${prefix}/api/jobs/${SMOKE_JOB}/csv`, cookieBefore);
    check(before.status === 200, `[${label}] the owner can download the CSV (got ${before.status})`);
    check(
      /Smoke Advertiser 1/.test(before.text),
      `[${label}] the CSV is rebuilt from the job's stored rows`,
    );

    await stop(srv.child);
    const restarted = await startServer(`${label}-restarted`, env);
    const after = await request(restarted.port, `${prefix}/api/jobs/${SMOKE_JOB}/csv`, {
      Cookie: restarted.cookie,
    });
    check(
      after.status === 200 && hash(before.raw) === hash(after.raw),
      `[${label}] the download is BYTE-IDENTICAL across a real restart (${after.status}, ${hash(after.raw).slice(0, 12)})`,
    );
    // The session itself came out of the database, not out of process memory.
    const oldCookieAfter = await request(restarted.port, `${prefix}/api/jobs/${SMOKE_JOB}/csv`, cookieBefore);
    check(
      oldCookieAfter.status === 200,
      `[${label}] the session issued by the DEAD process still authenticates (got ${oldCookieAfter.status})`,
    );
    await stop(restarted.child);
  }
} catch (err) {
  bad(`smoke aborted: ${err.stack || err.message}`);
} finally {
  await cluster.stop();
}

console.log(failed === 0 ? '\nL-3.4g SMOKE: clean' : `\nL-3.4g SMOKE: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
