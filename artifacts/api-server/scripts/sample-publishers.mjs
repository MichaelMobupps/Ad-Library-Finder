#!/usr/bin/env node
/**
 * Store-first discovery — publisher spot-check (spec VERIFICATION #3).
 *
 * Samples publishers out of a smoke sandbox and checks, per publisher, the four
 * things the spec asks a human to confirm by hand:
 *   1. email present (and syntactically a real address)
 *   2. website RESOLVES (a real HTTP response, redirects followed)
 *   3. the preview store URL opens the CORRECT app — verified by re-fetching the
 *      app from the store's own API and matching the id, not by eyeballing a 200
 *   4. for confirmed publishers, the GATC advertiser link is well-formed and the
 *      stored ads_count is positive (the page itself is JS-rendered, so this
 *      asserts the link/id/count triple rather than scraping the SPA)
 *
 *   node scripts/sample-publishers.mjs [--dir=.smoke-store-first] [--n=5] [--confirmed-only]
 *
 * Read-only against the sandbox DB; the only writes are network GETs.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!h) return d;
  const i = h.indexOf('=');
  return i === -1 ? true : h.slice(i + 1);
};

const SANDBOX = path.resolve(ROOT, String(flag('dir', '.smoke-store-first')));
const N = Number(flag('n', 5)) || 5;
const CONFIRMED_ONLY = flag('confirmed-only', false) === true;
const DB_FILE = path.join(SANDBOX, 'data', 'ad-library.sqlite');

if (!existsSync(DB_FILE)) {
  console.error(`✗ no sandbox DB at ${DB_FILE} — run scripts/smoke-store-first.mjs first.`);
  process.exit(1);
}

const { default: Database } = await import('better-sqlite3');
const db = new Database(DB_FILE, { readonly: true });

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/** Follow redirects and report where the site actually landed. */
async function resolves(url) {
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const res = await fetch(u, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    // Some hosts refuse HEAD-ish probes but serve the page; any HTTP answer
    // proves the domain resolves and is served, which is what we assert.
    return { ok: res.status < 400, detail: `HTTP ${res.status}${res.url !== u ? ` → ${res.url.slice(0, 60)}` : ''}` };
  } catch (e) {
    return { ok: false, detail: e.message.slice(0, 70) };
  }
}

/** Confirm a preview store URL points at an app that really exists, and that the
 *  id in the URL is the one the store returns. */
async function storeUrlOpensCorrectApp(url) {
  if (!url) return { ok: false, detail: 'no preview URL' };
  const play = /play\.google\.com\/store\/apps\/details\?id=([^&]+)/.exec(url);
  const apple = /apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id(\d+)/.exec(url);
  try {
    if (play) {
      const appId = decodeURIComponent(play[1]);
      const gplay = (await import('google-play-scraper')).default;
      const a = await gplay.app({ appId, country: 'us' });
      return { ok: a?.appId === appId, detail: `play ${appId} → "${(a?.title || '').slice(0, 40)}"` };
    }
    if (apple) {
      const id = apple[1];
      const r = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=us`, {
        headers: UA,
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json();
      const hit = j?.results?.[0];
      return { ok: String(hit?.trackId) === id, detail: `apple ${id} → "${(hit?.trackName || '').slice(0, 40)}"` };
    }
    return { ok: false, detail: `unrecognized store URL: ${url.slice(0, 60)}` };
  } catch (e) {
    return { ok: false, detail: e.message.slice(0, 70) };
  }
}

const where = CONFIRMED_ONLY ? 'WHERE confirmed_advertiser = 1' : '';
const rows = db
  .prepare(
    `SELECT id, name, email, website, preview_url, preview_title, score, confirmed_advertiser,
            gatc_advertiser_id, gatc_ads_count, meta_active_ads, is_charted, best_rank, in_band
     FROM publishers ${where} ORDER BY score DESC, id ASC LIMIT ?`,
  )
  .all(N);

if (rows.length === 0) {
  console.error('✗ no publishers matched — nothing to sample.');
  process.exit(1);
}

console.log(`\nSampling ${rows.length} publisher(s) from ${DB_FILE}\n`);

let pass = 0;
let checks = 0;
for (const [i, p] of rows.entries()) {
  console.log(`${i + 1}. ${p.name}  — score ${p.score}${p.confirmed_advertiser ? ' ✓confirmed' : ''}${
    p.is_charted ? ` (charted, best rank ${p.best_rank})` : ' (tail)'
  }`);

  const emailOk = !!p.email && EMAIL_RE.test(p.email);
  console.log(`   ${emailOk ? '✓' : '✗'} email: ${p.email || '(none)'}`);
  checks++;
  if (emailOk) pass++;

  if (p.website) {
    const r = await resolves(p.website);
    console.log(`   ${r.ok ? '✓' : '✗'} website: ${p.website} — ${r.detail}`);
    checks++;
    if (r.ok) pass++;
  } else {
    console.log(`   · website: (none stored)`);
  }

  const s = await storeUrlOpensCorrectApp(p.preview_url);
  console.log(`   ${s.ok ? '✓' : '✗'} preview: ${(p.preview_url || '(none)').slice(0, 78)}`);
  console.log(`       ${s.detail}`);
  checks++;
  if (s.ok) pass++;

  // Spec step 12: the store URL must come AHEAD of the brand website.
  const previewIsStore = !!p.preview_url && /play\.google\.com|apps\.apple\.com/.test(p.preview_url);
  console.log(`   ${previewIsStore ? '✓' : '✗'} preview link is a STORE url, not the brand site`);
  checks++;
  if (previewIsStore) pass++;

  if (p.confirmed_advertiser) {
    const idOk = !!p.gatc_advertiser_id;
    const countOk = (p.gatc_ads_count || 0) > 0 || (p.meta_active_ads || 0) > 0;
    console.log(
      `   ${idOk && countOk ? '✓' : '✗'} confirmation: gatc_ads_count=${p.gatc_ads_count ?? '—'} ` +
        `meta=${p.meta_active_ads ?? '—'}`,
    );
    if (p.gatc_advertiser_id) {
      console.log(`       https://adstransparency.google.com/advertiser/${p.gatc_advertiser_id}`);
    }
    checks++;
    if (idOk && countOk) pass++;
  }
  console.log('');
}

console.log(`${pass === checks ? '✓' : '✗'} ${pass}/${checks} spot-checks passed across ${rows.length} publishers`);
db.close();
process.exit(pass === checks ? 0 : 1);
