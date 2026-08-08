#!/usr/bin/env node
/**
 * Legacy-address survival gate.
 *
 * Boots the REAL Express assembly (dist/app.js — the same buildApp() index.ts
 * calls) in both modes and asserts, over real HTTP, the properties an emailed
 * link depends on after the cutover:
 *
 *   - the redirect is 307. Not 308/301 (permanent and cacheable, so a cached
 *     entry would outlive an env-unset rollback and bounce clients to a path
 *     that no longer exists), and not 302 (licenses a POST to become a GET).
 *   - the method survives it, so a machine caller is not silently downgraded.
 *   - the query survives it byte-for-byte.
 *   - exactly one hop, and the target never redirects again.
 *   - no legacy path, and no target derived from one, can leave this origin,
 *     leave the mount, or produce the doubled slash that answers 200
 *     index.html instead of the file or the 401.
 *   - with the prefix unset, the legacy layer does not exist at all.
 *
 * Why it boots rather than unit-testing the decision function: the decision is
 * pure and already unit-tested, but `res.redirect(302, to)` is a one-character
 * edit away from silently downgrading every one of those links. A gate that
 * cannot see the wire cannot see that.
 *
 * SAFETY: startQueue() is never called (buildApp() does not start it), so no
 * scraper runs and no email is sent; each mode runs in its own throwaway cwd,
 * so db.ts's `path.resolve('data')` makes a fresh sqlite file and the real
 * database is never opened; the listener binds 127.0.0.1 on an EPHEMERAL port.
 *
 * Run standalone:  node artifacts/api-server/scripts/check-legacy-redirects.mjs
 * or via `npm test`, which invokes it after the unit suites.
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { startCluster, assertEphemeral } from './pgtest.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const PREFIX = '/leadfinder';

// ── parent: run both modes as children, because BASE_PATH is read at import ──
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
if (!mode) {
  let failed = 0;
  const cluster = await startCluster('legacy');
  for (const [m, env] of [
    ['dark', {}],
    ['lit', { BASE_PATH: `${PREFIX}/`, PUBLIC_BASE_URL: `https://tools.mobupps.net${PREFIX}` }],
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), `legacy-${m}-`));
    // Strip inherited values so DARK is genuinely unset even in a workspace
    // whose own env carries PUBLIC_BASE_URL (this one does).
    const childEnv = { ...process.env };
    delete childEnv.BASE_PATH;
    delete childEnv.PUBLIC_BASE_URL;
    childEnv.DATABASE_URL = cluster.createDatabase(`legacy_${m.replace(/-/g, '_')}`);
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--mode=${m}`], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...childEnv, ...env },
    });
    rmSync(dir, { recursive: true, force: true });
    for (const line of `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n')) {
      if (!/^\[\d{4}-/.test(line) && line.trim()) console.log(line);
    }
    if (res.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

// ── child ────────────────────────────────────────────────────────────────────
const LIT = mode === 'lit';
let passed = 0;
const failures = [];
const check = (cond, desc) => (cond ? passed++ : failures.push(`FAIL [${mode}] ${desc}`));

assertEphemeral(process.env.DATABASE_URL);
const { closeDatabase } = await import(`${DIST}/sql.js`);
const { initDb, upsertUserByEmail, createSession, createJob, setJobCsvPath, setJobHqZipPath, getDb } =
  await import(`${DIST}/db.js`);
const { buildApp } = await import(`${DIST}/app.js`);
const urls = await import(`${DIST}/urls.js`);

await initDb();
const user = await upsertUserByEmail('gate@mobupps.com', 'Gate');
const session = await createSession(user.id, 30 * 24 * 3600 * 1000);
const job = await createJob({ id: 'job_GATE000001', productType: 'mobile', countries: ['US'], createdByUserId: user.id });
mkdirSync('files', { recursive: true });
const CSV_BYTES = 'advertiser,country\nACME,US\n';
const csvFile = path.resolve('files', 'leads_job_GATE000001.csv');
writeFileSync(csvFile, CSV_BYTES);
await setJobCsvPath(job.id, csvFile);
const zipFile = path.resolve('files', 'hq_split_job_GATE000001.zip');
writeFileSync(zipFile, 'PKgate');
await setJobHqZipPath(job.id, zipFile);

const app = buildApp();
const srv = await new Promise((r) => {
  const s = app.listen(0, '127.0.0.1', () => r(s));
});
const PORT = srv.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function req(method, target, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, method, path: target, headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location ?? null,
            type: (res.headers['content-type'] || '').split(';')[0],
            disposition: res.headers['content-disposition'] ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    r.on('error', reject);
    r.end();
  });
}

/** RFC 6265 §5.1.4 path-match — the reason a legacy path is always anonymous. */
const pathMatches = (cookiePath, reqPath) =>
  reqPath === cookiePath ||
  (reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/'));

/** Walk a redirect chain the way a browser does, cookie jar and all. */
async function browserWalk(method, target, holdsSession) {
  const hops = [];
  let m = method;
  let t = target;
  for (let i = 0; i < 6; i++) {
    const p = t.split('?')[0];
    const send = holdsSession && pathMatches(urls.COOKIE_PATH, p);
    const res = await req(m, t, send ? `${urls.SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}` : undefined);
    hops.push({ method: m, target: t, sentCookie: send, res });
    if (res.status >= 300 && res.status < 400 && res.location) {
      // 307/308 keep the method; 301/302 let a browser rewrite POST to GET.
      if (res.status === 302 || res.status === 301 || res.status === 303) m = 'GET';
      const abs = new URL(res.location, ORIGIN);
      if (abs.origin !== ORIGIN) {
        hops.push({ offOrigin: abs.origin });
        break;
      }
      t = abs.pathname + abs.search;
      continue;
    }
    break;
  }
  return hops;
}

const CSV_LEGACY = `/api/jobs/${job.id}/csv`;
const ZIP_LEGACY = `/api/jobs/${job.id}/hq-zip`;

if (!LIT) {
  // ── DARK: the legacy layer must not exist. Not "agree with today" — absent. ──
  check(urls.SESSION_COOKIE_NAME === 'als_session', 'DARK cookie name is als_session');
  check(urls.COOKIE_PATH === '/', 'DARK cookie Path is /');
  for (const [m, t] of [['GET', '/'], ['GET', CSV_LEGACY], ['GET', ZIP_LEGACY], ['GET', '/version'], ['GET', '/api/health'], ['POST', CSV_LEGACY]]) {
    const res = await req(m, t);
    check(!(res.status >= 300 && res.status < 400), `${m} ${t} does not redirect (got ${res.status})`);
  }
  const root = await req('GET', '/');
  check(root.status === 200 && root.type === 'text/html', 'DARK root still serves the SPA');
  const anon = await req('GET', CSV_LEGACY);
  check(anon.status === 401, 'DARK anonymous download is still 401');
  const auth = await req('GET', CSV_LEGACY, `als_session=${encodeURIComponent(session.token)}`);
  check(auth.status === 200 && auth.body === CSV_BYTES, 'DARK authenticated download still serves the file');
} else {
  // ── LIT: the legacy addresses survive, on the stated terms ──
  check(urls.SESSION_COOKIE_NAME === 'lf_session', 'LIT cookie name is lf_session');
  check(urls.COOKIE_PATH === `${PREFIX}/`, 'LIT cookie Path is the mount');
  check(!pathMatches(urls.COOKIE_PATH, CSV_LEGACY), 'the session cookie is NOT sent to a legacy path (this is why the redirect must precede auth)');

  // 1. THE status code, on every legacy shape and every method.
  for (const t of ['/', CSV_LEGACY, ZIP_LEGACY]) {
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await req(m, t);
      check(res.status === 307, `${m} ${t} -> 307 (got ${res.status})`);
      check(res.status !== 308 && res.status !== 301, `${m} ${t} is not a cacheable permanent redirect`);
      check(res.status !== 302, `${m} ${t} is not a 302`);
      check(res.location === `${PREFIX}${t === '/' ? '/' : t}`, `${m} ${t} -> ${PREFIX}${t} (got ${res.location})`);
    }
  }
  check(urls.LEGACY_REDIRECT_STATUS === 307, 'the pinned constant is 307');

  // 2. The query survives byte-for-byte, including hostile shapes.
  for (const q of ['?product=cps', '?a=1&b=2', '?next=//evil.com', '?a=%2F%2Fevil.com', '?e=%C3%A9&f=a+b']) {
    const res = await req('GET', `${CSV_LEGACY}${q}`);
    check(res.status === 307, `query ${q}: 307`);
    check(res.location === `${PREFIX}${CSV_LEGACY}${q}`, `query ${q} preserved exactly (got ${res.location})`);
    const abs = new URL(res.location, ORIGIN);
    check(abs.origin === ORIGIN, `query ${q}: target stays on this origin`);
    check(abs.pathname.startsWith(`${PREFIX}/`), `query ${q}: target stays under the mount`);
  }

  // 3. Method preservation, proved by the DIFFERENCE at the far end rather than
  //    asserted: carrying a session, a GET reaches the download route (200 +
  //    file bytes) while a POST reaches a path with no POST route (404). Had the
  //    307 been a 302, the POST would have arrived as a GET and answered 200.
  //    (Both must be walked WITH the session: the /api/jobs mount runs
  //    requireAuth before it routes, so anonymous makes every method look alike.)
  const postWalk = await browserWalk('POST', CSV_LEGACY, true);
  check(postWalk.length === 2, `POST legacy link: exactly one hop (got ${postWalk.length - 1})`);
  check(postWalk[1]?.method === 'POST', 'POST arrives at the prefixed path still a POST');
  check(postWalk[1]?.res.status === 404, `a POST to the prefixed download path 404s (got ${postWalk[1]?.res.status})`);
  const getWalk = await browserWalk('GET', CSV_LEGACY, true);
  check(getWalk[1]?.res.status === 200, 'the same path as a GET serves the file — the two methods are distinguishable');

  // 4. Loop guard: one hop, and the target does not redirect again.
  for (const t of ['/', CSV_LEGACY, ZIP_LEGACY, `${CSV_LEGACY}?product=cps`, PREFIX]) {
    const hops = await browserWalk('GET', t, true);
    const redirects = hops.filter((h) => h.res && h.res.status >= 300 && h.res.status < 400).length;
    check(redirects <= 1, `${t}: at most one redirect in the chain (got ${redirects})`);
    check(!hops.some((h) => h.offOrigin), `${t}: never leaves this origin`);
    // "Terminates" means the chain stops redirecting — not that the far end is a
    // success. `?product=cps` on a mobile job with no stored results legitimately
    // ends at 404, and that is a terminated chain.
    const last = hops[hops.length - 1];
    check(
      last.res && !(last.res.status >= 300 && last.res.status < 400),
      `${t}: the chain terminates (last ${last.res?.status})`,
    );
  }

  // 5. THE END-TO-END CASE. A months-old emailed CSV link, clicked by someone
  //    holding a valid PREFIXED session: the cookie is not sent to the legacy
  //    path, is sent after the redirect, and the file comes back.
  const clicked = await browserWalk('GET', CSV_LEGACY, true);
  check(clicked[0].sentCookie === false, 'hop 1 (legacy path) carries no cookie');
  check(clicked[0].res.status === 307, 'hop 1 is the 307');
  check(clicked[1]?.sentCookie === true, 'hop 2 (prefixed path) carries the session cookie');
  check(clicked[1]?.res.status === 200, `hop 2 serves 200 (got ${clicked[1]?.res.status})`);
  check(clicked[1]?.res.body === CSV_BYTES, 'hop 2 returns the real file bytes');
  check(/attachment; filename=/.test(clicked[1]?.res.disposition || ''), 'hop 2 is an attachment, not a page');
  check(clicked[1]?.res.type !== 'text/html', 'hop 2 is NOT the SPA page');

  const zipClicked = await browserWalk('GET', ZIP_LEGACY, true);
  check(zipClicked[1]?.res.status === 200 && zipClicked[1]?.res.body === 'PKgate', 'the HQ-split link serves its bytes too');

  // 6. The same click while signed out: an auth challenge, not a loop.
  const anon = await browserWalk('GET', CSV_LEGACY, false);
  check(anon.length === 2, 'anonymous click: exactly one hop');
  check(anon[1]?.res.status === 401, `anonymous click ends at 401 (got ${anon[1]?.res.status})`);
  check(anon[1]?.res.type === 'application/json', 'anonymous click ends at the API auth challenge');
  const anonRoot = await browserWalk('GET', '/', false);
  check(anonRoot[1]?.res.status === 200 && anonRoot[1]?.res.type === 'text/html', 'anonymous old root lands on the login-capable SPA');

  // 7. THE DOUBLED-SLASH DEFECT, asserted at every legacy sink. No legacy path
  //    and no target derived from one may answer 200 text/html for a download.
  const doubtful = [
    CSV_LEGACY, ZIP_LEGACY, `${CSV_LEGACY}?product=cps`,
    `//api/jobs/${job.id}/csv`, `/api//jobs/${job.id}/csv`, `/api/jobs//csv`,
    `/api/jobs/${job.id}//csv`, `${CSV_LEGACY}/`, `/API/JOBS/${job.id}/CSV`,
  ];
  for (const t of doubtful) {
    const hops = await browserWalk('GET', t, true);
    const last = hops[hops.length - 1].res;
    check(!(last.status === 200 && last.type === 'text/html'), `${t}: never answers 200 index.html`);
    for (const h of hops) {
      if (h.res?.location) {
        const abs = new URL(h.res.location, ORIGIN);
        check(!abs.pathname.includes('//'), `${t}: no doubled slash in the redirect target (${abs.pathname})`);
      }
    }
  }

  // 8. Open-redirect sweep: a hostile legacy path may not aim the Location
  //    anywhere but this origin, under this mount.
  for (const t of [
    `/api/jobs/..%2F..%2F..%2Fevil.com/csv`,
    `/api/jobs/%2F%2Fevil.com/csv`,
    `/api/jobs/..%5Cevil.com/csv`,
    `/api/jobs/../csv`,
    `/api/jobs/x/csv?next=https://evil.com`,
    `/?next=//evil.com`,
    `/?a=b%23//evil.com`,
  ]) {
    const res = await req('GET', t);
    if (res.location === null) { passed++; continue; }
    const abs = new URL(res.location, ORIGIN);
    check(abs.origin === ORIGIN, `${t}: Location stays on this origin (got ${abs.origin})`);
    check(abs.pathname.startsWith(`${PREFIX}/`), `${t}: Location stays under the mount (got ${abs.pathname})`);
    check(!res.location.startsWith('//'), `${t}: Location is not protocol-relative`);
    check(!/[\r\n]/.test(res.location), `${t}: Location has no CR/LF`);
  }

  // 9. Machine callers get a real mount, not a redirect.
  for (const t of ['/version', '/api/health']) {
    const legacy = await req('GET', t);
    const prefixed = await req('GET', `${PREFIX}${t}`);
    check(legacy.status === 200, `${t} legacy mount answers 200 (got ${legacy.status})`);
    check(legacy.type === 'application/json', `${t} legacy mount answers JSON`);
    check(legacy.location === null, `${t} is a mount, not a redirect — senders that ignore 3xx still work`);
    check(prefixed.status === 200, `${PREFIX}${t} still answers 200`);
  }

  // 10. Everything NOT on the legacy list still 404s — the layer is a list, not
  //     a catch-all that would give every endpoint a second name.
  for (const t of ['/api/me', '/api/jobs', '/api/settings', '/some/deep/link', '/assets/index-abc.js', '/leadfinderX']) {
    const res = await req('GET', t);
    check(res.status === 404, `${t} still 404s (got ${res.status})`);
  }

  // 11. The bare-prefix redirect is the same 307, and still cannot loop.
  const bare = await req('GET', PREFIX);
  check(bare.status === 307, `bare prefix -> 307 (got ${bare.status})`);
  check(bare.location === `${PREFIX}/`, 'bare prefix -> the trailing-slash form');
  const bareWalk = await browserWalk('GET', PREFIX, true);
  check(bareWalk.length === 2 && bareWalk[1].res.status === 200, 'bare prefix reaches the app in one hop');
}

