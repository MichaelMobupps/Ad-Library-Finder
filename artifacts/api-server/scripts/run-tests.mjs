#!/usr/bin/env node
/**
 * Repo test runner.
 *
 * This codebase has no vitest/jest — each module ships its own offline
 * `runXTests()` and self-executes it behind an `isMain` guard, so a module's
 * suite runs as `node dist/<module>.js`. That works one module at a time, which
 * meant the tests gate in apply.sh found no `test` script and silently skipped.
 * This runner makes the gate real: it runs every self-testing module and exits
 * non-zero if any of them fails.
 *
 * Modules are DISCOVERED, not hardcoded: any src/*.ts exporting a
 * `run<Name>Tests` function (sync or async) is picked up automatically, so a new
 * module with tests is covered the moment it lands. Modules whose suites need the network
 * are listed in NETWORK_MODULES and skipped by default (pass --all to include).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

/** Suites that reach the network or a real browser — not part of the gate. */
const NETWORK_MODULES = new Set(['proxyTraffic', 'storePageFetcher']);

const includeAll = process.argv.includes('--all');

if (!existsSync(DIST)) {
  console.error(`✗ dist/ not found at ${DIST} — run \`npm run build\` first.`);
  process.exit(1);
}

const modules = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .filter((f) => /^export (?:async )?function run[A-Za-z0-9]*Tests\b/m.test(readFileSync(path.join(SRC, f), 'utf8')))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort();

const selected = modules.filter((m) => includeAll || !NETWORK_MODULES.has(m));
const skipped = modules.filter((m) => !selected.includes(m));

let totalPassed = 0;
let totalFailed = 0;
const failedModules = [];
const missing = [];

