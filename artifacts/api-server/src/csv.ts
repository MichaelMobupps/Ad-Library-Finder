import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { JobResultRow, ProductType } from './db.js';

const CSV_DIR = path.resolve('csv-output');

function escapeCsv(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  // RFC4180: wrap in quotes if contains comma, quote, or newline; escape quotes by doubling
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * CSV formula-injection guard (CWE-1236). A cell whose first character is one
 * of = + - @ or a leading tab/CR is interpreted as a formula by Excel and
 * Google Sheets when the file is opened, so scraped free-text (advertiser
 * name, ad copy) could execute (e.g. =HYPERLINK / =cmd|...). Prefixing a
 * single quote forces the cell to be read as text.
 *
 * Applied ONLY to human-facing free-text columns. URL and country columns are
 * left verbatim because the Email Prospector ingest reads them by exact value
 * and they are already constrained (validated store/website URLs, ISO country
 * codes), so they are not a formula-injection vector.
 */
export function neutralizeFormula(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

/** Free-text column: neutralize formulas first, then RFC4180-escape. */
function escapeFreeText(v: string | null | undefined): string {
  return escapeCsv(neutralizeFormula(v));
}

export interface BuildCsvInput {
  jobId: string;
  productType: ProductType;
  results: JobResultRow[];
}

export function buildCsv(input: BuildCsvInput): { path: string; rowsWritten: number } {
  if (!existsSync(CSV_DIR)) mkdirSync(CSV_DIR, { recursive: true });

  const { jobId, productType, results } = input;

  let header: string;
  let rows: string[];

  if (productType === 'mobile') {
    // Only include results that have a store_url (Google Play or App Store).
    const mobile = results.filter(
      (r) =>
        (r.classification === 'mobile_google_play' || r.classification === 'mobile_app_store') &&
        r.store_url
    );

    // Header MUST use "store_url" — Email Prospector's CSV ingest auto-detects
    // the store-URL column by header name. Its accepted aliases are:
    //   store_link, store link, market_url, store_url, play_store,
    //   app_store_link, itunes_link, google_play_link, app_url.
    // "preview_url" is NOT in that list. Both the Affplus pipeline and the
    // Meta scraper feed EP through this same writer, so both benefit.
    header = 'advertiser_name,country,store_url,store,ad_text';
    rows = mobile.map((r) =>
      [
        escapeFreeText(r.advertiser_name),
        escapeCsv(r.country),
        escapeCsv(r.store_url),
        escapeCsv(r.classification === 'mobile_google_play' ? 'google_play' : 'app_store'),
        escapeFreeText(r.ad_text),
      ].join(',')
    );
  } else {
    // CPS: web destinations only.
    const cps = results.filter((r) => r.classification === 'cps_web' && r.landing_url);
    header = 'advertiser_name,country,website_url,ad_text';
    rows = cps.map((r) =>
      [
        escapeFreeText(r.advertiser_name),
        escapeCsv(r.country),
        escapeCsv(r.landing_url),
        escapeFreeText(r.ad_text),
      ].join(',')
    );
  }

  const csv = [header, ...rows].join('\n') + '\n';
  const fname = `${productType}-${jobId}.csv`;
  const fpath = path.join(CSV_DIR, fname);
  writeFileSync(fpath, csv, 'utf8');

  return { path: fpath, rowsWritten: rows.length };
}
// ─────────────────────────────────────────────────────────────
// Self-tests (deterministic; no DB, no filesystem). Exercises the
// CSV-escaping and formula-injection guards only.
// ─────────────────────────────────────────────────────────────

export function runCsvUnitTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // escapeCsv — RFC4180
  check(escapeCsv('plain') === 'plain', 'escapeCsv: plain passthrough');
  check(escapeCsv('a,b') === '"a,b"', 'escapeCsv: quote on comma');
  check(escapeCsv('a"b') === '"a""b"', 'escapeCsv: double the quote');
  check(escapeCsv('a\nb') === '"a\nb"', 'escapeCsv: quote on newline');
  check(escapeCsv(null) === '', 'escapeCsv: null -> empty');

  // neutralizeFormula — CWE-1236
  check(neutralizeFormula('=1+1') === "'=1+1", 'neutralize: equals prefixed');
  check(neutralizeFormula('+1') === "'+1", 'neutralize: plus prefixed');
  check(neutralizeFormula('-1') === "'-1", 'neutralize: minus prefixed');
  check(neutralizeFormula('@SUM(A1)') === "'@SUM(A1)", 'neutralize: at prefixed');
  check(neutralizeFormula('\t=1') === "'\t=1", 'neutralize: leading tab prefixed');
  check(neutralizeFormula('\r=1') === "'\r=1", 'neutralize: leading CR prefixed');
  check(neutralizeFormula('Acme Corp') === 'Acme Corp', 'neutralize: safe text untouched');
  check(neutralizeFormula('a=b') === 'a=b', 'neutralize: equals mid-string untouched');
  check(neutralizeFormula(null) === '', 'neutralize: null -> empty');

  // composed free-text guard: a malicious formula that also contains a comma
  // gets both neutralized AND quoted.
  const malicious = '=HYPERLINK("http://x"),2';
  const out = escapeCsv(neutralizeFormula(malicious));
  check(out.startsWith('"\'=HYPERLINK') && out.endsWith('"'), 'free-text guard: neutralized and quoted');

  return { passed, failed: failures.length, failures };
}

const isMainCsv =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('csv.js') || process.argv[1].endsWith('csv.ts'));
if (isMainCsv) {
  const { passed, failed, failures } = runCsvUnitTests();
  console.log(`csv: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
