/**
 * Web/CPS HQ-split orchestrator. The mobile hqSplit.ts buckets app-store rows
 * by resolving the app's publisher HQ from the store page. This module does the
 * same for WEB (cps_web) rows — the leads that Google Ads Transparency surfaces
 * whose click destination is an advertiser website rather than an app store.
 *
 * HQ resolution for a web advertiser is cheaper than for an app: the destination
 * domain itself is the strongest signal. Order (cheapest first):
 *   1. ccTLD of the destination domain (foo.com.br → Brazil) — FREE, definitive.
 *   2. script markers in the advertiser name (腾讯 → China, מנטה → Israel) — FREE.
 *   3. LLM (resolveHq) with a synthesized store-page record — only when 1+2 miss
 *      (i.e. a .com/.net domain with a Latin name). Budgeted + cached by URL.
 *
 * Output mirrors hqSplit: one .xlsx per HQ country inside a single .zip, plus a
 * manifest. Non-fatal for the job on failure (the pipeline wraps it).
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { JobResultRow } from './db.js';
import {
  resolveHq,
  extractDomain,
  resolveTld,
  detectCountryFromScript,
  type ResolvedHq,
} from './hqResolver.js';
import type { StorePageInfo } from './storePageFetcher.js';
import { lookupHqCache, storeHqCache, ensureHqCacheTable } from './hqCache.js';
import { buildXlsx } from './xlsxWriter.js';
import { buildZip, type ZipEntry } from './zipWriter.js';
import { countryToFilenameSlug } from './hqSplit.js';
import { log } from './logger.js';
import { BudgetExceededError } from './llmBudget.js';

const ZIP_DIR = path.resolve('csv-output', 'hq-zips');

export interface WebHqSplitOutcome {
  zipPath: string | null;
  perCountryCounts: Record<string, number>;
  unresolvedCount: number;
  totalRowsConsidered: number;
  cacheHits: number;
  cctldHits: number;
  scriptHits: number;
  llmCalls: number;
}

interface SplitOptions {
  jobId: string;
  results: JobResultRow[];
  onLog: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
}

const HEADER = [
  'advertiser_name',
  'country', // geo the lead was tagged with (informational)
  'website_url',
  'ad_text',
  'classification',
  'page_url',
  'resolved_hq_country',
  'resolved_company',
  'resolved_parent',
  'resolved_corporate_domain',
  'resolve_source', // cctld | script | llm
  'resolve_reasoning',
];

function rowFromResult(r: JobResultRow, hq: ResolvedHq | null): (string | number | null)[] {
  return [
    r.advertiser_name || '',
    r.country || '',
    r.landing_url || '',
    r.ad_text || '',
    r.classification || '',
    r.page_url || '',
    hq?.primary_market || '',
    hq?.company_name || '',
    hq?.parent_company || '',
    hq?.corporate_domain || '',
    hq?.override_source || '',
    hq?.reasoning || '',
  ];
}

/**
 * Resolve HQ for one web advertiser. ccTLD and script are free short-circuits;
 * only a Latin-name .com-style domain reaches the (budgeted, cached) LLM.
 */
export async function resolveWebHq(
  websiteUrl: string,
  advertiserName: string,
  adText: string,
): Promise<ResolvedHq> {
  const domain = extractDomain(websiteUrl);

  // 1. ccTLD — definitive and free.
  const cctld = domain ? resolveTld(domain) : '';
  if (cctld) {
    return {
      company_name: advertiserName || domain,
      parent_company: '',
      corporate_domain: domain,
      primary_market: cctld,
      reasoning: `ccTLD of ${domain} maps to ${cctld}`,
      llm_market_raw: '',
      override_source: 'cctld',
    };
  }

  // 2. Script markers in the advertiser name — free.
  const script = detectCountryFromScript(advertiserName || '');
  if (script) {
    return {
      company_name: advertiserName || domain,
      parent_company: '',
      corporate_domain: domain,
      primary_market: script,
      reasoning: `script markers in "${advertiserName}" indicate ${script}`,
      llm_market_raw: '',
      override_source: 'script',
    };
  }

  // 3. LLM — synthesize a store-page-shaped record from what we have.
  const synthetic: StorePageInfo = {
    appName: advertiserName || domain,
    publisherName: advertiserName || domain,
    developerWebsite: websiteUrl,
    developerEmail: '',
    legalName: '',
    category: '',
    description: (adText || '').slice(0, 400),
    storeUrl: websiteUrl,
    platform: 'unknown',
    ok: !!(advertiserName || domain),
    fetchNote: '',
  };
  return resolveHq(synthetic);
}

