/**
 * Google Ads Transparency — STREAMING / real-time / pause-on-block smoke test.
 *
 * Drives the REAL runGoogleAdsJob() against a MOCKED network (global.fetch) so
 * the whole pipeline runs offline and deterministically. Proves the behaviours
 * added for the "found 250 → got 0" + "fill the excel in real time" fixes:
 *
 *   A. Block-storm (MOBILE): SearchSuggestions OK, SearchCreatives 429. Every
 *      discovered advertiser is still saved (domain fallback → stored cps_web),
 *      csv_path is published, and the circuit breaker PAUSES creative scraping
 *      fast (exactly BREAKER_AFTER creative calls, then none).
 *   B. Discovery halts mid-scrape (CPS): suggestions OK for keyword 1 then 429.
 *      The leads found before the abort are ALREADY in the DB/CSV — no data loss.
 *      (Also exercises GOOGLE_ADS_DISCOVERY_ABORT_AFTER.)
 *   C. Mobile job over web advertisers: mobile CSV is 0 rows even though N web
 *      leads were found — reproduces the user's "250 → 0", asserts the recovery
 *      guidance fires, and proves the ?product=cps rebuild path (buildCsv with
 *      the override product) exports the stored web leads.
 *   D. CPS makes ZERO creative-endpoint calls (domain-first mode) — the calls
 *      that flag a proxy IP simply never happen; all leads still export.
 *
 * Env is set BEFORE importing dist/ (module-load reads it) and dynamic import()
 * is used so the fast/no-sleep settings take effect.
 *
 * Run:  pnpm build && node fixtures/google-ads-streaming-smoke.mjs
 */

process.env.GOOGLE_ADS_WARMUP = '0';
process.env.GOOGLE_ADS_FETCH_DELAY_MS = '0';
process.env.GOOGLE_ADS_MAX_RETRIES = '0'; // blocked calls fail instantly (no backoff sleeps)
process.env.GOOGLE_ADS_BACKOFF_BASE_MS = '250';
process.env.GOOGLE_ADS_BACKOFF_MAX_MS = '250';
process.env.GOOGLE_ADS_BREAKER_AFTER = '3'; // explicit (default is now 1) so scenario A can count trips
process.env.GOOGLE_ADS_DISCOVERY_ABORT_AFTER = '5'; // explicit (default is now 2) so scenario B's count is stable
process.env.GOOGLE_ADS_CREATIVE_LOOKUPS_PER_ADV = '2';
process.env.GOOGLE_ADS_COOLDOWN_MS = '0'; // scenarios A–D must not trip the cooldown gate (E turns it on)
delete process.env.ANTHROPIC_API_KEY; // name-search must gracefully skip offline

const { initDb, createJob, getJob, getResults, getLogs } = await import('../dist/db.js');
const { runGoogleAdsJob } = await import('../dist/googleAdsPipeline.js');
const { buildCsv } = await import('../dist/csv.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── Mock network ──────────────────────────────────────────────────────────
let advSeq = 0;
let suggestCalls = 0, creativeCalls = 0, detailCalls = 0, fetchCalls = 0;
let suggestMode = 'ok'; // 'ok' = every keyword answers; 'first-ok' = only call #1; 'blocked' = every call 429
let warmupStatus = 200; // homepage GET status (429 simulates the penalty box)

function suggestBody(advs) {
  // Flat suggestion shape (parseAdvertiserSuggestions handles it — see the
  // existing fixture): {"1":[{"1":AR-id,"12":name,"5":{"2":domain},"9":region}]}
  const items = advs.map((a) => ({ '1': a.id, '12': a.name, '5': { '2': a.domain }, '9': 'US' }));
  return ")]}'\n" + JSON.stringify({ '1': items });
}
function nextAdvertisers(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = ++advSeq;
    out.push({ id: 'AR' + String(s).padStart(20, '0'), name: `Advertiser ${s}`, domain: `adv${s}.com` });
  }
  return out;
}
function installMock() {
  suggestCalls = 0; creativeCalls = 0; detailCalls = 0; fetchCalls = 0;
  global.fetch = async (url) => {
    fetchCalls++;
    const u = String(url);
    if (u.includes('SearchSuggestions')) {
      suggestCalls++;
      if (suggestMode === 'blocked') return new Response('', { status: 429 });
      if (suggestMode === 'first-ok' && suggestCalls > 1) return new Response('', { status: 429 });
      return new Response(suggestBody(nextAdvertisers(3)), { status: 200 });
    }
    if (u.includes('SearchCreatives')) { creativeCalls++; return new Response('', { status: 429 }); }
    if (u.includes('GetCreativeById')) { detailCalls++; return new Response('', { status: 429 }); }
    return new Response('', { status: warmupStatus }); // warm-up / anything else
  };
}

