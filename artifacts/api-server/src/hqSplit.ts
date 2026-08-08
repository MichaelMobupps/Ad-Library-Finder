/**
 * HQ-split orchestrator. Runs AFTER the mobile job's CSV is written.
 *
 * Pipeline:
 *   1. Read job_results that landed in the CSV (i.e. classification was
 *      mobile_google_play or mobile_app_store AND store_url is present).
 *   2. For each result:
 *        a. lookupHqCache(store_url) — if hit, use it (zero LLM cost).
 *        b. else: fetchStorePage(store_url) → resolveHq(page) → storeHqCache.
 *   3. Bucket results by ResolvedHq.primary_market. Empty / missing →
 *      "Unknown".
 *   4. For each bucket: build an .xlsx workbook with all existing job_results
 *      columns plus the resolved HQ columns. Excel-safe sheet name, country
 *      slug filename.
 *   5. Bundle all workbooks into one .zip under job-zips/<job_id>_by_hq.zip.
 *
 * Concurrency: serial. Each LLM call is ~1-3 sec; jobs we care about have
 * tens to a few hundred rows. A bounded pool can be added if a real job ever
 * exceeds ~5 min on this phase.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { JobResultRow } from './db.js';
import { resolveHq, type ResolvedHq } from './hqResolver.js';
import { fetchStorePage } from './storePageFetcher.js';
import { lookupHqCache, storeHqCache, ensureHqCacheTable } from './hqCache.js';
import { buildXlsx } from './xlsxWriter.js';
import { buildZip, type ZipEntry } from './zipWriter.js';
import { log } from './logger.js';
import { BudgetExceededError } from './llmBudget.js';

const ZIP_DIR = path.resolve('csv-output', 'hq-zips');

const COUNTRY_TO_ISO2: Record<string, string> = {
  'united states': 'US', 'usa': 'US', 'us': 'US',
  'united kingdom': 'UK', 'uk': 'UK', 'great britain': 'UK',
  japan: 'JP', china: 'CN', spain: 'ES', russia: 'RU', 'south korea': 'KR',
  germany: 'DE', france: 'FR', italy: 'IT', brazil: 'BR', mexico: 'MX',
  india: 'IN', indonesia: 'ID', vietnam: 'VN', thailand: 'TH', turkey: 'TR',
  israel: 'IL', singapore: 'SG', malaysia: 'MY', philippines: 'PH', nigeria: 'NG',
  'united arab emirates': 'AE', uae: 'AE',
  'saudi arabia': 'SA', egypt: 'EG', argentina: 'AR', colombia: 'CO', chile: 'CL',
  poland: 'PL', netherlands: 'NL', sweden: 'SE', norway: 'NO', finland: 'FI',
  denmark: 'DK', austria: 'AT', switzerland: 'CH', belgium: 'BE', portugal: 'PT',
  ukraine: 'UA', 'south africa': 'ZA', kenya: 'KE', australia: 'AU',
  'new zealand': 'NZ', 'hong kong': 'HK', taiwan: 'TW',
  canada: 'CA',
};

export function countryToFilenameSlug(country: string | null | undefined): string {
  if (!country || !country.trim()) return 'Unknown';
  const norm = country.trim().toLowerCase();
  if (COUNTRY_TO_ISO2[norm]) return COUNTRY_TO_ISO2[norm];
  // Fall back to a path-safe form of the full name.
  return country.trim().replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'Unknown';
}

export interface HqSplitOutcome {
  zipPath: string | null;
  perCountryCounts: Record<string, number>;
  unresolvedCount: number;
  totalRowsConsidered: number;
  cacheHits: number;
  llmCalls: number;
  storeFetchFailures: number;
  /** True when storeFetch / Play returned a blocking signal. Operator alerted. */
  playBlocked: boolean;
}

interface SplitOptions {
  jobId: string;
  results: JobResultRow[];
  onLog: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
}

export const MOBILE_HQ_HEADER = [
  'advertiser_name',
  'country', // the geo the ad was scraped in
  'store_url',
  'store',
  'ad_text',
  'classification',
  'page_url',
  'landing_url',
  'resolved_hq_country', // the HQ country (Layer 2/3-corrected)
  'resolved_company',
  'resolved_parent',
  'resolved_corporate_domain',
  'resolve_source', // llm | cctld | script
  'resolve_reasoning',
];

export function mobileHqRow(r: JobResultRow, hq: ResolvedHq | null): (string | number | null)[] {
  const storeLabel =
    r.classification === 'mobile_google_play' ? 'google_play' :
    r.classification === 'mobile_app_store' ? 'app_store' : '';
  return [
    r.advertiser_name || '',
    r.country || '',
    r.store_url || '',
    storeLabel,
    r.ad_text || '',
    r.classification || '',
    r.page_url || '',
    r.landing_url || '',
    hq?.primary_market || '',
    hq?.company_name || '',
    hq?.parent_company || '',
    hq?.corporate_domain || '',
    hq?.override_source || '',
    hq?.reasoning || '',
  ];
}

/**
 * Main entrypoint. Reads results, resolves each one's HQ (cache-aware),
 * buckets, emits per-country .xlsx files into a single .zip. Returns the
 * zip path or null if there were no mobile results to split.
 */