export async function runHqSplitWeb(opts: SplitOptions): Promise<WebHqSplitOutcome> {
  ensureHqCacheTable();
  if (!existsSync(ZIP_DIR)) mkdirSync(ZIP_DIR, { recursive: true });

  const web = opts.results.filter((r) => r.classification === 'cps_web' && r.landing_url);

  const outcome: WebHqSplitOutcome = {
    zipPath: null,
    perCountryCounts: {},
    unresolvedCount: 0,
    totalRowsConsidered: web.length,
    cacheHits: 0,
    cctldHits: 0,
    scriptHits: 0,
    llmCalls: 0,
  };

  if (web.length === 0) {
    opts.onLog('info', 'web-hq-split: no cps_web rows to split');
    return outcome;
  }

  const bucketed: Record<string, Array<{ result: JobResultRow; hq: ResolvedHq | null }>> = {};

  for (let i = 0; i < web.length; i++) {
    const r = web[i];
    const url = r.landing_url!;

    let hq: ResolvedHq | null = lookupHqCache(url);
    if (hq) {
      outcome.cacheHits++;
    } else {
      try {
        // Attribute the counter by the path resolveWebHq will actually take,
        // in the SAME order it checks (ccTLD → script → LLM). We cannot rely on
        // the returned override_source: the LLM path (resolveHq) can itself
        // return 'cctld'/'script' from the LLM's corporate_domain, which would
        // undercount real, token-spending LLM calls.
        const domain = extractDomain(url);
        if (domain && resolveTld(domain)) outcome.cctldHits++;
        else if (detectCountryFromScript(r.advertiser_name || '')) outcome.scriptHits++;
        else outcome.llmCalls++;

        hq = await resolveWebHq(url, r.advertiser_name || '', r.ad_text || '');
        storeHqCache(url, hq);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        opts.onLog('error', `web-hq-split: resolve threw for ${url} — ${(err as Error).message}`);
        hq = null;
      }
    }

    const bucketKey = (hq?.primary_market || '').trim() || 'Unknown';
    if (!bucketed[bucketKey]) bucketed[bucketKey] = [];
    bucketed[bucketKey].push({ result: r, hq });

    if ((i + 1) % 10 === 0 || i === web.length - 1) {
      opts.onLog(
        'info',
        `web-hq-split: progress ${i + 1}/${web.length} (cache=${outcome.cacheHits}, cctld=${outcome.cctldHits}, script=${outcome.scriptHits}, llm=${outcome.llmCalls})`,
      );
    }
  }

  const zipEntries: ZipEntry[] = [];
  for (const [country, items] of Object.entries(bucketed)) {
    const slug = countryToFilenameSlug(country);
    const rows: (string | number | null)[][] = [HEADER, ...items.map((it) => rowFromResult(it.result, it.hq))];
    const xlsxBuf = buildXlsx({ name: slug.slice(0, 31), rows });
    zipEntries.push({ path: `${slug}.xlsx`, data: xlsxBuf });
    outcome.perCountryCounts[country] = items.length;
    if (country === 'Unknown') outcome.unresolvedCount = items.length;
  }

  const manifestLines = [
    `Web HQ split manifest for job ${opts.jobId}`,
    `Total cps_web rows considered: ${outcome.totalRowsConsidered}`,
    `Cache hits: ${outcome.cacheHits}`,
    `ccTLD hits: ${outcome.cctldHits}`,
    `Script hits: ${outcome.scriptHits}`,
    `LLM calls: ${outcome.llmCalls}`,
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
    `web-hq-split: wrote ${zipPath} (${zipEntries.length - 1} country files + manifest, ${zipBuf.length} bytes)`,
  );
  log.info(`web-hq-split done for ${opts.jobId}: ${JSON.stringify(outcome.perCountryCounts)}`);
  return outcome;
}

// ───────────────────────────────────────────────────────────────────────────
// Offline unit tests (pure ccTLD / script short-circuits; no network, no LLM).
// ───────────────────────────────────────────────────────────────────────────

export async function runHqSplitWebUnitTests(): Promise<{ passed: number; failed: number; failures: string[] }> {
  const failures: string[] = [];
  let passed = 0;
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // ccTLD short-circuit — free, no LLM.
  const br = await resolveWebHq('https://loja.com.br/promo', 'Loja Brasil', '');
  check(br.primary_market === 'Brazil' && br.override_source === 'cctld', 'ccTLD .com.br → Brazil (no LLM)');

  const jp = await resolveWebHq('https://shop.co.jp', 'Rakuten', '');
  check(jp.primary_market === 'Japan' && jp.override_source === 'cctld', 'ccTLD .co.jp → Japan (no LLM)');

  // script short-circuit — free, no LLM (domain is a plain .com).
  const cn = await resolveWebHq('https://example.com', '腾讯', '');
  check(cn.primary_market === 'China' && cn.override_source === 'script', 'script CJK → China (no LLM)');

  const il = await resolveWebHq('https://example.com', 'קזינו ישראל', '');
  check(il.override_source === 'script', 'script Hebrew short-circuits (no LLM)');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('hqSplitWeb.js') || process.argv[1].endsWith('hqSplitWeb.ts'));
if (isMain) {
  runHqSplitWebUnitTests().then(({ passed, failed, failures }) => {
    console.log(`hqSplitWeb unit tests: ${passed} passed, ${failed} failed`);
    for (const f of failures) console.log('  ' + f);
    process.exit(failed === 0 ? 0 : 1);
  });
}
