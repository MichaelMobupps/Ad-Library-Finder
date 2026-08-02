#!/usr/bin/env node
/**
 * OAuth redirect-URI gate.
 *
 * Pins the property a live sign-in outage turned into a rule (H1): when
 * PUBLIC_BASE_URL is set, the redirect URI is PUBLIC_BASE_URL + the callback
 * path, on every request, whatever the proxy headers say — and when it is
 * unset, the header derivation behaves exactly as it always has, because that
 * is the rollback path.
 *
 * Why it boots rather than unit-testing a helper: PUBLIC_URL is resolved at
 * MODULE LOAD from the environment, so "set" and "unset" are two different
 * processes, not two arguments. Each env combination runs in its own child with
 * its own throwaway cwd, and the URI is read through the REAL sink — the
 * compiled getRedirectUriFromReq(), and over HTTP through
 * /api/auth/google/debug, which is the endpoint an operator will use to confirm
 * the fix in production.
 *
 * SAFETY: buildApp() never calls startQueue(), so no scraper runs and no email
 * is sent; no Google endpoint is contacted (nothing here exchanges a code); the
 * listener binds 127.0.0.1 on an ephemeral port; the real database is never
 * opened.
 *
 * Run standalone:  node artifacts/api-server/scripts/check-oauth-redirect-uri.mjs
 * or via `npm test`.
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const CALLBACK = '/api/auth/google/callback';
const GATEWAY_URI = 'https://tools.mobupps.net/leadfinder' + CALLBACK;

// The header shapes a request can arrive with. The first is what production
// actually sees behind the gateway, and is what broke sign-in.
const HEADER_CASES = [
  ['gateway -> .replit.app', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'ad-library-finder.replit.app', host: 'ad-library-finder.replit.app' }],
  ['forwards the original host', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'tools.mobupps.net', host: 'ad-library-finder.replit.app' }],
  ['no x-forwarded-* at all', { host: 'ad-library-finder.replit.app' }],
  ['multi-value x-forwarded-host', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example.com, tools.mobupps.net', host: 'ad-library-finder.replit.app' }],
  ['hostile Host header', { host: 'evil.example.com' }],
  ['hostile x-forwarded-host', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example.com', host: 'ad-library-finder.replit.app' }],
  ['no host headers at all', {}],
];

const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice(7);
if (!mode) {
  let failed = 0;
  for (const [m, env] of [
    ['lit', { BASE_PATH: '/leadfinder/', PUBLIC_BASE_URL: 'https://tools.mobupps.net/leadfinder' }],
    ['dark', {}],
    ['public-only', { PUBLIC_BASE_URL: 'https://leadfindermobupps.replit.app' }],
  ]) {
    const dir = mkdtempSync(path.join(tmpdir(), `oauth-${m}-`));
    const childEnv = { ...process.env };
    delete childEnv.BASE_PATH;
    delete childEnv.PUBLIC_BASE_URL;
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--mode=${m}`], {
      cwd: dir, encoding: 'utf8', env: { ...childEnv, ...env },
    });
    rmSync(dir, { recursive: true, force: true });
    for (const line of `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n')) {
      if (!/^\[\d{4}-/.test(line) && line.trim()) console.log(line);
    }
    if (res.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

let passed = 0;
const failures = [];
const check = (c, d) => (c ? passed++ : failures.push(`FAIL [${mode}] ${d}`));

const { initDb, getDb } = await import(`${DIST}/db.js`);
const { getRedirectUriFromReq } = await import(`${DIST}/oauth.js`);
const { buildApp } = await import(`${DIST}/app.js`);
const urls = await import(`${DIST}/urls.js`);

await initDb();
const app = buildApp();
const srv = await new Promise((r) => {
  const s = app.listen(0, '127.0.0.1', () => r(s));
});
const PORT = srv.address().port;
const DEBUG_PATH = `${urls.BASE_PATH === '/' ? '' : urls.BASE_PATH}/api/auth/google/debug`;

/** A minimal stand-in for the Express Request the real sink reads. */
const fakeReq = (headers) => ({
  headers,
  secure: headers['x-forwarded-proto'] === 'https',
  get: (h) => headers[h.toLowerCase()],
});

