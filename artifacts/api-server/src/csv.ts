import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
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

/** Lead-count choices offered in the UI. null ⇒ "as many as found". */
export const LEAD_LIMIT_CHOICES = [20, 50, 100] as const;

/**
 * Normalize a caller-supplied lead cap to one of the offered choices or null.
 *
 * Deliberately permissive about the VALUE (any positive integer is honoured, so
 * ops can pass 250 via the API) but strict about the TYPE: anything non-numeric,
 * zero or negative becomes null = uncapped, because silently exporting 0 leads
 * would look identical to "the search found nothing".
 */
export function normalizeMaxLeads(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export interface BuildCsvInput {
  jobId: string;
  productType: ProductType;
  results: JobResultRow[];
  /** Cap on exported rows; null/omitted = every row found. */
  maxRows?: number | null;
}

/**
 * The rows a job actually exports: product-type filter, then the operator's lead
 * cap. Shared so the CSV and the per-HQ-country Excel bundle export the SAME set —
 * capping only inside buildCsv would ship a 20-row CSV beside a 300-row Excel.
 *
 * The cap is applied AFTER filtering, so "20 leads" means 20 usable rows, not 20
 * candidates of which some lacked a store URL and vanished.
 */
export function selectExportRows(
  results: JobResultRow[],
  productType: ProductType,
  maxRows?: number | null,
): JobResultRow[] {
  const filtered =
    productType === 'mobile'
      ? results.filter(
          (r) =>
            (r.classification === 'mobile_google_play' || r.classification === 'mobile_app_store') && r.store_url,
        )
      : results.filter((r) => r.classification === 'cps_web' && r.landing_url);
  return maxRows != null && maxRows > 0 ? filtered.slice(0, maxRows) : filtered;
}

export function buildCsv(input: BuildCsvInput): { path: string; rowsWritten: number } {
  if (!existsSync(CSV_DIR)) mkdirSync(CSV_DIR, { recursive: true });

  const { jobId, productType, results } = input;

  let header: string;
  let rows: string[];

  if (productType === 'mobile') {
    const mobile = selectExportRows(results, 'mobile', input.maxRows);

    // Header MUST use "store_url" — Email Prospector's CSV ingest auto-detects
    // the store-URL column by header name. Its accepted aliases are:
    //   store_link, store link, market_url, store_url, play_store,
    //   app_store_link, itunes_link, google_play_link, app_url.
    // "preview_url" is NOT in that list. Both the Affplus pipeline and the
    // Meta scraper feed EP through this same writer, so both benefit.
    //
    // app_category / is_game are appended ONLY when at least one included row was
    // enriched (GATC mobile jobs). Meta / Affplus / AppGoblin leave these NULL, so
    // their CSVs keep the exact original 5-column shape — no cross-pipeline drift.
    // EP keys on header names it recognizes and ignores the extra columns.
    const enriched = mobile.some((r) => r.app_category != null || r.is_game != null);
    if (enriched) {
      header = 'advertiser_name,country,store_url,store,app_category,is_game,ad_text';
      rows = mobile.map((r) =>
        [
          escapeFreeText(r.advertiser_name),
          escapeCsv(r.country),
          escapeCsv(r.store_url),
          escapeCsv(r.classification === 'mobile_google_play' ? 'google_play' : 'app_store'),
          escapeFreeText(r.app_category),
          escapeCsv(r.is_game == null ? '' : r.is_game ? 'true' : 'false'),
          escapeFreeText(r.ad_text),
        ].join(',')
      );
    } else {
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
    }
  } else {
    // CPS: web destinations only.
    const cps = selectExportRows(results, 'cps', input.maxRows);
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
  // Atomic write: some pipelines (Google Ads) now rebuild this file repeatedly
  // WHILE the job runs, and the download route may serve it at any moment.
  // Write to a temp sibling then rename so a concurrent reader never sees a
  // truncated/partial file (rename is atomic within the same directory).
  const tmp = `${fpath}.tmp-${process.pid}`;
  writeFileSync(tmp, csv, 'utf8');
  renameSync(tmp, fpath);

  return { path: fpath, rowsWritten: rows.length };
}
// ─────────────────────────────────────────────────────────────
// Self-tests (deterministic; no DB, no filesystem). Exercises the
// CSV-escaping and formula-injection guards only.
// ─────────────────────────────────────────────────────────────

export function runCsvUnitTests(): { passed: number; failed: number; failures: string[] } {
  // (lead-cap assertions are appended at the end of this function)
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

  // ── Lead cap: N means N USABLE rows, and it must not change what qualifies ──
  const mk = (n: number, cls: string, store: string | null, land: string | null): JobResultRow =>
    ({ id: n, job_id: 'j', advertiser_name: `A${n}`, page_url: null, landing_url: land,
       classification: cls, store_url: store, ad_text: null, country: 'US', created_at: 0,
       app_category: null, is_game: null } as JobResultRow);
  // Two of these four mobile rows are unusable (no store_url).
  const mixed = [
    mk(1, 'mobile_google_play', 'https://play.google.com/store/apps/details?id=a', null),
    mk(2, 'mobile_google_play', null, null),
    mk(3, 'mobile_app_store', 'https://apps.apple.com/app/id2', null),
    mk(4, 'cps_web', null, 'https://x.com'),
  ];
  check(selectExportRows(mixed, 'mobile').length === 2, 'cap: uncapped mobile keeps only rows with a store url');
  check(selectExportRows(mixed, 'mobile', 1).length === 1, 'cap: mobile cap of 1 yields exactly 1');
  check(
    selectExportRows(mixed, 'mobile', 2).length === 2,
    'cap: cap applies AFTER the filter — 2 usable rows, not 2 candidates of which one was dropped',
  );
  check(selectExportRows(mixed, 'mobile', 99).length === 2, 'cap: a cap above supply returns everything available');
  check(selectExportRows(mixed, 'cps').length === 1, 'cap: cps keeps only web rows');
  check(selectExportRows(mixed, 'mobile', null).length === 2, 'cap: null = as many as found');
  check(selectExportRows(mixed, 'mobile', 0).length === 2, 'cap: 0 is uncapped, never an empty export');
  // normalizeMaxLeads is the single gate on operator input.
  check(normalizeMaxLeads(20) === 20 && normalizeMaxLeads('50') === 50, 'cap: numbers and numeric strings honored');
  check(normalizeMaxLeads(null) === null && normalizeMaxLeads(undefined) === null, 'cap: absent → uncapped');
  check(normalizeMaxLeads(0) === null && normalizeMaxLeads(-3) === null, 'cap: 0/negative → uncapped');
  check(normalizeMaxLeads('abc') === null && normalizeMaxLeads({}) === null, 'cap: junk → uncapped');
  check(LEAD_LIMIT_CHOICES.join(',') === '20,50,100', 'cap: offered choices are 20/50/100 (+ as many as found)');

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