export async function runHqSplit(opts: SplitOptions): Promise<HqSplitOutcome> {
  await ensureHqCacheTable();

  if (!existsSync(ZIP_DIR)) mkdirSync(ZIP_DIR, { recursive: true });

  // Keep only mobile rows with a store URL.
  const mobile = opts.results.filter(
    (r) =>
      (r.classification === 'mobile_google_play' || r.classification === 'mobile_app_store') &&
      r.store_url
  );

  const outcome: HqSplitOutcome = {
    zipPath: null,
    perCountryCounts: {},
    unresolvedCount: 0,
    totalRowsConsidered: mobile.length,
    cacheHits: 0,
    llmCalls: 0,
    storeFetchFailures: 0,
    playBlocked: false,
  };

  if (mobile.length === 0) {
    opts.onLog('info', 'hq-split: no mobile rows to split');
    return outcome;
  }

  const bucketed: Record<string, Array<{ result: JobResultRow; hq: ResolvedHq | null }>> = {};

  for (let i = 0; i < mobile.length; i++) {
    const r = mobile[i];
    const storeUrl = r.store_url!;

    let hq: ResolvedHq | null = await lookupHqCache(storeUrl);
    if (hq) {
      outcome.cacheHits++;
      opts.onLog('debug', `hq-split: cache hit for ${storeUrl} → ${hq.primary_market || 'Unknown'}`);
    } else {
      // Cache miss — fetch the store page, then resolve.
      const page = await fetchStorePage(storeUrl);
      if (!page.ok) {
        outcome.storeFetchFailures++;
        opts.onLog('warn', `hq-split: store-page fetch failed for ${storeUrl} — ${page.fetchNote}`);
        if (page.platform === 'android' && /HTTP (429|403)/.test(page.fetchNote)) {
          outcome.playBlocked = true;
        }
        // Even on a degraded fetch, we still try the resolver — it will fall
        // back to whatever fields are populated (advertiser_name + URL hints).
        // The resolver may produce something useful via the script-detection layer.
        page.appName = page.appName || r.advertiser_name || '';
        page.publisherName = page.publisherName || r.advertiser_name || '';
      }
      try {
        hq = await resolveHq(page);
        outcome.llmCalls++;
        await storeHqCache(storeUrl, hq);
        opts.onLog(
          'debug',
          `hq-split: resolved ${storeUrl} → company="${hq.company_name}" market="${hq.primary_market}" via ${hq.override_source}`
        );
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        opts.onLog('error', `hq-split: resolveHq threw for ${storeUrl} — ${(err as Error).message}`);
        hq = null;
      }
    }

    const bucketKey = (hq?.primary_market || '').trim() || 'Unknown';
    if (!bucketed[bucketKey]) bucketed[bucketKey] = [];
    bucketed[bucketKey].push({ result: r, hq });

    if ((i + 1) % 10 === 0 || i === mobile.length - 1) {
      opts.onLog(
        'info',
        `hq-split: progress ${i + 1}/${mobile.length} (cache=${outcome.cacheHits}, llm=${outcome.llmCalls}, fetch-fail=${outcome.storeFetchFailures})`
      );
    }
  }

  // Build one xlsx per bucket.
  const zipEntries: ZipEntry[] = [];
  for (const [country, items] of Object.entries(bucketed)) {
    const slug = countryToFilenameSlug(country);
    const filename = `${slug}.xlsx`;
    const rows: (string | number | null)[][] = [MOBILE_HQ_HEADER, ...items.map((it) => mobileHqRow(it.result, it.hq))];
    const xlsxBuf = buildXlsx({ name: slug.slice(0, 31), rows });
    zipEntries.push({ path: filename, data: xlsxBuf });
    outcome.perCountryCounts[country] = items.length;
    if (country === 'Unknown') outcome.unresolvedCount = items.length;
  }

  // Also include a small manifest for the operator.
  const manifestLines = [
    `HQ split manifest for job ${opts.jobId}`,
    `Generated: ${new Date().toISOString()}`,
    `Total mobile rows considered: ${outcome.totalRowsConsidered}`,
    `Cache hits: ${outcome.cacheHits}`,
    `LLM calls: ${outcome.llmCalls}`,
    `Store-page fetch failures: ${outcome.storeFetchFailures}`,
    `Per-country row counts:`,
    ...Object.entries(outcome.perCountryCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([c, n]) => `  ${countryToFilenameSlug(c)}  (${c})  ${n}`),
  ];
  zipEntries.push({ path: 'manifest.txt', data: manifestLines.join('\n') + '\n' });

  const zipBuf = buildZip(zipEntries);
  const zipPath = path.join(ZIP_DIR, `${opts.jobId}_by_hq.zip`);
  writeFileSync(zipPath, zipBuf);
  outcome.zipPath = zipPath;
  opts.onLog(
    'info',
    `hq-split: wrote ${zipPath} (${zipEntries.length - 1} country files + manifest, ${zipBuf.length} bytes)`
  );

  log.info(`hq-split done for ${opts.jobId}: ${JSON.stringify(outcome.perCountryCounts)}`);
  return outcome;
}

// ─────────────────────────────────────────────────────────────
// Unit tests for the pure pieces (countryToFilenameSlug). Resolver
// itself has its own port-fidelity tests.
// ─────────────────────────────────────────────────────────────

export function runHqSplitUnitTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
  const cases: Array<[string | null, string]> = [
    ['United States', 'US'],
    ['Japan', 'JP'],
    ['Brazil', 'BR'],
    ['Taiwan', 'TW'],
    ['', 'Unknown'],
    [null, 'Unknown'],
    ['some weird name', 'some_weird_name'],
  ];
  for (const [input, expected] of cases) {
    const got = countryToFilenameSlug(input);
    if (got === expected) passed++;
    else failures.push(`countryToFilenameSlug(${JSON.stringify(input)}) = ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('hqSplit.js') || process.argv[1].endsWith('hqSplit.ts'));
if (isMain) {
  const { passed, failed, failures } = runHqSplitUnitTests();
  console.log(`hqSplit unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}