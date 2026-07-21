#!/usr/bin/env node
/**
 * Smoke test for the proxy-traffic monitor (artifacts/api-server/dist/proxyTraffic.js).
 *
 * Two modes:
 *   node scripts/smoke-proxy-traffic.mjs          — mocked-network battery (no key needed, hermetic)
 *   node scripts/smoke-proxy-traffic.mjs --live   — one real call to the Proxy-Seller API
 *                                                   (requires PROXY_SELLER_API_KEY in the shell)
 *
 * The mocked battery exercises the FULL fetch path (checkProxyTrafficBeforeJob /
 * logProxyTrafficAfterJob) by stubbing global.fetch — it validates gate verdicts,
 * log wording, fail-open behavior, burn reporting, renewal handling, and key redaction.
 */

const LIVE = process.argv.includes('--live');
const GB = 1024 ** 3;

// The module freezes env at import time — set BEFORE the dynamic import.
if (!LIVE) {
  process.env.PROXY_SELLER_API_KEY = 'SMOKEKEY_abc123_SMOKEKEY';
  process.env.PROXY_TRAFFIC_WARN_GB = '1';
  process.env.PROXY_TRAFFIC_ABORT_GB = '0.05';
}

const m = await import('../artifacts/api-server/dist/proxyTraffic.js');

// ── live mode ────────────────────────────────────────────────────────────────
if (LIVE) {
  if (!m.isTrafficMonitorConfigured()) {
    console.log('❌ PROXY_SELLER_API_KEY is not set in THIS shell.');
    console.log('   Run from the Replit Shell tab after a workspace restart, or in the deployment.');
    process.exit(1);
  }
  const log = (lvl, msg) => console.log(`[${lvl}] ${msg}`);
  const snap = await m.checkProxyTrafficBeforeJob(log);
  if (snap) {
    console.log(`\n✅ live snapshot: ${JSON.stringify(snap)}`);
    const gb = snap.remainingBytes / GB;
    if (gb < 0.001 || gb > 100_000) {
      console.log('⚠️  remaining looks implausible — suspect a units mismatch; report this number.');
      process.exit(1);
    }
  } else {
    console.log('\n⚠️  fail-open (null): key rejected, API down, or response reshaped — see warn above.');
    process.exit(1);
  }
  process.exit(0);
}

// ── mocked battery ───────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const check = (cond, desc) => (cond ? passed++ : failures.push(`FAIL: ${desc}`));

const jsonRes = (body, status = 200, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  redirected: false,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  body: { cancel: async () => {} },
  json: async () => body,
});
const collect = () => {
  const lines = [];
  return { lines, log: (lvl, msg) => lines.push(`[${lvl}] ${msg}`) };
};
const healthy = { status: 'success', data: { traffic_limit: 10 * GB, traffic_usage: 2 * GB, expired_at: '2026-08-21' } };

// 1-3: healthy → ok verdict, info line, snapshot returned
{
  global.fetch = async () => jsonRes(healthy);
  const { lines, log } = collect();
  const snap = await m.checkProxyTrafficBeforeJob(log);
  check(!!snap && snap.remainingBytes === 8 * GB, 'healthy: snapshot remaining = 8 GB');
  check(lines.some((l) => l.startsWith('[info]') && l.includes('8.00 GB of 10.00 GB remaining')), 'healthy: info line with balance');
  check(lines.some((l) => l.includes('package active until 2026-08-21')), 'healthy: expiry shown');
}

// 4-5: low → warn verdict with threshold in message, job still allowed
{
  global.fetch = async () => jsonRes({ data: { traffic_limit: 10 * GB, traffic_usage: 9.5 * GB } });
  const { lines, log } = collect();
  const snap = await m.checkProxyTrafficBeforeJob(log);
  check(!!snap, 'low: job still allowed (snapshot returned)');
  check(lines.some((l) => l.startsWith('[warn]') && l.includes('LOW')), 'low: warn line emitted');
}

// 6-7: exhausted → throws ProxyTrafficExhaustedError, message < 200 chars
{
  global.fetch = async () => jsonRes({ data: { traffic_limit: 10 * GB, traffic_usage: 10 * GB - 1024 } });
  const { log } = collect();
  let err = null;
  try {
    await m.checkProxyTrafficBeforeJob(log);
  } catch (e) {
    err = e;
  }
  check(err?.name === 'ProxyTrafficExhaustedError', 'exhausted: throws ProxyTrafficExhaustedError');
  check(!!err && err.message.length < 200 && err.message.includes('exhausted'), 'exhausted: message short + clear');
}

// 8-9: HTTP 500 → fail-open null + warn mentioning status
{
  global.fetch = async () => jsonRes(null, 500);
  const { lines, log } = collect();
  const snap = await m.checkProxyTrafficBeforeJob(log);
  check(snap === null, 'HTTP 500: fail-open null');
  check(lines.some((l) => l.includes('HTTP 500')), 'HTTP 500: status in warn line');
}

