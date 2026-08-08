#!/usr/bin/env node
/**
 * Fast-lane (confirm-before-enrich) invariants.
 *
 * The pipeline can now roll up a Play publisher from LIST-payload identity
 * (developer + developerId, already present in chart/search/similar responses)
 * so it is confirmable on Ads Transparency before any 1.2 MB detail page is
 * fetched. That is only safe because `p:<developerId>` is byte-identical to the
 * key appIdentityKey() derives from store_app_detail.developer_id later — so the
 * full rollup UPDATES the same publisher row rather than creating a second one.
 *
 * This asserts exactly that, plus the honesty rules (a provisional row must not
 * invent an email/website or claim an install band) and the no-downgrade rule
 * (re-running the fast lane must not clobber enriched data).
 *
 * Runs against a THROWAWAY database: an ephemeral PostgreSQL cluster built by
 * pgtest.mjs when this script starts and deleted when it ends. It used to rely
 * on being launched from a temp cwd (db.ts resolved `data/` relative to the
 * working directory); since order L-3.4g there is no cwd-relative database to
 * escape from, and assertEphemeral() makes the isolation a checked property
 * rather than a launch convention.
 */
import { startCluster, assertEphemeral } from './pgtest.mjs';

const B = '/home/runner/workspace/artifacts/api-server/dist';
const cluster = await startCluster('fastlane');
process.env.DATABASE_URL = cluster.url;
assertEphemeral(process.env.DATABASE_URL);
const db = await import(`${B}/db.js`);
const { closeDatabase } = await import(`${B}/sql.js`);
await db.initDb();
const sd = await import(`${B}/storeDiscoveryDb.js`);
const { rollupProvisionalPlayPublishers, rollupPublishers } = await import(`${B}/publisherRollup.js`);
const raw = db.getDb();
const now = Date.now();
let fails = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); fails++; };

// 1. Discover 3 chart apps for ONE developer — list identity only, no enrichment.
for (let i = 1; i <= 3; i++) {
  await sd.upsertDiscoveredApp({
    store: 'google_play', app_id: `com.fl.app${i}`, title: `FL App ${i}`, vertical: 'finance',
    country: 'us', source: 'chart', discovery_depth: 0, chart: 'TOP_FREE', rank: i,
    list_developer: 'FastLane Studios',
  });
}
const { foldProvisionalPublishers } = await import(`${B}/publisherRollup.js`);
const prov = foldProvisionalPublishers(await sd.rawPlayListDeveloperGroups());
const mine = prov.find((p) => p.developer === 'FastLane Studios');
mine ? ok(`provisional found from LIST DATA ONLY: ${mine.developer} (${mine.app_count} apps, ${mine.charted_app_count} charted, best rank ${mine.best_rank})`)
     : bad('provisional publisher NOT found from list data');

// 2. The normal rollup sees NOTHING (nothing enriched) — the bug being fixed.
await rollupPublishers(() => {});
const beforeFast = (await sd.listPublishersByScore(9999)).filter((p) => p.name === 'FastLane Studios');
beforeFast.length === 0 ? ok('full rollup alone yields 0 publishers (unenriched corpus — the original problem)')
                        : bad(`full rollup unexpectedly produced ${beforeFast.length}`);

// 3. Fast lane creates it WITHOUT any detail fetch.
await rollupProvisionalPlayPublishers(() => {});
const afterFast = (await sd.listPublishersByScore(9999)).filter((p) => p.name === 'FastLane Studios');
afterFast.length === 1 ? ok(`fast lane created exactly 1 publisher with NO detail fetch (id ${afterFast[0].id}, charted=${afterFast[0].is_charted})`)
                       : bad(`expected 1 publisher, got ${afterFast.length}`);
const provisionalId = afterFast[0]?.id;
afterFast[0]?.email === null && afterFast[0]?.website === null
  ? ok('provisional row honestly leaves email/website null') : bad('provisional row invented contact details');
afterFast[0]?.in_band === 0 ? ok('in_band=0 (install count unknown until enrichment)') : bad('in_band claimed without installs');

// 4. Now ENRICH those apps and run the full rollup — must UPDATE, not duplicate.
for (let i = 1; i <= 3; i++) {
  await raw.prepare(`INSERT INTO store_app_detail
    (store,app_id,title,developer,developer_id,developer_email,developer_website,min_installs,genre_id,
     category_raw,is_game,store_updated_at,artist_id,seller_name,bundle_id,enrich_status,attempts,created_at,updated_at)
    VALUES ('google_play',?,?,?,?,?,?,500000,'FINANCE','Finance',0,?,NULL,NULL,NULL,'done',1,?,?)
    ON CONFLICT (store, app_id) DO UPDATE SET
      title = excluded.title, developer = excluded.developer, developer_id = excluded.developer_id,
      developer_email = excluded.developer_email, developer_website = excluded.developer_website,
      min_installs = excluded.min_installs, genre_id = excluded.genre_id, category_raw = excluded.category_raw,
      is_game = excluded.is_game, store_updated_at = excluded.store_updated_at,
      enrich_status = excluded.enrich_status, attempts = excluded.attempts, updated_at = excluded.updated_at`)
    .run(`com.fl.app${i}`, `FL App ${i}`, 'FastLane Studios', 'FastLaneDevId123',
         'hello@fastlane.example', 'https://fastlane.example', now, now, now);
}
await rollupPublishers(() => {});
const afterFull = (await sd.listPublishersByScore(9999)).filter((p) => p.name === 'FastLane Studios');
afterFull.length === 1
  ? ok(`full rollup MERGED into the same row — still exactly 1 publisher (id ${afterFull[0].id})`)
  : bad(`DUPLICATE PUBLISHERS: ${afterFull.length} rows for one developer`);
