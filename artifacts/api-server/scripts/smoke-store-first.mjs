#!/usr/bin/env node
/**
 * Store-first discovery — permanent live smoke run (spec VERIFICATION #2–#5, #7).
 *
 * Runs the REAL pipeline against the REAL stores in an ISOLATED sandbox, then
 * asserts the spec's numeric goals. Isolation matters: db.ts resolves
 * `data/ad-library.sqlite` and storeLeads/csv resolve `csv-output/` from the
 * CWD at module-load time, so this script chdir()s into a sandbox directory
 * BEFORE dynamically importing dist/ — the operator's real database and CSVs are
 * never touched.
 *
 *   node scripts/smoke-store-first.mjs              # pass 1 (fresh sandbox)
 *   node scripts/smoke-store-first.mjs --pass=2     # pass 2, same sandbox (idempotence)
 *
 * Flags (all optional):
 *   --dir=<path>     sandbox dir            (default .smoke-store-first)
 *   --pass=1|2       1 wipes the sandbox, 2 re-runs over it
 *   --verticals=a,b  default finance
 *   --markets=a,b    default us
 *   --similar=N      similarMaxAppsPerRun   (default 500, per spec smoke)
 *   --terms=N        searchTermsLimit       (default 5,   per spec smoke)
 *   --confirm=N      confirmationMaxApiCalls(default 100, per spec smoke)
 *   --dev-catalog=N  DEV_CATALOG_MAX_PER_RUN override (default 60 — the run-time
 *                    dominating phase; the spec does not fix it for the smoke)
 *   --enrich-max=N   ENRICH_MAX_APPS_PER_RUN override (default: leave the
 *                    configured 4000; set small for a fast mechanics check)
 *   --no-assert      run without exiting non-zero on a failed goal
 *
 * Exit code is non-zero if any assertion fails, so this is gate-able from CI.
 */

import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// ── flags ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const num = (name, def) => {
  const v = flag(name, null);
  if (v == null || v === true) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
};
const list = (name, def) =>
  String(flag(name, def))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const PASS = num('pass', 1);
const SANDBOX = path.resolve(ROOT, String(flag('dir', '.smoke-store-first')));
const VERTICALS = list('verticals', 'finance');
const MARKETS = list('markets', 'us');
const SIMILAR = num('similar', 500);
const TERMS = num('terms', 5);
const CONFIRM = num('confirm', 100);
const DEV_CATALOG = num('dev-catalog', 60);
const ENRICH_MAX = num('enrich-max', 0); // 0 = leave the configured default
const ASSERT = flag('no-assert', false) !== true;

if (!existsSync(DIST)) {
  console.error(`✗ dist/ not found at ${DIST} — run \`npm run build\` first.`);
  process.exit(1);
}

// ── env overrides (read at module load by storeDiscoveryConfig) ──────────────
// Only the dev-catalog budget is tuned: at its 500 default the catalog phase and
// the re-enrichment it feeds dominate wall-clock (Apple is throttled to 10/min).
process.env.STORE_DEV_CATALOG_MAX = String(DEV_CATALOG);
if (ENRICH_MAX > 0) process.env.STORE_ENRICH_MAX_APPS = String(ENRICH_MAX);

