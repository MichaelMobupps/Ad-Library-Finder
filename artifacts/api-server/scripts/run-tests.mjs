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
 * `run<Name>Tests` function is picked up automatically, so a new module with
 * tests is covered the moment it lands. Modules whose suites need the network
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
  .filter((f) => /^export function run[A-Za-z0-9]*Tests\b/m.test(readFileSync(path.join(SRC, f), 'utf8')))
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

if (failedModules.length > 0) {
  console.error(`✗ failing modules: ${failedModules.join(', ')}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error('✗ some test modules were not built — run `npm run build`.');
  process.exit(1);
}
process.exit(0);