// 10-11: network error → fail-open null + warn; key redacted from message
{
  global.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND proxy-seller.com https://proxy-seller.com/x/SMOKEKEY_abc123_SMOKEKEY/y');
  };
  const { lines, log } = collect();
  const snap = await m.checkProxyTrafficBeforeJob(log);
  check(snap === null, 'net error: fail-open null');
  check(lines.some((l) => l.includes('unreachable')) && !lines.some((l) => l.includes('SMOKEKEY_abc123_SMOKEKEY')), 'net error: warn present, key REDACTED');
}

// 12: non-Error rejection (throw-proof catch)
{
  global.fetch = async () => {
    throw 'plain string rejection';
  };
  const { log } = collect();
  check((await m.checkProxyTrafficBeforeJob(log)) === null, 'non-Error rejection: fail-open null (no crash)');
}

// 13-14: garbage JSON shape → null + debug raw dump with key redacted
{
  global.fetch = async () => jsonRes({ status: 'error', errors: [{ key: 'SMOKEKEY_abc123_SMOKEKEY' }] });
  const { lines, log } = collect();
  check((await m.checkProxyTrafficBeforeJob(log)) === null, 'garbage shape: fail-open null');
  const debugLine = lines.find((l) => l.startsWith('[debug]'));
  check(!!debugLine && !debugLine.includes('SMOKEKEY_abc123_SMOKEKEY') && debugLine.includes('***'), 'garbage shape: raw dump redacts key');
}

// 15: HTML body (real-world invalid-key behavior: 200 + text/html homepage)
// → fail-open with the explicit "key likely invalid" diagnostic
{
  global.fetch = async () => ({
    ...jsonRes(null, 200, 'text/html; charset=utf-8'),
    redirected: true,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  });
  const { lines, log } = collect();
  const snap = await m.checkProxyTrafficBeforeJob(log);
  check(
    snap === null && lines.some((l) => l.startsWith('[warn]') && l.includes('instead of JSON') && l.includes('after a redirect') && l.includes('invalid/revoked')),
    'HTML-instead-of-JSON: fail-open null + invalid-key diagnostic',
  );
}

// 15b: content-type claims JSON but the body is broken → old json-throw fail-open path
{
  global.fetch = async () => ({
    ...jsonRes(null),
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  });
  const { lines, log } = collect();
  check((await m.checkProxyTrafficBeforeJob(log)) === null && lines.some((l) => l.startsWith('[warn]')), 'broken JSON body: fail-open null + warn');
}

// 15c: real error envelope (observed live) → reason surfaced at warn level
{
  global.fetch = async () =>
    jsonRes({ status: 'error', data: null, errors: [{ message: 'Error api key', code: 503 }, { message: 'IP not allowed 1.2.3.4', code: 503 }] });
  const { lines, log } = collect();
  const snap = await m.checkProxyTrafficBeforeJob(log);
  check(
    snap === null && lines.some((l) => l.startsWith('[warn]') && l.includes('Error api key') && l.includes('IP not allowed 1.2.3.4')),
    'API error envelope: reason surfaced in warn line',
  );
}

// 16-17: burn report — normal usage delta
{
  let call = 0;
  global.fetch = async () => jsonRes(call++ === 0 ? healthy : { data: { traffic_limit: 10 * GB, traffic_usage: 2 * GB + 300 * 1024 ** 2, expired_at: '2026-08-21' } });
  const { lines, log } = collect();
  const before = await m.checkProxyTrafficBeforeJob(log);
  await m.logProxyTrafficAfterJob(before, log);
  check(lines.some((l) => l.includes('this job used 300.0 MB')), 'burn report: correct MB delta');
  check(lines.some((l) => l.includes('7.71 GB remaining')), 'burn report: post-job remaining shown');
}

// 18: burn report — package renewed mid-job (negative delta)
{
  let call = 0;
  global.fetch = async () => jsonRes(call++ === 0 ? { data: { traffic_limit: 10 * GB, traffic_usage: 9 * GB } } : { data: { traffic_limit: 10 * GB, traffic_usage: 0 } });
  const { lines, log } = collect();
  const before = await m.checkProxyTrafficBeforeJob(log);
  await m.logProxyTrafficAfterJob(before, log);
  check(lines.some((l) => l.includes('renewed mid-job')), 'burn report: renewal detected on negative delta');
}

// 19: burn report is a silent no-op when the before-snapshot was null
{
  let fetches = 0;
  global.fetch = async () => {
    fetches++;
    return jsonRes(healthy);
  };
  const { lines, log } = collect();
  await m.logProxyTrafficAfterJob(null, log);
  check(fetches === 0 && lines.length === 0, 'null before-snapshot: burn report no-ops without fetching');
}

console.log(`proxy-traffic smoke: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  ' + f);
process.exit(failures.length === 0 ? 0 : 1);