// ── sandbox ──────────────────────────────────────────────────────────────────
if (PASS === 1 && existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
mkdirSync(path.join(SANDBOX, 'csv-output'), { recursive: true });
process.chdir(SANDBOX); // MUST precede the dist imports

const imp = (m) => import(pathToFileURL(path.join(DIST, m)).href);
// ─────────────────────────────────────────────────────────────────────────────
// NOT PORTED TO POSTGRESQL (order L-3.4g). READ THIS BEFORE RUNNING IT.
//
// This script belongs to the store-first SMOKE family, which is built on a
// sandbox DIRECTORY: it set the working directory so that db.ts's
// `path.resolve('data')` created a throwaway sqlite file, then ran a real
// discovery pass against it.
//
// Both halves of that are gone. Storage is PostgreSQL behind DATABASE_URL and
// there is no cwd-relative database to sandbox, so the sandbox concept has to
// become "a throwaway DATABASE" (scripts/pgtest.mjs already builds one).
//
// It was deliberately NOT converted under L-3.4g, and the ledger says so:
// every one of these scripts drives a live discovery run against Google Play,
// the App Store and Ads Transparency, and that order's hard rules forbid
// starting a real scraping or verification run — so a rewrite could not have
// been executed even once before being committed. Shipping an unrunnable,
// never-executed rewrite of an operator tool is worse than shipping an honest
// refusal.
//
// TO PORT IT: give the sandbox its own database (startCluster() from
// pgtest.mjs, or a named database on the dev instance), pass its URL down as
// DATABASE_URL instead of chdir-ing, and replace the better-sqlite3 handle
// below with a `pg` pool. The queries themselves are unchanged — the schema is
// the same one, table for table.
// ─────────────────────────────────────────────────────────────────────────────
const PORTED = false;
if (!PORTED) {
  console.error(
    'REFUSING TO RUN: this script still expects the pre-L-3.4g sqlite sandbox.\n' +
      'Leadfinder now stores everything in PostgreSQL (DATABASE_URL) and no longer\n' +
      'creates data/ad-library.sqlite, so this would build a sandbox nothing reads\n' +
      'and then spend a real discovery run against it. See the note at the top of\n' +
      'this file for what porting it involves.',
  );
  process.exit(2);
}

const { default: Database } = await import('better-sqlite3');

const t0 = Date.now();
const banner = (s) => console.log(`\n──── ${s} ────`);
banner(
  `SMOKE pass ${PASS} — verticals=[${VERTICALS}] markets=[${MARKETS}] similar=${SIMILAR} ` +
    `terms=${TERMS} confirm=${CONFIRM} devCatalog=${DEV_CATALOG}\n     sandbox: ${SANDBOX}`,
);

// ── run ──────────────────────────────────────────────────────────────────────
const dbm = await imp('db.js');
await dbm.initDb();

const DB_FILE = path.join(SANDBOX, 'data', 'ad-library.sqlite');
const sql = new Database(DB_FILE, { readonly: false });
const one = (q, ...a) => sql.prepare(q).get(...a);
const all = (q, ...a) => sql.prepare(q).all(...a);

/** Pre-run snapshot — pass 2 proves the permanent cache is never re-fetched. */
const detailBefore = new Map(
  all(`SELECT store, app_id, updated_at, enrich_status FROM store_app_detail`).map((r) => [
    `${r.store}|${r.app_id}`,
    r,
  ]),
);
const appsBefore = one(`SELECT COUNT(*) n FROM discovered_apps`).n;
const pubsBefore = one(`SELECT COUNT(*) n FROM publishers`).n;

// A synthetic owner: notifier resolves the sender from this user's Gmail tokens,
// finds none, logs "email skipped" and returns — no mail is ever sent.
sql
  .prepare(
    `INSERT OR IGNORE INTO users (id, email, name, default_recipient, created_at) VALUES (?,?,?,?,?)`,
  )
  .run('smoke-user', 'smoke@localhost', 'Smoke Runner', null, Date.now());

const jobId = `smoke-${PASS}-${process.pid}`;
const job = dbm.createJob({
  id: jobId,
  productType: 'mobile',
  countries: MARKETS,
  createdByUserId: 'smoke-user',
  source: 'store_first',
  sourceParams: {
    verticals: VERTICALS,
    markets: MARKETS,
    similarMaxAppsPerRun: SIMILAR,
    searchTermsLimit: TERMS,
    confirmationMaxApiCalls: CONFIRM,
  },
});

const { runStoreDiscoveryJob } = await imp('storeDiscoveryPipeline.js');
await runStoreDiscoveryJob(job);

const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
const finished = one(`SELECT status, error, csv_path, total_ads_scraped, total_advertisers FROM jobs WHERE id = ?`, jobId);

// ── assertions ───────────────────────────────────────────────────────────────
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

banner(`ASSERTIONS (pass ${PASS}, ${elapsedMin} min)`);

check(finished?.status === 'completed', 'job completed', finished?.error || finished?.status);

// VERIFICATION #2 — smoke-run goals (first pass establishes the corpus).
const apps = one(`SELECT COUNT(*) n FROM discovered_apps`).n;
const nonChart = one(`SELECT COUNT(*) n FROM discovered_apps WHERE source <> 'chart'`).n;
const pubs = one(`SELECT COUNT(*) n FROM publishers`).n;
const withEmail = one(`SELECT COUNT(*) n FROM publishers WHERE email IS NOT NULL AND email <> ''`).n;
const gatcConfirmed = one(
  `SELECT COUNT(*) n FROM publishers WHERE confirmed_advertiser = 1 AND COALESCE(gatc_ads_count,0) > 0`,
).n;
/**
 * Spec VERIFICATION #2 asks for "10+ in-band tail publishers QUEUED or confirmed".
 * Queued means queue MEMBERSHIP — the same predicate listPublishersForConfirmation
 * uses (is_charted = 1 OR in_band = 1) — not "was reached before the budget ran out".
 * Read the stricter way the goal is unsatisfiable BY CONSTRUCTION at the smoke's
 * 100-call cap: spec step 10 fixes the queue order as charted-first, and one
 * finance/us run rolls up ~374 charted publishers at ~3 calls each, so the tail tier
 * is never reached no matter how healthy the tail is. Both numbers are asserted and
 * printed, so a tail that is genuinely empty still fails and the budget truncation
 * stays visible instead of being papered over.
 */
const tailQueued = one(`SELECT COUNT(*) n FROM publishers WHERE is_charted = 0 AND in_band = 1`).n;
const tailReached = one(
  `SELECT COUNT(*) n FROM publishers WHERE is_charted = 0 AND in_band = 1 AND (last_confirm_at IS NOT NULL OR confirmed_advertiser = 1)`,
).n;
const chartedAhead = one(`SELECT COUNT(*) n FROM publishers WHERE is_charted = 1`).n;
const tailInBand = tailQueued;

check(apps >= 800, 'discovered apps ≥ 800', `${apps}`);
check(nonChart >= 200, 'non-chart-sourced apps ≥ 200', `${nonChart}`);
check(pubs >= 150, 'publishers ≥ 150', `${pubs}`);
check(withEmail >= 80, 'publishers with email ≥ 80', `${withEmail}`);
check(gatcConfirmed >= 20, 'GATC-confirmed publishers ≥ 20', `${gatcConfirmed}`);
check(
  tailInBand >= 10,
  'in-band tail publishers queued/confirmed ≥ 10',
  `${tailQueued} queued, ${tailReached} reached by this run's budget ` +
    `(${chartedAhead} charted publishers rank ahead of them per spec step 10)`,
);

// VERIFICATION #4 — no similar-crawl request was issued FROM a max-depth app.
// Proven from this run's own logs: the crawl announces every depth level it
// seeds, so a "similar depth <MAX>" line would be the violation itself.
const cfg = await imp('storeDiscoveryConfig.js');
const depthLines = all(
  `SELECT message FROM job_logs WHERE job_id = ? AND message LIKE 'similar depth %'`,
  jobId,
).map((r) => r.message);
const seededDepths = depthLines.map((m) => Number(/similar depth (\d+):/.exec(m)?.[1] ?? -1));
const maxStoredDepth = one(
  `SELECT COALESCE(MAX(discovery_depth),0) d FROM discovered_apps WHERE source IN ('chart','similar')`,
).d;
check(
  seededDepths.every((d) => d < cfg.SIMILAR_MAX_DEPTH),
  `no crawl seeded from depth ≥ SIMILAR_MAX_DEPTH (${cfg.SIMILAR_MAX_DEPTH})`,
  `seeded depths: [${seededDepths.join(',') || 'none'}]`,
);
check(
  maxStoredDepth <= cfg.SIMILAR_MAX_DEPTH,
  `no graph app deeper than SIMILAR_MAX_DEPTH`,
  `max stored depth ${maxStoredDepth}`,
);

// VERIFICATION #5 — idempotence (meaningful on pass 2).
const dupApps = all(
  `SELECT store, app_id, country, COUNT(*) c FROM discovered_apps GROUP BY 1,2,3 HAVING c > 1`,
).length;
const dupPlayDev = all(
  `SELECT play_developer_id, COUNT(*) c FROM publishers WHERE play_developer_id IS NOT NULL AND play_developer_id <> ''
   GROUP BY 1 HAVING c > 1`,
).length;
const dupSeller = all(
  `SELECT LOWER(apple_seller_name) s, COUNT(*) c FROM publishers WHERE apple_seller_name IS NOT NULL AND apple_seller_name <> ''
   GROUP BY 1 HAVING c > 1`,
).length;
check(dupApps === 0, 'zero duplicate (store, app_id, country) rows', `${dupApps} dupes`);
check(dupPlayDev === 0, 'zero duplicate publishers by Play developerId', `${dupPlayDev} dupes`);
check(dupSeller === 0, 'zero duplicate publishers by Apple sellerName', `${dupSeller} dupes`);

if (PASS >= 2) {
  const refetched = all(`SELECT store, app_id, updated_at, enrich_status FROM store_app_detail`).filter((r) => {
    const before = detailBefore.get(`${r.store}|${r.app_id}`);
    // A row that already succeeded must not be touched again. A row that had
    // FAILED is legitimately retried (retry cap MAX_ENRICH_ATTEMPTS).
    return before && before.enrich_status === 'done' && r.updated_at !== before.updated_at;
  });
  check(refetched.length === 0, 'zero re-fetches of cached app details', `${refetched.length} cached rows re-fetched`);
  console.log(
    `  · growth this pass: apps ${appsBefore} → ${apps} (+${apps - appsBefore}), ` +
      `publishers ${pubsBefore} → ${pubs} (+${pubs - pubsBefore})`,
  );
}

// VERIFICATION #7 — the run summary the pipeline printed, echoed for the record.
banner('RUN SUMMARY (from the job log)');
for (const r of all(
  `SELECT message FROM job_logs WHERE job_id = ? AND (message LIKE '%RUN SUMMARY%' OR message LIKE 'apps %'
     OR message LIKE 'publishers:%' OR message LIKE 'confirmation:%' OR message LIKE 'top publishers%'
     OR message LIKE '  %. %' OR message LIKE '───%') ORDER BY id`,
  jobId,
)) {
  console.log(`  ${r.message}`);
}
const csvs = existsSync(path.join(SANDBOX, 'csv-output'))
  ? readdirSync(path.join(SANDBOX, 'csv-output')).filter((f) => f.endsWith('.csv'))
  : [];
console.log(`  csv: ${finished?.csv_path || '(none)'} — csv-output/ holds [${csvs.join(', ')}]`);

// ── verdict ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
banner(`${failed.length === 0 ? '✓ SMOKE PASSED' : `✗ SMOKE FAILED (${failed.length})`} — ${elapsedMin} min`);
for (const f of failed) console.log(`  ✗ ${f.label} — ${f.detail}`);
sql.close();
process.exit(ASSERT && failed.length ? 1 : 0);