afterFull[0]?.id === provisionalId
  ? ok('same row id preserved across provisional -> full rollup')
  : bad(`row id changed ${provisionalId} -> ${afterFull[0]?.id} (identity not preserved)`);
afterFull[0]?.email === 'hello@fastlane.example'
  ? ok('full rollup filled in the contact details') : bad(`email not filled: ${afterFull[0]?.email}`);
afterFull[0]?.in_band === 1 ? ok('in_band now set from real installs') : bad('in_band not set after enrichment');

// 5. Re-running the fast lane must NOT downgrade the now-enriched row.
await rollupProvisionalPlayPublishers(() => {});
const afterRe = (await sd.listPublishersByScore(9999)).filter((p) => p.name === 'FastLane Studios');
afterRe[0]?.email === 'hello@fastlane.example' && afterRe.length === 1
  ? ok('fast lane skips a fully-enriched publisher (no downgrade, no duplicate)')
  : bad(`fast lane clobbered enriched data: email=${afterRe[0]?.email}, rows=${afterRe.length}`);

// 6. Confirmation queue accepts the provisional publisher (is_charted=1 tier).
await raw.prepare("DELETE FROM store_app_detail WHERE app_id LIKE 'com.fl.app%'").run();
await raw.prepare("DELETE FROM publishers WHERE name='FastLane Studios'").run();
await raw.prepare("DELETE FROM publisher_identity").run();
// A fresh RUN resets the fast lane's change detector (resetFastLaneCache is
// called at run start). Without this the detector correctly short-circuits —
// the corpus has not changed — and the deleted rows are not rebuilt.
const { resetFastLaneCache } = await import(`${B}/publisherRollup.js`);
resetFastLaneCache();
await rollupProvisionalPlayPublishers(() => {});
const q = (await sd.listPublishersForConfirmation()).filter((p) => p.name === 'FastLane Studios');
q.length === 1 ? ok('provisional publisher IS queued for Ads Transparency confirmation')
               : bad('provisional publisher not confirmable — the whole point is lost');

// 7. Two raw spellings of the same publisher fold into ONE group/row.
for (const [i, spelling] of [['9', 'Spelling Co, Inc.'], ['10', 'Spelling Co Inc']]) {
  await sd.upsertDiscoveredApp({
    store: 'google_play', app_id: `com.sp.app${i}`, title: `SP ${i}`, vertical: 'finance',
    country: 'us', source: 'chart', discovery_depth: 0, chart: 'TOP_FREE', rank: Number(i),
    list_developer: spelling,
  });
}
const folded = foldProvisionalPublishers(await sd.rawPlayListDeveloperGroups())
  .filter((p) => /spelling co/i.test(p.developer));
folded.length === 1 && folded[0].app_count === 2
  ? ok(`two spellings folded into one publisher (${folded[0].raw_developers.join(' + ')})`)
  : bad(`spelling fold failed: ${folded.length} group(s)`);

// 8. Change detector: once a pass has absorbed the current corpus, repeating it
//    with nothing newly discovered must cost nothing. (The pump calls this every
//    15s; a full pass measured ~4s on an 8,000-app corpus before this guard.)
await rollupProvisionalPlayPublishers(() => {});          // absorb the spelling rows
const noop = await rollupProvisionalPlayPublishers(() => {}); // now nothing has changed
noop.publishers === 0 && noop.skipped === 0
  ? ok('unchanged corpus short-circuits the fast lane (zero work)')
  : bad(`fast lane re-ran on an unchanged corpus (${noop.publishers} upserts, ${noop.skipped} skipped)`);
// ...and a NEW discovery must un-stick it.
await sd.upsertDiscoveredApp({
  store: 'google_play', app_id: 'com.sp.app11', title: 'SP 11', vertical: 'finance',
  country: 'us', source: 'chart', discovery_depth: 0, chart: 'TOP_FREE', rank: 11,
  list_developer: 'Later Arrival Ltd',
});
const after = await rollupProvisionalPlayPublishers(() => {});
after.publishers > 0
  ? ok('a new discovery re-arms the fast lane')
  : bad('fast lane stayed short-circuited after a new discovery — leads would stall');