for (const m of selected) {
  const js = path.join(DIST, `${m}.js`);
  if (!existsSync(js)) {
    missing.push(m);
    continue;
  }
  // cwd = ROOT so modules resolving cwd-relative paths (data/, csv-output/)
  // behave exactly as they do under `node dist/<module>.js`.
  const res = spawnSync(process.execPath, [js], { cwd: ROOT, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  const counts = out.match(/(\d+) passed, (\d+) failed/);
  if (counts) {
    totalPassed += Number(counts[1]);
    totalFailed += Number(counts[2]);
  }
  if (res.status === 0) {
    console.log(`  ✓ ${m}${counts ? ` (${counts[1]} assertions)` : ''}`);
  } else {
    failedModules.push(m);
    console.log(`  ✗ ${m}`);
    for (const line of out.split('\n')) console.log(`      ${line}`);
  }
}

console.log('');
if (missing.length) {
  console.log(`! not built (skipped): ${missing.join(', ')}`);
}
if (skipped.length) {
  console.log(`! network suites (run with --all): ${skipped.join(', ')}`);
}
console.log(
  `${failedModules.length === 0 ? '✓' : '✗'} ${selected.length - missing.length} modules, ` +
    `${totalPassed} assertions passed, ${totalFailed} failed`,
);

// Storage-seam source gate: the sqlite file stays banned from server code, no
// storage write is left unawaited, and no shipped migration is destructive.
// Static — it reads the source and the built migrations, and touches no
// database at all — so it runs first and fails fast.
const seam = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-storage-seam.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (seam.status === 0) {
  for (const line of `${seam.stdout || ''}`.trim().split('\n')) {
    if (line.trim()) console.log(line);
  }
} else {
  console.log('  ✗ STORAGE SEAM BROKEN');
  for (const line of `${seam.stdout || ''}${seam.stderr || ''}`.trim().split('\n')) console.log(`      ${line}`);
  failedModules.push('storage-seam');
}

// Fast-lane gate: needs a REAL database, so it builds its own ephemeral
// PostgreSQL cluster (scripts/pgtest.mjs) and deletes it afterwards. It used to
// need a throwaway cwd instead, because db.ts resolved data/ relative to the
// working directory; since order L-3.4g there is no such file to escape from.
const fastLane = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-fast-lane.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (fastLane.status === 0) {
  console.log('  ✓ fast lane (provisional publisher ↔ full rollup) invariants hold');
} else {
  console.log('  ✗ fast lane INVARIANTS BROKEN');
  for (const line of `${fastLane.stdout || ''}${fastLane.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('fast-lane');
}

// Durability gate: the claims order L-3.4g actually makes, proved across REAL
// process boundaries — state survives a restart, the rescue seed is idempotent,
// a download link answers byte-identically before and after a SIGKILL restart,
// and the server refuses to boot without a database. Builds its own ephemeral
// clusters; never starts the queue, so nothing scrapes and no mail is sent.
const durability = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-durability.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (durability.status === 0) {
  console.log('  ✓ durability (restart persistence, seed idempotency, stable downloads, boot refusal)');
} else {
  console.log('  ✗ DURABILITY PROOFS BROKEN');
  for (const line of `${durability.stdout || ''}${durability.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('durability');
}

// L-3.4g smoke: both modes on separate ports against ephemeral clusters, with
// the runner disabled. Pins the property the whole order exists for — the
// rescued chief job answers over the seam EXACTLY as the live deployment did,
// compared against the recorded fixture rather than a hand-written expectation
// — plus byte-identical baseline probes across modes and a download that
// survives a real restart. Kept in the gate rather than run by hand, because a
// smoke nobody runs is a smoke that rots.
const smoke = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke-l34g.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (smoke.status === 0) {
  console.log('  ✓ L-3.4g smoke (seam parity with live, both modes, downloads across a restart)');
} else {
  console.log('  ✗ L-3.4g SMOKE BROKEN');
  for (const line of `${smoke.stdout || ''}${smoke.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('smoke-l34g');
}

// L-3.5a smoke: outbound spend reporting, both modes, ephemeral clusters, a
// fake Chief on loopback and nothing leaving the machine. Pins the properties
// the order exists for — quanta per UTC day, an idempotent id across retries, a
// restart that reports nothing twice, a 4xx that latches off loudly, and the
// agreement between the status card's UTC figure and the quanta actually
// posted. Also proves migration 002 applies to an already-migrated database,
// which is the case that had never been exercised before this order.
const smokeSpend = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke-l35a.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (smokeSpend.status === 0) {
  console.log('  ✓ L-3.5a smoke (spend quanta, idempotent retries, restart safety, 4xx latch, status agreement)');
} else {
  console.log('  ✗ L-3.5a SMOKE BROKEN');
  for (const line of `${smokeSpend.stdout || ''}${smokeSpend.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('smoke-l35a');
}

// Cross-package mirror gate: constants/validators duplicated into the dashboard
// must behave identically to the server's copy. A unit suite cannot see across
// the package boundary, so this runs as its own step.
const mirror = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-lead-mirror.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (mirror.status === 0) {
  console.log('  ✓ lead-cap mirror (dashboard ↔ server) in sync');
} else {
  console.log('  ✗ lead-cap mirror OUT OF SYNC');
  for (const line of `${mirror.stdout || ''}${mirror.stderr || ''}`.trim().split('\n')) console.log(`      ${line}`);
  failedModules.push('lead-cap-mirror');
}

// Form CSS gate: a broad selector must not silently resize a form control that
// was added to the container later (see check-form-css.mjs for the shipped bug
// this pins). Static scan of the dashboard stylesheet — no browser needed.
const formCss = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-form-css.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (formCss.status === 0) {
  console.log('  ✓ form CSS (no control silently resized by a broad selector)');
} else {
  console.log('  ✗ form CSS GATE BROKEN');
  for (const line of `${formCss.stdout || ''}${formCss.stderr || ''}`.trim().split('\n')) console.log(`      ${line}`);
  failedModules.push('form-css');
}

// Legacy-address gate: boots the real Express assembly in both modes and pins
// the redirect STATUS CODE, method preservation, the loop guard and the
// open-redirect refusals over real HTTP. A pure-function test cannot see a
// `res.redirect(302, …)` edit; this can. Each mode runs in its own throwaway
// cwd (the script does that itself) and never starts the queue.
const legacy = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-legacy-redirects.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (legacy.status === 0) {
  for (const line of `${legacy.stdout || ''}`.trim().split('\n')) {
    if (line.trim()) console.log(`  ✓ ${line}`);
  }
} else {
  console.log('  ✗ LEGACY ADDRESS SURVIVAL BROKEN');
  for (const line of `${legacy.stdout || ''}${legacy.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('legacy-redirects');
}

// Country-catalog mirror gate: the chief surface REFUSES any country outside
// its catalog, and that catalog is a mirror of the dashboard's. A drift would
// make the Chief unable to command a country the form offers.
const countries = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-country-mirror.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (countries.status === 0) {
  console.log('  ✓ supported-country catalog (dashboard ↔ chief surface) in sync');
} else {
  console.log('  ✗ COUNTRY CATALOG OUT OF SYNC');
  for (const line of `${countries.stdout || ''}${countries.stderr || ''}`.trim().split('\n')) console.log(`      ${line}`);
  failedModules.push('country-mirror');
}

// Source-matrix mirror gate: which (source, target) pairs this app can run, and
// which engine each is, lives in ONE table that both the human route and the
// machine surface read. The dashboard cannot import it, so it carries the same
// mapping in an expression of its own. Drift here is what made the Chief's first
// commanded discovery come back 400 (order L-3.3c).
const sourceMatrix = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-source-matrix.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (sourceMatrix.status === 0) {
  console.log('  ✓ source × target matrix (dashboard ↔ server) in sync');
} else {
  console.log('  ✗ SOURCE MATRIX OUT OF SYNC');
  for (const line of `${sourceMatrix.stdout || ''}${sourceMatrix.stderr || ''}`.trim().split('\n')) console.log(`      ${line}`);
  failedModules.push('source-matrix');
}

// Chief machine-surface gate: boots the real assembly in four env modes and
// pins the token/cookie separation in both directions, the indistinguishable
// 401, the status contract, every create refusal, idempotency under a race,
// human-job invisibility, the paging bounds and the no-email guarantee. A pure
// unit test cannot see an auth middleware mounted in the wrong order; this can.
const chiefSurface = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-chief-surface.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (chiefSurface.status === 0) {
  for (const line of `${chiefSurface.stdout || ''}`.trim().split('\n')) {
    if (line.trim()) console.log(`  ✓ ${line}`);
  }
} else {
  console.log('  ✗ CHIEF MACHINE SURFACE BROKEN');
  for (const line of `${chiefSurface.stdout || ''}${chiefSurface.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('chief-surface');
}

// OAuth redirect-URI gate: PUBLIC_BASE_URL must be authoritative when set, and
// the header derivation must stay frozen when it is not. PUBLIC_URL is resolved
// at module load, so each env combination is its own booted child process.
const oauth = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-oauth-redirect-uri.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (oauth.status === 0) {
  for (const line of `${oauth.stdout || ''}`.trim().split('\n')) {
    if (line.trim()) console.log(`  ✓ ${line}`);
  }
} else {
  console.log('  ✗ OAUTH REDIRECT URI DERIVATION BROKEN');
  for (const line of `${oauth.stdout || ''}${oauth.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('oauth-redirect-uri');
}

if (failedModules.length > 0) {
  console.error(`✗ failing modules: ${failedModules.join(', ')}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error('✗ some test modules were not built — run `npm run build`.');
  process.exit(1);
}
process.exit(0);