// ── the client half, executed on the REAL module ────────────────────────────
// dashboard/src/config.ts is the SPA's own copy of these rules and ships in the
// bundle. It is compiled here the way Vite compiles it — `import.meta.env.BASE_URL`
// substituted with the build-time base — and its offMountRedirect() is executed,
// rather than a copy of the three lines being re-asserted.
{
  const ts = (await import(`${ROOT}/node_modules/typescript/lib/typescript.js`)).default;
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(path.resolve(ROOT, '../dashboard/src/config.ts'), 'utf8');
  const base = LIT ? `${PREFIX}/` : '/';
  const js = ts.transpileModule(
    src.replace(
      /\(import\.meta as unknown as \{ env\?: \{ BASE_URL\?: string \} \}\)\.env\?\.BASE_URL \?\? '\/'/,
      JSON.stringify(base),
    ),
    // removeComments: the doc comments legitimately mention import.meta.env, and
    // the point of the check below is that no such expression survives in CODE.
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } },
  ).outputText;
  const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  check(!/import\.meta/.test(js), 'the client module compiled with the base substituted, as Vite does');
  check(mod.BASE_PATH === (LIT ? PREFIX : '/'), `client BASE_PATH is ${LIT ? PREFIX : '/'}`);

  if (!LIT) {
    // Inert. Not "agrees with today" — unreachable.
    for (const p of ['/', '/api/jobs/x/csv', '/leadfinder/', '/anything']) {
      check(mod.offMountRedirect(p) === null, `DARK client: no redirect from ${p}`);
      check(mod.offMountRedirect(p, '?a=1', '#/jobs/x') === null, `DARK client: no redirect from ${p} with query+hash`);
    }
  } else {
    check(mod.offMountRedirect('/') === `${PREFIX}/`, 'client: the old root moves to the mount');
    check(
      mod.offMountRedirect('/', '?a=1', '#/jobs/abc') === `${PREFIX}/?a=1#/jobs/abc`,
      'client: query AND fragment survive — the fragment is the emailed job link',
    );
    check(mod.offMountRedirect(`${PREFIX}/`) === null, 'client: already at the mount, no redirect');
    check(mod.offMountRedirect(PREFIX) === null, 'client: the bare mount does not redirect');
    check(mod.offMountRedirect(`${PREFIX}/jobs/x`) === null, 'client: a page under the mount does not redirect');
    check(mod.offMountRedirect(`${PREFIX}X/`) === `${PREFIX}/`, 'client: a prefix lookalike is not treated as inside');
    // One hop: the target itself never redirects.
    for (const p of ['/', '/old/path', `${PREFIX}X/`]) {
      const t = mod.offMountRedirect(p, '?a=1', '#h');
      const landed = new URL(t, 'https://self.example.com');
      check(landed.origin === 'https://self.example.com', `client: ${p} stays on this origin`);
      check(landed.pathname === `${PREFIX}/`, `client: ${p} lands exactly on the mount`);
      check(mod.offMountRedirect(landed.pathname) === null, `client: no second hop from ${p}`);
      check(!t.startsWith('//'), `client: ${p} target is not protocol-relative`);
    }
    // A hostile query or fragment cannot move the target off-origin.
    for (const [s, h] of [['?next=//evil.com', ''], ['', '#//evil.com'], ['?a=b', '#/../..'], ['?x=https://evil.com', '#@evil.com']]) {
      const t = mod.offMountRedirect('/', s, h);
      const landed = new URL(t, 'https://self.example.com');
      check(landed.origin === 'https://self.example.com', `client: ${s}${h} stays on this origin`);
      check(landed.pathname === `${PREFIX}/`, `client: ${s}${h} lands on the mount`);
    }
  }
}

srv.close();
await closeDatabase();

console.log(`legacy-redirects [${mode}]: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
