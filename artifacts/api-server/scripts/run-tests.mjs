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

import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

// Fast-lane gate: needs a REAL sqlite database, so it runs in a throwaway cwd
// (db.ts resolves data/ relative to the working directory) — that keeps the
// dev database untouched while still exercising the actual rollup/merge code.
const flDir = mkdtempSync(path.join(tmpdir(), 'fastlane-'));
const fastLane = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-fast-lane.mjs')], {
  cwd: flDir,
  encoding: 'utf8',
});
rmSync(flDir, { recursive: true, force: true });
if (fastLane.status === 0) {
  console.log('  ✓ fast lane (provisional publisher ↔ full rollup) invariants hold');
} else {
  console.log('  ✗ fast lane INVARIANTS BROKEN');
  for (const line of `${fastLane.stdout || ''}${fastLane.stderr || ''}`.trim().split('\n')) {
    if (!/^\[\d{4}-/.test(line)) console.log(`      ${line}`);
  }
  failedModules.push('fast-lane');
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
