/**
 * Google Ads Transparency — end-to-end smoke test.
 *
 * Runs against the COMPILED dist/. Two parts:
 *
 *   OFFLINE (always runs, no network, no LLM key needed):
 *     - keyword bank shape + sampling
 *     - RPC response parsers against fixture payloads (the exact shapes the
 *       real endpoint returns)
 *     - destination classifier mapping
 *     - a real DB → CSV → web-HQ-split run over synthetic advertiser rows,
 *       proving the whole deliverable chain (SQLite, csv writer, xlsx, zip,
 *       ccTLD/script HQ bucketing) works without a live scrape.
 *
 *   LIVE (best-effort; expected to be BLOCKED inside a locked-down sandbox and
 *   to WORK from Replit): a couple of real SearchSuggestions calls. This part
 *   never fails the smoke — it just reports what the endpoint returned.
 *
 * Run:  node dist ready →  `node fixtures/google-ads-smoke.mjs`
 */

import { initDb, createJob, insertResult, getResults, markJobCompleted } from '../dist/db.js';
import { buildCsv } from '../dist/csv.js';
import { runHqSplitWeb } from '../dist/hqSplitWeb.js';
import { keywordsForJob, keywordStats } from '../dist/googleAdsKeywords.js';
import {
  parseRpcJson,
  parseAdvertiserSuggestions,
  parseCreativesResponse,
  extractDestinationUrl,
  discoverAdvertisers,
} from '../dist/googleAdsScraper.js';
import { classifyGoogleAdsUrl } from '../dist/googleAdsPipeline.js';
import { existsSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── 1. Keyword bank ──
console.log('\n=== 1. Keyword exemplar bank ===');
const stats = keywordStats();
console.log(`  bank: ${stats.total} keywords · ${stats.languages} languages · ${stats.verticals} verticals`);
check('bank is humongous (>=1200)', stats.total >= 1200, `${stats.total}`);
check('covers >=30 languages', stats.languages >= 30, `${stats.languages}`);
const sample = keywordsForJob({ limit: 40 });
check('sample honors limit', sample.length === 40);
const casinoRu = keywordsForJob({ verticals: ['igaming'], languages: ['ru'], limit: 5 });
check('vertical+language filter works', casinoRu.length > 0, casinoRu.join(', '));

// ── 2. RPC parsers over fixture payloads ──
console.log('\n=== 2. RPC response parsers (fixture payloads) ===');
const suggestFixture = `)]}'
{"1":[
  {"1":"AR01111111111111111111","12":"Nike, Inc.","5":{"2":"nike.com"},"9":"US"},
  {"1":"AR02222222222222222222","12":"Casino Brasil Ltda","5":{"2":"cassino.com.br"}}
]}`;
const advs = parseAdvertiserSuggestions(parseRpcJson(suggestFixture), 'casino');
check('parses advertisers', advs.length === 2, `${advs.length}`);
check('advertiser id + name + domain', advs[0].advertiser_id === 'AR01111111111111111111' && advs[0].name === 'Nike, Inc.' && advs[0].domain === 'nike.com');

const creativesFixture = `)]}'
{"1":[{"1":"AR01111111111111111111","2":"CR11111111111111111111","8":2}],"2":"NEXTTOKEN"}`;
const cre = parseCreativesResponse(parseRpcJson(creativesFixture));
check('parses creatives + nextToken', cre.creatives.length === 1 && cre.nextToken === 'NEXTTOKEN' && cre.creatives[0].format === 'image');

const detailFixture = `)]}'
{"5":{"img":"https://tpc.googlesyndication.com/x.png","click":"https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fshop.example.com%2Fpromo"}}`;
check('extracts + unwraps destination', extractDestinationUrl(parseRpcJson(detailFixture)) === 'https://shop.example.com/promo');

// ── 3. Destination classifier (no LLM) ──
console.log('\n=== 3. Destination classifier ===');
check('play → mobile', classifyGoogleAdsUrl('https://play.google.com/store/apps/details?id=com.x').classification === 'mobile_google_play');
check('apple → mobile', classifyGoogleAdsUrl('https://apps.apple.com/us/app/x/id123').classification === 'mobile_app_store');
check('website → cps_web', classifyGoogleAdsUrl('https://brand.com/promo').classification === 'cps_web');

// ── 4. Full DB → CSV → web-HQ-split chain (synthetic rows) ──
console.log('\n=== 4. DB → CSV → web-HQ-split (synthetic, ccTLD/script HQ) ===');
await initDb();
const jobId = `job_smoke_ga_web_${Date.now()}`;
createJob({
  id: jobId,
  productType: 'cps',
  countries: ['US'],
  createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { verticals: null, languages: null, maxKeywords: 5, customKeywords: null, region: 'US' },
});
// Synthetic web advertisers spanning HQ signals: ccTLD (BR), ccTLD (JP), script (CN), plain .com (→Unknown/LLM).
// URLs carry the run id so each run exercises FRESH resolution (the hqCache is
// keyed by full URL — a fixed URL would be served from cache on re-runs).
const rid = Date.now();
const webRows = [
  { name: 'Loja Brasil', url: `https://loja.com.br/promo?r=${rid}` },
  { name: 'Rakuten', url: `https://shop.co.jp/deal?r=${rid}` },
  { name: '腾讯商城', url: `https://store-cn.com/sale?r=${rid}` },
  { name: 'Generic Shop', url: `https://genericshop.com/sale?r=${rid}` },
];
for (const r of webRows) {
  insertResult({
    job_id: jobId,
    advertiser_name: r.name,
    page_url: 'https://adstransparency.google.com/advertiser/ARx?region=anywhere',
    landing_url: r.url,
    classification: 'cps_web',
    store_url: null,
    ad_text: 'Google Ads Transparency · matched "shop"',
    country: 'US',
  });
}
const results = getResults(jobId);
const { path: csvPath, rowsWritten } = buildCsv({ jobId, productType: 'cps', results });
// CRITICAL: never leave this synthetic job 'pending'. The dev DB once shipped
// inside a deploy image and the deployment's queue processor executed stale
// pending smoke jobs against the LIVE endpoint through the operator's proxy.
markJobCompleted(jobId, csvPath, { ads: results.length, advertisers: rowsWritten });
check('CPS CSV written with all rows', rowsWritten === webRows.length, `${rowsWritten} rows @ ${csvPath}`);

const onLog = (lvl, msg) => { if (lvl === 'warn' || lvl === 'error') console.log(`    [${lvl}] ${msg}`); };
const outcome = await runHqSplitWeb({ jobId, results, onLog });
console.log(`  HQ buckets: ${JSON.stringify(outcome.perCountryCounts)}`);
check('web-hq-split wrote a zip', !!outcome.zipPath && existsSync(outcome.zipPath));
check('ccTLD .com.br → Brazil bucket', outcome.perCountryCounts['Brazil'] === 1);
check('ccTLD .co.jp → Japan bucket', outcome.perCountryCounts['Japan'] === 1);
check('script CJK name → China bucket', outcome.perCountryCounts['China'] === 1);
check('ccTLD/script were free (no LLM for those 3)', outcome.cctldHits >= 2 && outcome.scriptHits >= 1, `cctld=${outcome.cctldHits} script=${outcome.scriptHits} llm=${outcome.llmCalls}`);

// ── 5. LIVE discovery (best-effort; expected blocked in a sandbox, works in Replit) ──
console.log('\n=== 5. LIVE discovery probe (best-effort) ===');
try {
  const live = await discoverAdvertisers(['casino', 'seguro'], { region: 'US', onLog: () => {} });
  console.log(`  live: requests=${live.requestsMade}, advertisers=${live.advertisers.length}, blocked=${live.blocked}`);
  if (live.blocked && live.advertisers.length === 0) {
    console.log('  (endpoint blocked/unreachable here — EXPECTED in a locked-down sandbox; will work from Replit)');
  } else if (live.advertisers.length > 0) {
    console.log('  sample advertisers:');
    for (const a of live.advertisers.slice(0, 5)) console.log(`    - ${a.name}  [${a.advertiser_id}]  ${a.domain || ''}`);
  }
  check('live discovery did not throw (degrades gracefully)', true);
} catch (err) {
  check('live discovery did not throw (degrades gracefully)', false, err.message);
}

console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
