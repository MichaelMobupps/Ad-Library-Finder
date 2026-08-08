#!/usr/bin/env node
/**
 * Durability gate (order L-3.4g) — the four claims this order actually makes.
 *
 *   1. PERSISTENCE ACROSS A REAL PROCESS RESTART. A job, its leads and its
 *      chief mapping written by one process are read back by a DIFFERENT
 *      process, started after the first one exited. Not "the same process
 *      re-read its own cache" — separate `node` invocations, so nothing but
 *      the database can be carrying the state.
 *
 *   2. THE RESCUE SEED IS IDEMPOTENT. Booting repeatedly must not duplicate the
 *      rescued chief job, must not renumber its leads (their ids ARE the
 *      Chief's `lf_lead_id`), and must leave the identity sequence able to hand
 *      out a fresh id that does not collide with a rescued one.
 *
 *   3. A DOWNLOAD LINK ANSWERS IDENTICALLY ACROSS A RESTART. The CSV and the
 *      per-HQ .xlsx bundle are fetched over real HTTP from one server, that
 *      server is killed, a new one is started against the same database, and
 *      the same URLs must return BYTE-IDENTICAL bodies. This is the property
 *      the old filesystem-backed download could not have: its file was on a
 *      disk that a publish replaces.
 *
 *   4. THE SERVER REFUSES TO BOOT WITHOUT A DATABASE. No fallback, no local
 *      file, no silent degradation.
 *
 *   5. THE DATABASE PASSWORD NEVER REACHES THE LOG. `DATABASE_URL` carries a
 *      credential, and the boot line names the backend. Proved by booting
 *      against a URL that HAS a password and reading every byte the process
 *      wrote — the cluster uses trust auth, so the password is accepted and
 *      ignored, which is exactly what makes it a usable canary.
 *
 * Every phase runs against an ephemeral cluster. The queue is NEVER started, so
 * no job executes, nothing is scraped and no mail is sent.
 *
 * Run standalone:  node artifacts/api-server/scripts/check-durability.mjs
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startCluster, assertEphemeral } from './pgtest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const SELF = fileURLToPath(import.meta.url);

const phase = (process.argv.find((a) => a.startsWith('--phase=')) || '').slice(8);

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  failed++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

const JOB_ID = 'job_DURABLE001';
const LEAD_ADVERTISER = 'Durable Advertiser';
const EXTERNAL_ID = 'durability-external-key';

// ── child phases ─────────────────────────────────────────────────────────────

/** Boot the assembly on 127.0.0.1:<ephemeral>, without ever starting the queue. */
async function serve() {
  const { buildApp } = await import(`${DIST}/app.js`);
  const app = buildApp();
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

function get(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

if (phase) {
  assertEphemeral(process.env.DATABASE_URL);
  const db = await import(`${DIST}/db.js`);
  const { closeDatabase } = await import(`${DIST}/sql.js`);
  const { SESSION_COOKIE_NAME } = await import(`${DIST}/urls.js`);

  await db.initDb();

  if (phase === 'write') {
    // A user, a session, a completed job with leads, and a chief mapping.
    const user = await db.upsertUserByEmail('durable@mobupps.com', 'Durable');
    const session = await db.createSession(user.id, 30 * 24 * 3600 * 1000);
    await db.createJob({
      id: JOB_ID,
      productType: 'mobile',
      countries: ['GB'],
      createdByUserId: user.id,
      source: 'store_first',
      sourceParams: { maxLeads: 20 },
    });
    await db.markJobRunning(JOB_ID);
    for (let i = 1; i <= 3; i++) {
      await db.insertResult({
        job_id: JOB_ID,
        advertiser_name: `${LEAD_ADVERTISER} ${i}`,
        page_url: `https://example.test/${i}`,
        landing_url: `https://example.test/${i}`,
        classification: 'mobile_google_play',
        store_url: `https://play.google.com/store/apps/details?id=com.durable.${i}`,
        ad_text: 'ad copy',
        country: 'GB',
      });
    }
    await db.markJobCompleted(JOB_ID, '/tmp/a-path-that-will-not-exist.csv', { ads: 9, advertisers: 3 });
    await db.setJobHqZipPath(JOB_ID, '/tmp/a-zip-that-will-not-exist.zip');
    // One HQ resolution in the cache, so the regenerated bundle has a real
    // country bucket AND an Unknown bucket to prove both paths.
    const { storeHqCache } = await import(`${DIST}/hqCache.js`);
    await storeHqCache('https://play.google.com/store/apps/details?id=com.durable.1', {
      company_name: 'Durable Ltd',
      parent_company: null,
      primary_market: 'United Kingdom',
      corporate_domain: 'durable.test',
      override_source: 'script',
      reasoning: 'fixture',
    });
    await db.getDb()
      .prepare(`INSERT INTO chief_jobs (external_id, job_id, created_at) VALUES (?, ?, ?)`)
      .run(EXTERNAL_ID, JOB_ID, Date.now());

    console.log(`SESSION=${SESSION_COOKIE_NAME}=${session.token}`);
    await closeDatabase();
    process.exit(0);
  }

  if (phase === 'serve') {
    const { port } = await serve();
    console.log(`PORT=${port}`);
    // Held open until the parent kills this process — that kill IS the restart.
    await new Promise(() => {});
  }

  if (phase === 'read') {
    // Re-run the seeder EXPLICITLY and report what it decided. Asserting only
    // on row counts is not enough: with the idempotency guard removed the
    // counts still hold, because the jobs PRIMARY KEY rejects the second insert
    // and the seeder logs the failure. That is a broken seeder passing a green
    // test, so the outcome itself is what gets asserted. (Found by mutation.)
    const { seedRescuedChiefJobs } = await import(`${DIST}/rescueSeed.js`);
    const seedOutcome = await seedRescuedChiefJobs();

    const job = await db.getJob(JOB_ID);
    const results = await db.getResults(JOB_ID);
    const mapping = await db.getDb()
      .prepare(`SELECT external_id FROM chief_jobs WHERE job_id = ?`)
      .get(JOB_ID);
    const seeded = await db.getDb()
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE id = 'job_u5I0sjFlo_'`)
      .get();
    const seededLeads = await db.getDb()
      .prepare(`SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM job_results WHERE job_id = 'job_u5I0sjFlo_'`)
      .get();
    console.log(
      `READ=${JSON.stringify({
        status: job?.status ?? null,
        leads: results.length,
        firstAdvertiser: results[0]?.advertiser_name ?? null,
        external: mapping?.external_id ?? null,
        seededJobs: Number(seeded.n),
        seededLeads: Number(seededLeads.n),
        seededLo: seededLeads.lo == null ? null : Number(seededLeads.lo),
        seededHi: seededLeads.hi == null ? null : Number(seededLeads.hi),
        seedOutcome,
      })}`,
    );
    await closeDatabase();
    process.exit(0);
  }

  if (phase === 'freshid') {
    // A brand-new lead must NOT collide with a rescued id, which it would if
    // the identity sequence had been left at 1 after the explicit-id seed.
    await db.createJob({
      id: 'job_FRESHID001',
      productType: 'mobile',
      countries: ['GB'],
      createdByUserId: 'usr_chief',
    });
    await db.insertResult({
      job_id: 'job_FRESHID001',
      advertiser_name: 'Fresh',
      page_url: null,
      landing_url: null,
      classification: 'mobile_google_play',
      store_url: 'https://play.google.com/store/apps/details?id=com.fresh',
      ad_text: null,
      country: 'GB',
    });
    const row = await db.getDb()
      .prepare(`SELECT id FROM job_results WHERE job_id = 'job_FRESHID001'`)
      .get();
    console.log(`FRESHID=${Number(row.id)}`);
    await closeDatabase();
    process.exit(0);
  }

  throw new Error(`unknown phase ${phase}`);
}

// ── parent ───────────────────────────────────────────────────────────────────

const cluster = await startCluster('durability');
const childEnv = () => {
  const env = { ...process.env, DATABASE_URL: cluster.url };
  delete env.BASE_PATH;
  delete env.PUBLIC_BASE_URL;
  return env;
};

const runPhase = (name, extra = {}) =>
  spawnSync(process.execPath, [SELF, `--phase=${name}`], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...childEnv(), ...extra },
  });

try {
  // ── 4. boot refusal, first: it needs no state at all ──────────────────────
  {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const res = spawnSync(process.execPath, [path.join(DIST, 'index.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    check(res.status !== 0, `the server refuses to boot without DATABASE_URL (exit ${res.status})`);
    check(
      /DATABASE_URL is not set/.test(out),
      'the refusal names the missing variable rather than failing obscurely',
    );
    check(
      !/sqlite|data\/ad-library/i.test(out),
      'it does not fall back to a local file (no sqlite anywhere in the failure)',
    );
  }

  // ── 5. the password never reaches the log ────────────────────────────────
  {
    const CANARY = 'pAssw0rd-canary-must-not-appear';
    // Same socket, same database — only a password is added. Trust auth accepts
    // it and ignores it, so this boots normally while giving us a string that
    // must not survive into any output.
    const withPassword = cluster.url.replace('postgres@localhost', `postgres:${CANARY}@localhost`);
    const res = spawnSync(process.execPath, [SELF, '--phase=read'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...childEnv(), DATABASE_URL: withPassword },
    });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    check(res.status === 0, 'phase 5: the server boots against a password-bearing DATABASE_URL');
    check(!out.includes(CANARY), 'phase 5: the password appears NOWHERE in the process output');
    check(
      /db: postgres [^\s]+ — migrations/.test(out),
      'phase 5: the boot line still names the backend (host:port/database)',
    );
    check(
      !/postgresql:\/\//.test(out) && !/postgres:\/\//.test(out),
      'phase 5: no raw connection URL is printed at all',
    );
  }

  // ── 1. persistence across a real process restart ──────────────────────────
  const write = runPhase('write');
  if (write.status !== 0) {
    bad(`write phase failed: ${write.stdout}${write.stderr}`);
    throw new Error('cannot continue');
  }
  const cookie = (write.stdout.match(/^SESSION=(.+)$/m) || [])[1];
  check(!!cookie, 'phase 1: a session was issued by the writing process');

  const read = runPhase('read');
  const readOut = JSON.parse((read.stdout.match(/^READ=(.+)$/m) || ['', '{}'])[1]);
  check(read.status === 0, 'phase 1: a SECOND process read the database');
  check(readOut.status === 'completed', `phase 1: the job survived the restart (status ${readOut.status})`);
  check(readOut.leads === 3, `phase 1: all 3 leads survived (got ${readOut.leads})`);
  check(
    readOut.firstAdvertiser === `${LEAD_ADVERTISER} 1`,
    'phase 1: the lead rows are the same rows, not a fresh empty table',
  );
  check(readOut.external === EXTERNAL_ID, 'phase 1: the chief idempotency mapping survived');

  // ── 2. the rescue seed is idempotent ──────────────────────────────────────
  // Both boots above already ran seedRescuedChiefJobs(); a third makes three.
  const third = runPhase('read');
  const thirdOut = JSON.parse((third.stdout.match(/^READ=(.+)$/m) || ['', '{}'])[1]);
  check(thirdOut.seededJobs === 1, `phase 2: three boots leave exactly ONE rescued job (got ${thirdOut.seededJobs})`);
  check(thirdOut.seededLeads === 20, `phase 2: its 20 leads are not duplicated (got ${thirdOut.seededLeads})`);
  check(
    thirdOut.seededLo === 21 && thirdOut.seededHi === 40,
    `phase 2: lead ids are preserved as 21..40 — they ARE the Chief's lf_lead_id (got ${thirdOut.seededLo}..${thirdOut.seededHi})`,
  );
  const so = thirdOut.seedOutcome ?? {};
  check(
    Array.isArray(so.seeded) && so.seeded.length === 0,
    `phase 2: a later boot SEEDS NOTHING — it recognises the job, rather than failing on the primary key (seeded ${JSON.stringify(so.seeded)})`,
  );
  check(
    Array.isArray(so.alreadyPresent) && so.alreadyPresent.includes('job_u5I0sjFlo_'),
    `phase 2: it reports the rescued job as already present (${JSON.stringify(so.alreadyPresent)})`,
  );
  check(
    Array.isArray(so.unrecoverable) && so.unrecoverable.includes('job_7nQAfTUr1v'),
    `phase 2: the job the live seam had already lost is reported unrecoverable, not silently skipped (${JSON.stringify(so.unrecoverable)})`,
  );

  const fresh = runPhase('freshid');
  const freshId = Number((fresh.stdout.match(/^FRESHID=(\d+)$/m) || [])[1]);
  check(
    fresh.status === 0 && freshId > 40,
    `phase 2: a new lead gets an id past every rescued one (got ${freshId}) — the identity sequence was realigned`,
  );

  // ── 3. a download answers identically across a restart ────────────────────
  const hash = (buf) => createHash('sha256').update(buf).digest('hex');

  /**
   * Start a server child and wait for it to announce its port.
   *
   * `spawn`, not `spawnSync`: this child never exits on its own — killing it is
   * the restart being tested.
   */
  const startServer = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SELF, '--phase=serve'], {
        cwd: ROOT,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`server child did not report a port:\n${buf}`)), 45_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/^PORT=(\d+)$/m);
        if (m) {
          clearTimeout(timer);
          resolve({ child, port: Number(m[1]) });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        buf += d;
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server child exited early (${code}):\n${buf}`));
      });
    });

  const stopServer = (child) =>
    new Promise((resolve) => {
      child.removeAllListeners('exit');
      child.once('exit', resolve);
      child.kill('SIGKILL');
    });

  const CSV_URL = `/api/jobs/${JOB_ID}/csv`;
  const ZIP_URL = `/api/jobs/${JOB_ID}/hq-zip`;

  const before = await startServer();
  const csv1 = await get(before.port, CSV_URL, cookie);
  const zip1 = await get(before.port, ZIP_URL, cookie);
  check(csv1.status === 200, `phase 3: the CSV downloads before the restart (got ${csv1.status})`);
  check(zip1.status === 200, `phase 3: the HQ bundle downloads before the restart (got ${zip1.status})`);
  check(csv1.body.length > 0 && zip1.body.length > 0, 'phase 3: both downloads have a body');
  check(
    /Durable Advertiser 1/.test(csv1.body.toString('utf8')),
    'phase 3: the CSV really contains the job\'s stored leads',
  );

  // THE RESTART. SIGKILL, so nothing gets a chance to flush anything to disk —
  // whatever the next process serves came out of the database.
  await stopServer(before.child);

  const after = await startServer();
  const csv2 = await get(after.port, CSV_URL, cookie);
  const zip2 = await get(after.port, ZIP_URL, cookie);
  check(csv2.status === 200, `phase 3: the CSV still downloads after the restart (got ${csv2.status})`);
  check(zip2.status === 200, `phase 3: the HQ bundle still downloads after the restart (got ${zip2.status})`);
  // `=== 200` is part of the assertion, not decoration: two identical 404
  // bodies also hash the same, so without it this passes for a download that
  // is broken in both directions. (Found by mutating the route back to reading
  // the filesystem — the byte-identity check went green on a pair of 404s.)
  check(
    csv1.status === 200 && csv2.status === 200 && hash(csv1.body) === hash(csv2.body),
    `phase 3: the CSV is BYTE-IDENTICAL across the restart (${hash(csv1.body).slice(0, 12)} vs ${hash(csv2.body).slice(0, 12)})`,
  );
  check(
    zip1.status === 200 && zip2.status === 200 && hash(zip1.body) === hash(zip2.body),
    `phase 3: the HQ bundle is BYTE-IDENTICAL across the restart (${hash(zip1.body).slice(0, 12)} vs ${hash(zip2.body).slice(0, 12)})`,
  );
  check(
    csv1.headers['content-disposition'] === csv2.headers['content-disposition'],
    'phase 3: the download filename is unchanged too',
  );
  await stopServer(after.child);
} catch (err) {
  bad(`durability gate aborted: ${err.message}`);
} finally {
  await cluster.stop();
}

console.log(failed === 0 ? '\nDURABILITY: all proofs hold' : `\nDURABILITY: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