function debugUri(headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: DEBUG_PATH, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

if (mode === 'lit') {
  // THE FIX. One string, whatever the proxy says.
  check(urls.PUBLIC_URL === 'https://tools.mobupps.net/leadfinder', 'PUBLIC_URL resolved');
  const derived = new Set();
  for (const [label, headers] of HEADER_CASES) {
    const direct = getRedirectUriFromReq(fakeReq(headers));
    derived.add(direct);
    check(direct === GATEWAY_URI, `${label}: derives the canonical URI (got ${direct})`);
    check(!direct.includes('replit.app'), `${label}: never the deployment host`);
    check(!direct.includes('evil.example.com'), `${label}: a hostile header cannot move it`);
    const u = new URL(direct);
    check(u.protocol === 'https:', `${label}: https, never http`);
    check(u.origin === 'https://tools.mobupps.net', `${label}: our canonical origin`);
    check(u.pathname === `/leadfinder${CALLBACK}`, `${label}: path is prefix + callback exactly`);
    check(!u.pathname.includes('//'), `${label}: no doubled slash`);
  }
  check(derived.size === 1, `every header shape derives ONE string (got ${derived.size})`);

  // The same, over HTTP through the endpoint an operator will actually use.
  for (const [label, headers] of HEADER_CASES) {
    if (!headers.host) continue; // node always sends a Host over HTTP
    const j = await debugUri(headers);
    check(j.redirectUri === GATEWAY_URI, `${label} (over HTTP): ${j.redirectUri}`);
  }

  // Authorize step and token exchange must be the same string: both call this
  // sink, and it now reads no per-request input, so equality holds even when
  // the two requests arrive on different hosts — which is exactly what happens,
  // since the callback comes back through whatever URI Google was handed.
  const authorizeSide = getRedirectUriFromReq(fakeReq(HEADER_CASES[0][1]));
  const callbackSide = getRedirectUriFromReq(fakeReq(HEADER_CASES[1][1]));
  check(authorizeSide === callbackSide, 'authorize and token-exchange derive the identical string across different hosts');
  check(authorizeSide === GATEWAY_URI, 'and it is the registered URI');
} else if (mode === 'dark') {
  // ROLLBACK PATH — frozen. The header derivation, byte for byte as before.
  check(urls.PUBLIC_URL === '', 'PUBLIC_URL is empty');
  check(
    getRedirectUriFromReq(fakeReq(HEADER_CASES[0][1])) === 'https://ad-library-finder.replit.app/api/auth/google/callback',
    'unset: x-forwarded-host still wins',
  );
  check(
    getRedirectUriFromReq(fakeReq({ host: 'example.com' })) === 'http://example.com/api/auth/google/callback',
    'unset: falls back to the Host header, and to http:// without x-forwarded-proto',
  );
  check(
    getRedirectUriFromReq(fakeReq({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example.com, b.com', host: 'h' })) ===
      'https://evil.example.com/api/auth/google/callback',
    'unset: first value of a multi-value x-forwarded-host still wins, exactly as before',
  );
  let threw = false;
  try { getRedirectUriFromReq(fakeReq({})); } catch { threw = true; }
  check(threw, 'unset: no host at all still throws');
  const j = await debugUri({ host: `127.0.0.1:${PORT}` });
  check(j.redirectUri === `http://127.0.0.1:${PORT}/api/auth/google/callback`, `unset over HTTP: ${j.redirectUri}`);
  check(j.publicBaseUrlEnv === null, 'unset: the debug endpoint still reports a null env');
} else {
  // PUBLIC_BASE_URL set WITHOUT a prefix — the pre-cutover shape, and this
  // workspace's own env. Authoritative there too, by the same rule.
  check(urls.BASE_PATH === '/', 'no prefix');
  const uri = getRedirectUriFromReq(fakeReq(HEADER_CASES[0][1]));
  check(uri === 'https://leadfindermobupps.replit.app/api/auth/google/callback', `public-only: ${uri}`);
  check(!uri.includes('/leadfinder/api'), 'public-only: no prefix is added when BASE_PATH is unset');
  const j = await debugUri({ host: `127.0.0.1:${PORT}` });
  check(j.redirectUri === uri, 'public-only: HTTP and direct derivation agree');
}

srv.close();
getDb().close();

console.log(`oauth-redirect-uri [${mode}]: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