const logsFor = (jobId) => getLogs(jobId).map((l) => l.message).join('\n');

await initDb();

// ── Scenario A: block storm, MOBILE — real-time save + fast pause ───────────
// (Mobile is the only product that touches the creative endpoint now.)
console.log('\n=== A. Block storm (MOBILE): creatives 429, suggestions OK ===');
suggestMode = 'ok';
installMock();
const jobA = `job_smoke_stream_A_${Date.now()}`;
createJob({
  id: jobA, productType: 'mobile', countries: ['US'], createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { customKeywords: ['k1', 'k2', 'k3', 'k4', 'k5'], region: 'US' },
});
await runGoogleAdsJob(getJob(jobA));
const resA = getResults(jobA);
const csvAweb = buildCsv({ jobId: jobA, productType: 'cps', results: resA });
const jobARow = getJob(jobA);
check('A: all 15 discovered advertisers saved (domain fallback, nothing dropped)', resA.length === 15, `${resA.length} rows`);
check('A: saved leads export as CPS (recovery path)', csvAweb.rowsWritten === 15, `${csvAweb.rowsWritten} rows`);
check('A: circuit breaker PAUSED creative scraping fast (exactly 3 creative calls)', creativeCalls === 3, `${creativeCalls} SearchCreatives calls`);
check('A: breaker log present', /circuit breaker ON/.test(logsFor(jobA)) && /PAUSING creative scraping/.test(logsFor(jobA)));
check('A: csv_path published (downloadable even if halted)', !!jobARow.csv_path, jobARow.csv_path || '(null)');
check('A: job completed', jobARow.status === 'completed', jobARow.status);

