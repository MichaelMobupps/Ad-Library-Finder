import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JobResultRow, ProductType } from './db.js';

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
        escapeCsv(r.advertiser_name),
        escapeCsv(r.country),
        escapeCsv(r.store_url),
        escapeCsv(r.classification === 'mobile_google_play' ? 'google_play' : 'app_store'),
        escapeCsv(r.ad_text),
      ].join(',')
    );
  } else {
    // CPS: web destinations only.
    const cps = results.filter((r) => r.classification === 'cps_web' && r.landing_url);
    header = 'advertiser_name,country,website_url,ad_text';
    rows = cps.map((r) =>
      [
        escapeCsv(r.advertiser_name),
        escapeCsv(r.country),
        escapeCsv(r.landing_url),
        escapeCsv(r.ad_text),
      ].join(',')
    );
  }

  const csv = [header, ...rows].join('\n') + '\n';
  const fname = `${productType}-${jobId}.csv`;
  const fpath = path.join(CSV_DIR, fname);
  writeFileSync(fpath, csv, 'utf8');

  return { path: fpath, rowsWritten: rows.length };
}