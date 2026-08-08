#!/usr/bin/env node
/**
 * Tail-confirmation verification (spec step 10, the headline invariant).
 *
 * The smoke run can never exercise this path: step 10 fixes the confirmation queue
 * order as charted-first, and a finance/us corpus rolls up ~374 charted publishers,
 * so a 100-call budget is spent long before the in-band tail tier is reached. That
 * leaves the spec's central claim — "a publisher found outside the top charts is
 * never marked a confirmed advertiser without a GATC or Meta hit" — verified only by
 * the offline suite, never against live RPC.
 *
 * This script closes that gap. It VACUUMs the smoke sandbox into a throwaway copy,
 * drops the charted publishers out of the queue predicate IN THE COPY ONLY, and runs
 * the real confirmPublishers() so the tail tier is what gets processed. The smoke
 * sandbox and the operator's database are never written.
 *
 *   node scripts/verify-tail-confirm.mjs [--src=.smoke-store-first] [--budget=60]
 *
 * Asserts, against live results:
 *   1. the run actually processed tail publishers (the path is reachable at all)
 *   2. EVERY publisher it processed is un-charted (no charted row leaked in)
 *   3. tail queue order held: with-email publishers are served before without-email
 *   4. NO CHART FALLBACK — every tail publisher left confirmed has a positive GATC
 *      ads_count or a positive Meta count; a zero-hit tail publisher stays unconfirmed
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!h) return d;
  const i = h.indexOf('=');
  return i === -1 ? true : h.slice(i + 1);
};

const SRC = path.resolve(ROOT, String(flag('src', '.smoke-store-first')));
const BUDGET = Number(flag('budget', 60)) || 60;
const WORK = path.resolve(ROOT, '.tail-confirm-check');
const SRC_DB = path.join(SRC, 'data', 'ad-library.sqlite');

if (!existsSync(DIST)) {
  console.error(`✗ dist/ not found — run \`npm run build\` first.`);
  process.exit(1);
}
if (!existsSync(SRC_DB)) {
  console.error(`✗ no sandbox DB at ${SRC_DB} — run scripts/smoke-store-first.mjs first.`);
  process.exit(1);
}

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

// ── throwaway copy (VACUUM INTO folds the WAL in, so the copy is self-contained) ──
if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
mkdirSync(path.join(WORK, 'data'), { recursive: true });
mkdirSync(path.join(WORK, 'csv-output'), { recursive: true });
const WORK_DB = path.join(WORK, 'data', 'ad-library.sqlite');
{
  const src = new Database(SRC_DB, { readonly: true });
  src.exec(`VACUUM INTO '${WORK_DB.replace(/'/g, "''")}'`);
  src.close();
}

// ── drop charted publishers out of the queue, in the COPY only ──────────────────
// listPublishersForConfirmation selects `WHERE is_charted = 1 OR in_band = 1`, so
// clearing both flags on the charted rows removes exactly the tier that otherwise
// eats the budget, leaving the in-band tail as the head of the queue. Nothing else
// is touched — the tail rows keep whatever the smoke gave them.
const prep = new Database(WORK_DB);
const chartedBefore = prep.prepare(`SELECT COUNT(*) c FROM publishers WHERE is_charted = 1`).get().c;
prep.prepare(`UPDATE publishers SET is_charted = 0, in_band = 0 WHERE is_charted = 1`).run();
const tailQueue = prep.prepare(
  `SELECT COUNT(*) c FROM publishers WHERE is_charted = 0 AND in_band = 1`,
).get().c;
// Snapshot the pre-run confirmation state so "left confirmed" can be attributed.
const before = new Map(
  prep
    .prepare(`SELECT id, confirmed_advertiser, gatc_ads_count, meta_active_ads, last_confirm_at FROM publishers`)
    .all()
    .map((r) => [r.id, r]),
);
prep.close();

console.log(`\n──── TAIL CONFIRMATION CHECK ────`);
console.log(`  source   : ${SRC_DB}`);
console.log(`  copy     : ${WORK_DB}`);
console.log(`  charted publishers removed from the queue: ${chartedBefore}`);
console.log(`  in-band tail publishers now queued       : ${tailQueue}`);
console.log(`  budget   : ${BUDGET} API calls\n`);

if (tailQueue === 0) {
  console.error('✗ no in-band tail publishers in the corpus — nothing to verify.');
  process.exit(1);
}

// ── run the REAL confirmation against the copy ──────────────────────────────────
process.chdir(WORK); // MUST precede the dist import (db.js resolves data/ from cwd)
const imp = (m) => import(pathToFileURL(path.join(DIST, m)).href);
// db.js keeps its handle in a module-level singleton that only initDb() populates, so
// every dist module reaching for getDb() throws 'DB not initialized' until this runs.
// The copy already carries the smoke run's schema; initDb is idempotent over it.
await (await imp('db.js')).initDb();
const { confirmPublishers } = await imp('storeConfirm.js');

const logged = [];
const onLog = (level, msg) => {
  logged.push({ level, msg });
  if (level !== 'debug') console.log(`  [${level}] ${msg}`);
};

const summary = await confirmPublishers({ maxApiCalls: BUDGET, onLog });
console.log(`\n  summary: ${JSON.stringify(summary)}\n`);

// ── assertions ──────────────────────────────────────────────────────────────────
const db = new Database(WORK_DB, { readonly: true });
const all = (q, ...a) => db.prepare(q).all(...a);
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok: !!ok, label, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const touched = all(
  `SELECT id, name, email, is_charted, in_band, confirmed_advertiser, gatc_ads_count, meta_active_ads, last_confirm_at
     FROM publishers WHERE last_confirm_at IS NOT NULL`,
).filter((r) => (before.get(r.id)?.last_confirm_at ?? null) !== r.last_confirm_at);

check(summary.processed > 0, 'confirmation reached the tail tier at all', `${summary.processed} publishers processed`);
check(
  touched.length > 0,
  'tail publishers were actually written back',
  `${touched.length} rows updated this run`,
);
check(
  touched.every((r) => r.is_charted === 0),
  'every processed publisher is un-charted',
  `${touched.filter((r) => r.is_charted !== 0).length} charted rows leaked in`,
);

// Queue order within the tail: with-email is tier 1, without-email tier 2, so once a
// without-email publisher has been served no with-email one may still be untouched.
const hasEmail = (r) => !!r.email && String(r.email).trim() !== '';
const servedNoEmail = touched.filter((r) => !hasEmail(r)).length;
const unservedWithEmail = all(
  `SELECT id FROM publishers WHERE is_charted = 0 AND in_band = 1 AND email IS NOT NULL AND email <> '' AND last_confirm_at IS NULL`,
).length;
check(
  servedNoEmail === 0 || unservedWithEmail === 0,
  'tail queue order: with-email served before without-email',
  `${touched.filter(hasEmail).length} with-email served, ${servedNoEmail} without-email served, ${unservedWithEmail} with-email still unserved`,
);

// THE headline invariant: no chart fallback for the tail.
const confirmedTail = all(
  `SELECT id, name, gatc_ads_count, meta_active_ads FROM publishers WHERE is_charted = 0 AND confirmed_advertiser = 1`,
);
const unsupported = confirmedTail.filter((r) => (r.gatc_ads_count ?? 0) <= 0 && (r.meta_active_ads ?? 0) <= 0);
check(
  unsupported.length === 0,
  'NO CHART FALLBACK: every confirmed tail publisher has a real GATC or Meta hit',
  `${confirmedTail.length} tail publishers confirmed, ${unsupported.length} without any hit`,
);
for (const u of unsupported) console.log(`      ✗ ${u.name}: gatc=${u.gatc_ads_count} meta=${u.meta_active_ads}`);

// And the converse: a processed tail publisher with no hit must NOT be confirmed.
const zeroHitProcessed = touched.filter((r) => (r.gatc_ads_count ?? 0) <= 0 && (r.meta_active_ads ?? 0) <= 0);
check(
  zeroHitProcessed.every((r) => r.confirmed_advertiser === 0),
  'zero-hit tail publishers stay unconfirmed',
  `${zeroHitProcessed.length} processed with no hit, ${zeroHitProcessed.filter((r) => r.confirmed_advertiser !== 0).length} wrongly confirmed`,
);

if (confirmedTail.length > 0) {
  console.log(`\n  tail publishers confirmed this run:`);
  for (const r of confirmedTail.slice(0, 10)) {
    console.log(`    · ${r.name} — gatc_ads_count=${r.gatc_ads_count} meta=${r.meta_active_ads ?? '—'}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n──── ${failed.length === 0 ? '✓ TAIL CHECK PASSED' : `✗ TAIL CHECK FAILED (${failed.length})`} ────`);
for (const f of failed) console.log(`  ✗ ${f.label} — ${f.detail}`);
db.close();
process.exit(failed.length ? 1 : 0);