// 9. A provisional upsert must NEVER downgrade a partially-enriched publisher.
//    Regression: it zeroed in_band/both_stores/is_game_publisher when a new
//    chart app of an already-enriched publisher had not itself enriched yet,
//    which silently dropped tail publishers out of the confirmation queue.
{
  for (const id of ['com.pe.a1', 'com.pe.a2']) {
    await sd.upsertDiscoveredApp({ store: 'google_play', app_id: id, title: 'PE', vertical: 'games',
      country: 'us', source: 'search', list_developer: 'Preserve Games' });
    await raw.prepare(`INSERT INTO store_app_detail
      (store,app_id,title,developer,developer_id,developer_email,developer_website,min_installs,genre_id,
       category_raw,is_game,store_updated_at,artist_id,seller_name,bundle_id,enrich_status,attempts,created_at,updated_at)
      VALUES ('google_play',?,?,?,?,?,?,200000,'GAME','Game',1,?,NULL,NULL,NULL,'done',1,?,?)
      ON CONFLICT (store, app_id) DO UPDATE SET
        title = excluded.title, developer = excluded.developer, developer_id = excluded.developer_id,
        developer_email = excluded.developer_email, developer_website = excluded.developer_website,
        min_installs = excluded.min_installs, genre_id = excluded.genre_id, category_raw = excluded.category_raw,
        is_game = excluded.is_game, store_updated_at = excluded.store_updated_at,
        enrich_status = excluded.enrich_status, attempts = excluded.attempts, updated_at = excluded.updated_at`)
      .run(id, 'PE', 'Preserve Games', 'PreserveDev', 'pe@ex.com', 'https://pe.example', now, now, now);
  }
  await rollupPublishers(() => {});
  const b = (await sd.listPublishersByScore(9999)).find((p) => p.name === 'Preserve Games');
  // A new, still-unenriched chart app arrives for the same publisher.
  await sd.upsertDiscoveredApp({ store: 'google_play', app_id: 'com.pe.a3', title: 'PE3', vertical: 'games',
    country: 'us', source: 'chart', chart: 'TOP_FREE', rank: 4, list_developer: 'Preserve Games' });
  resetFastLaneCache();
  await rollupProvisionalPlayPublishers(() => {});
  const a = (await sd.listPublishersByScore(9999)).find((p) => p.name === 'Preserve Games');
  a && b && a.in_band === b.in_band && a.is_game_publisher === b.is_game_publisher && a.email === 'pe@ex.com'
    ? ok('provisional upsert preserves a partially-enriched publisher (in_band/is_game/email intact)')
    : bad(`provisional upsert DOWNGRADED an enriched publisher: in_band ${b?.in_band}->${a?.in_band}, is_game ${b?.is_game_publisher}->${a?.is_game_publisher}`);
  // ...and it still RAISES the app_count for the newly-seen app.
  a && a.app_count >= (b?.app_count ?? 0)
    ? ok('provisional upsert still raises counters (app_count not lowered)')
    : bad(`app_count lowered ${b?.app_count}->${a?.app_count}`);
}

// 10. Preview app must be the group's BEST app, deterministically.
//     The lead's store_url comes from here. This previously relied on SQLite's
//     min()/max() bare-column rule, which is only defined when the query has
//     EXACTLY ONE min/max aggregate — this one has three, so the row was
//     implementation-defined and could have drifted silently on any SQLite
//     upgrade. Now a ROW_NUMBER window; this pins the outcome.
{
  await sd.upsertDiscoveredApp({ store: 'google_play', app_id: 'com.pvw.decoy1', title: 'Decoy 1',
    vertical: 'finance', country: 'us', source: 'search', list_developer: 'Preview Pick Co' });
  await sd.upsertDiscoveredApp({ store: 'google_play', app_id: 'com.pvw.mid', title: 'Mid',
    vertical: 'finance', country: 'us', source: 'chart', chart: 'TOP_FREE', rank: 60, list_developer: 'Preview Pick Co' });
  // Best app inserted LAST, so "first row wins" would pick the wrong one.
  await sd.upsertDiscoveredApp({ store: 'google_play', app_id: 'com.pvw.best', title: 'Best',
    vertical: 'finance', country: 'us', source: 'chart', chart: 'TOP_FREE', rank: 3, list_developer: 'Preview Pick Co' });
  const g = (await sd.rawPlayListDeveloperGroups()).find((r) => r.developer === 'Preview Pick Co');
  g && g.preview_app_id === 'com.pvw.best' && g.best_rank === 3
    ? ok('preview is the best-ranked chart app (deterministic, insertion-order independent)')
    : bad(`preview picked ${g?.preview_app_id} (expected com.pvw.best), best_rank=${g?.best_rank}`);
  // And it survives an unrelated insert (i.e. it is not order-of-scan luck).
  await sd.upsertDiscoveredApp({ store: 'google_play', app_id: 'com.other.zz', title: 'ZZ',
    vertical: 'finance', country: 'us', source: 'search', list_developer: 'Unrelated Co' });
  const g2 = (await sd.rawPlayListDeveloperGroups()).find((r) => r.developer === 'Preview Pick Co');
  g2?.preview_app_id === 'com.pvw.best' ? ok('preview stable across unrelated inserts')
                                        : bad('preview drifted after an unrelated insert');
}

console.log(fails === 0 ? '\nFAST LANE: all invariants hold' : `\nFAST LANE: ${fails} FAILED`);
await closeDatabase();
await cluster.stop();
process.exit(fails ? 1 : 0);
