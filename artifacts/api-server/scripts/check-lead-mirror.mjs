#!/usr/bin/env node
/**
 * Mirror-drift gate for the custom lead-count validator.
 *
 * `parseCustomLeadCount` / `LEAD_LIMIT_CUSTOM_MAX` exist TWICE — once in
 * api-server/src/csv.ts (the authority) and once in dashboard/src/api/client.ts,
 * because the dashboard is a separate workspace package that mirrors shared
 * constants (same pattern as LEAD_LIMIT_CHOICES and countries.ts) rather than
 * importing across the boundary.
 *
 * A "keep these in sync" comment cannot enforce anything. This runs BOTH
 * implementations over the same inputs and fails when they disagree, so a form
 * that silently accepts a number the server would reject (or vice versa) is
 * caught by the test gate instead of by a user.
 *
 * Run standalone, or via `npm test` which invokes it after the unit suites.
 */
import { readFileSync } from 'node:fs';
const srv = await import('/home/runner/workspace/artifacts/api-server/dist/csv.js');

// The dashboard is TS/ESM for the browser; extract and eval its two mirrored
// definitions rather than bundling the whole client.
const src = readFileSync('/home/runner/workspace/artifacts/dashboard/src/api/client.ts', 'utf8');
const maxM = src.match(/export const LEAD_LIMIT_CUSTOM_MAX = ([\d_]+);/);
const fnM = src.match(/export function parseCustomLeadCount\(raw: string\): number \| null \{[\s\S]*?\n\}/);
if (!maxM || !fnM) { console.log('✗ could not locate the mirrored definitions in client.ts'); process.exit(1); }
const js = fnM[0].replace(/: string/g, '').replace(/: number \| null/g, '').replace('export ', '');
const LEAD_LIMIT_CUSTOM_MAX = Number(maxM[1].replace(/_/g, ''));
const uiParse = new Function('LEAD_LIMIT_CUSTOM_MAX', `${js}; return parseCustomLeadCount;`)(LEAD_LIMIT_CUSTOM_MAX);

let fails = 0;
if (LEAD_LIMIT_CUSTOM_MAX !== srv.LEAD_LIMIT_CUSTOM_MAX) {
  console.log(`✗ MAX drift: server=${srv.LEAD_LIMIT_CUSTOM_MAX} ui=${LEAD_LIMIT_CUSTOM_MAX}`); fails++;
} else console.log(`✓ LEAD_LIMIT_CUSTOM_MAX matches (${LEAD_LIMIT_CUSTOM_MAX})`);

const cases = ['', '   ', '0', '-5', '1', '7', '20', '007', '250', '2.5', 'abc', '1e3', '12a', '+7',
  '99999', '100000', '100001', '999999999999999999999', ' 75 ', '\t42\n'];
let mism = 0;
for (const c of cases) {
  const a = srv.parseCustomLeadCount(c), b = uiParse(c);
  if (a !== b) { console.log(`✗ drift on ${JSON.stringify(c)}: server=${a} ui=${b}`); mism++; }
}
mism === 0 ? console.log(`✓ both parsers agree on all ${cases.length} inputs`) : fails++;
console.log(fails === 0 ? '\nMIRROR: in sync' : `\nMIRROR: ${fails} problem(s)`);
process.exit(fails ? 1 : 0);