// ── Scenario B: discovery halts after keyword 1 — no data loss ──────────────
console.log('\n=== B. Discovery halts (CPS): suggestions 429 after keyword 1 ===');
suggestMode = 'first-ok';
installMock();
const jobB = `job_smoke_stream_B_${Date.now()}`;
createJob({
  id: jobB, productType: 'cps', countries: ['US'], createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { customKeywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'], region: 'US' },
});
await runGoogleAdsJob(getJob(jobB));
const resB = getResults(jobB);
const jobBRow = getJob(jobB);
check('B: leads found before the discovery halt are saved (streamed, not lost)', resB.length === 3, `${resB.length} rows`);
check('B: discovery aborted early (5 consecutive suggestion blocks)', suggestCalls === 6, `${suggestCalls} suggestion calls`);
check('B: csv_path published for the partial result', !!jobBRow.csv_path, jobBRow.csv_path || '(null)');

// ── Scenario C: mobile job over web advertisers — reproduces "250 → 0" ───────
console.log('\n=== C. Mobile job, web advertisers: the 0-despite-leads case ===');
suggestMode = 'ok';
installMock();
const jobC = `job_smoke_stream_C_${Date.now()}`;
createJob({
  id: jobC, productType: 'mobile', countries: ['US'], createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { customKeywords: ['k1', 'k2', 'k3', 'k4', 'k5'], region: 'US' },
});
await runGoogleAdsJob(getJob(jobC));
const resC = getResults(jobC);
const csvCmobile = buildCsv({ jobId: jobC, productType: 'mobile', results: resC });
const csvCweb = buildCsv({ jobId: jobC, productType: 'cps', results: resC });
check('C: web leads WERE found and saved in the DB', resC.length === 15, `${resC.length} rows`);
check('C: mobile CSV is EMPTY (web leads excluded) — the user\'s 250→0', csvCmobile.rowsWritten === 0, `${csvCmobile.rowsWritten} mobile rows`);
check('C: same leads export fine as CPS (?product=cps rebuild)', csvCweb.rowsWritten === 15, `${csvCweb.rowsWritten} cps rows`);
check('C: pipeline logged the ?product=cps recovery link', /product=cps/.test(logsFor(jobC)));

// ── Scenario D: CPS never touches the creative endpoint (domain-first) ──────
console.log('\n=== D. CPS domain-first: ZERO creative-endpoint calls ===');
suggestMode = 'ok';
installMock();
const jobD = `job_smoke_stream_D_${Date.now()}`;
createJob({
  id: jobD, productType: 'cps', countries: ['US'], createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { customKeywords: ['k1', 'k2', 'k3', 'k4', 'k5'], region: 'US' },
});
await runGoogleAdsJob(getJob(jobD));
const resD = getResults(jobD);
const csvD = buildCsv({ jobId: jobD, productType: 'cps', results: resD });
check('D: CPS made ZERO SearchCreatives calls (nothing to flag the IP)', creativeCalls === 0, `${creativeCalls} creative calls`);
check('D: CPS made ZERO GetCreativeById calls', detailCalls === 0, `${detailCalls} detail calls`);
check('D: all 15 leads exported (domain-first)', csvD.rowsWritten === 15, `${csvD.rowsWritten} rows`);
check('D: CPS-mode log present', /CPS mode — creative lookups OFF/.test(logsFor(jobD)));
check('D: job completed', getJob(jobD).status === 'completed', getJob(jobD).status);

// ── Scenario E: cooldown latch — after a hard block, jobs send ZERO requests ─
// Scenario B ended in a blocked discovery abort, which set the hard-block
// latch. Turning the cooldown window on now must make the next job abort
// instantly without a single network call.
console.log('\n=== E. Cooldown latch: instant abort, zero requests ===');
process.env.GOOGLE_ADS_COOLDOWN_MS = '600000';
suggestMode = 'ok';
installMock();
const jobE = `job_smoke_stream_E_${Date.now()}`;
createJob({
  id: jobE, productType: 'cps', countries: ['US'], createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { customKeywords: ['k1', 'k2'], region: 'US' },
});
await runGoogleAdsJob(getJob(jobE));
check('E: ZERO network requests during cooldown', fetchCalls === 0, `${fetchCalls} fetches`);
check('E: cooldown message logged', /COOLDOWN ACTIVE/.test(logsFor(jobE)));
check('E: job still completes (empty, fast)', getJob(jobE).status === 'completed', getJob(jobE).status);
process.env.GOOGLE_ADS_COOLDOWN_MS = '0';

// ── Scenario F: penalty-box probe — warm-up 429 ⇒ ONE probe, no retry storm ─
console.log('\n=== F. Penalty box: warm-up 429 → single probe → instant abort ===');
process.env.GOOGLE_ADS_WARMUP = '1';
process.env.GOOGLE_ADS_MAX_RETRIES = '3'; // prove the probe OVERRIDES the ladder
suggestMode = 'blocked';
warmupStatus = 429;
installMock();
const jobF = `job_smoke_stream_F_${Date.now()}`;
createJob({
  id: jobF, productType: 'cps', countries: ['US'], createdByUserId: 'usr_smoke',
  source: 'google_ads',
  sourceParams: { customKeywords: ['k1', 'k2', 'k3'], region: 'US' },
});
await runGoogleAdsJob(getJob(jobF));
check('F: exactly ONE suggest attempt (no retry ladder)', suggestCalls === 1, `${suggestCalls} suggest calls`);
check('F: only 2 requests total (warm-up + probe)', fetchCalls === 2, `${fetchCalls} fetches`);
check('F: penalty-box abort logged', /PENALTY BOX CONFIRMED/.test(logsFor(jobF)));
check('F: job completed fast (no grind)', getJob(jobF).status === 'completed', getJob(jobF).status);
process.env.GOOGLE_ADS_WARMUP = '0';
process.env.GOOGLE_ADS_MAX_RETRIES = '0';
warmupStatus = 200;

console.log(`\n=== streaming smoke: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
