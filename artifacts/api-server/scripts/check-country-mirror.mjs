#!/usr/bin/env node
/**
 * Mirror-drift gate for the supported-country catalog.
 *
 * The list exists TWICE — once in `dashboard/src/countries.ts` (what the human
 * New Job form offers) and once as `SUPPORTED_COUNTRIES` in
 * `api-server/src/chief.ts` (what the machine surface will accept) — because the
 * dashboard is a separate workspace package that mirrors shared constants rather
 * than importing across the boundary. Same pattern, and the same reason, as
 * check-lead-mirror.mjs.
 *
 * Why it matters more here than for a form: the human POST /api/jobs only
 * shape-checks that a code is two letters, so a human can already ask for a
 * country the catalog does not list. The chief surface REFUSES anything outside
 * the catalog, so a drifted list is the difference between the Chief being able
 * to command a country and getting a 400 it cannot explain. A "keep these in
 * sync" comment enforces nothing; this does.
 *
 * Run standalone, or via `npm test`, which invokes it after the unit suites.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { SUPPORTED_COUNTRIES } = await import(`${ROOT}/dist/chief.js`);

// The dashboard file is browser TS; read the codes out of the literal rather
// than bundling a UI module into a server-side gate.
const src = readFileSync(path.resolve(ROOT, '../dashboard/src/countries.ts'), 'utf8');
const start = src.indexOf('export const COUNTRIES');
const end = src.indexOf('const BY_CODE');
if (start === -1 || end === -1 || end < start) {
  console.log('✗ could not locate the COUNTRIES literal in dashboard/src/countries.ts');
  process.exit(1);
}
const uiCodes = [...src.slice(start, end).matchAll(/code:\s*'([A-Z]{2})'/g)].map((m) => m[1]);

let fails = 0;
if (uiCodes.length === 0) {
  console.log('✗ the dashboard catalog parsed as empty — the gate would pass vacuously');
  process.exit(1);
}

const srvSet = new Set(SUPPORTED_COUNTRIES);
const uiSet = new Set(uiCodes);

if (uiCodes.length !== uiSet.size) {
  console.log(`✗ the dashboard catalog has duplicates (${uiCodes.length} entries, ${uiSet.size} unique)`);
  fails++;
}
if (SUPPORTED_COUNTRIES.length !== srvSet.size) {
  console.log(`✗ the server catalog has duplicates (${SUPPORTED_COUNTRIES.length} entries, ${srvSet.size} unique)`);
  fails++;
}

const missingOnServer = uiCodes.filter((c) => !srvSet.has(c));
const extraOnServer = SUPPORTED_COUNTRIES.filter((c) => !uiSet.has(c));
if (missingOnServer.length) {
  console.log(`✗ offered by the form, refused by the chief surface: ${missingOnServer.join(', ')}`);
  fails++;
}
if (extraOnServer.length) {
  console.log(`✗ accepted by the chief surface, unknown to the form: ${extraOnServer.join(', ')}`);
  fails++;
}

// Order is not load-bearing, but an identical order makes a diff readable and
// costs nothing to keep.
if (!fails && SUPPORTED_COUNTRIES.join(',') !== uiCodes.join(',')) {
  console.log('✗ same codes, different order — keep the two lists in the same order');
  fails++;
}

if (!fails) {
  console.log(`✓ supported-country catalog in sync (${uiCodes.length} codes, same order)`);
}
console.log(fails === 0 ? 'COUNTRY MIRROR: in sync' : `COUNTRY MIRROR: ${fails} problem(s)`);
process.exit(fails ? 1 : 0);
