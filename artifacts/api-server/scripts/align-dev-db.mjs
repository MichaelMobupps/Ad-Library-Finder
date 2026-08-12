#!/usr/bin/env node
/**
 * Bring the DEV managed database up to the schema this repo ships — through the
 * app's own migrator, and through nothing else.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Replit's publish flow diffs the schema and offers SQL to reconcile it. The
 * reference side of that diff is the DEV database. When dev is behind the code —
 * which is the normal state, because tests only ever run against throwaway
 * clusters (assertEphemeral) and never touch the real one — the diff sees tables
 * in production that dev has never heard of and proposes to DELETE them.
 *
 * That is exactly what happened at the first publish after order L-3.5a:
 *
 *     ALTER TABLE "chief_spend_cursor" DISABLE ROW LEVEL SECURITY;
 *     DROP TABLE "chief_spend_cursor" CASCADE;
 *     DROP INDEX "idx_llm_spend_ts";
 *
 * Dev was still at migration 001. Production had run 002 at boot. The tool
 * concluded production was wrong. Approving it would have dropped the spend
 * cursor while `schema_migrations` still recorded 002 as applied — so no later
 * boot would ever recreate it, and spend reporting would have failed against a
 * missing table until someone noticed.
 *
 * THE STANDING RULE: a generated migration containing DROP is never approved.
 * The answer is not to hand-edit the generated SQL, it is to make the diff
 * empty by aligning dev first — with the same migrator production runs, so dev
 * and production reach the schema by the identical path.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 *
 * Migrations, and nothing else. Deliberately NOT initDb(), which also seeds the
 * chief principal, replays the rescue fixtures, garbage-collects sessions and
 * settles jobs left 'running'. Those are boot concerns; none of them belongs in
 * a schema alignment, and the smallest action that fixes the diff is the one
 * with the smallest chance of surprising somebody.
 *
 * Dry run by default — it prints what is pending and changes nothing. Pass
 * --apply to actually migrate. applyMigrations() is transactional and calls
 * assertNoDestructiveMigrations() first, so this can never itself run a DROP.
 *
 *   node scripts/align-dev-db.mjs            # show what is pending
 *   node scripts/align-dev-db.mjs --apply    # apply it
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const APPLY = process.argv.includes('--apply');

if (!process.env.DATABASE_URL) {
  console.error('✗ DATABASE_URL is not set. Nothing to align.');
  process.exit(1);
}

const { openDatabase, sql, closeDatabase } = await import(`${DIST}/sql.js`);
const { MIGRATIONS, applyMigrations, assertNoDestructiveMigrations } = await import(`${DIST}/migrations.js`);

// Refuse before connecting if the shipped set is destructive — the same gate the
// test suite runs, repeated here so this script cannot be the way one sneaks in.
assertNoDestructiveMigrations();

// describeBackend yields host:port/database and nothing else — no user, no
// password, no raw URL. Printed so it is always obvious WHICH database moved.
const backend = await openDatabase();
console.log(`database: ${backend}`);

const h = sql();
await h.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id integer PRIMARY KEY, name text NOT NULL, applied_at bigint NOT NULL
);`);
const recorded = (await h.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all()).map((r) => Number(r.id));
const pending = MIGRATIONS.filter((m) => !recorded.includes(m.id));

console.log(`recorded: ${recorded.join(', ') || '(none)'}`);
console.log(`shipped:  ${MIGRATIONS.map((m) => m.id).join(', ')}`);

if (pending.length === 0) {
  console.log('\n✓ already current — the publish diff should propose nothing.');
  await closeDatabase();
  process.exit(0);
}

console.log(`\npending: ${pending.map((m) => `${m.id} (${m.name})`).join(', ')}`);

if (!APPLY) {
  console.log('\nSQL that would run:\n');
  for (const m of pending) {
    for (const line of m.sql.trim().split('\n')) console.log(`  ${line}`);
  }
  console.log('\nDry run — nothing was changed. Re-run with --apply to migrate.');
  await closeDatabase();
  process.exit(0);
}

const outcome = await applyMigrations(sql());
console.log(`\n✓ applied: ${outcome.applied.join(', ') || '(none)'}`);
if (outcome.adopted.length > 0) {
  console.log(`! ADOPTED (recorded without running): ${outcome.adopted.join(', ')}`);
  console.log('  That should not happen here. Investigate before publishing.');
}
console.log(`  schema is now: ${outcome.current.sort((a, b) => a - b).join(', ')}`);
console.log('\nThe publish diff should now propose nothing. If it still offers a DROP, stop and investigate.');

await closeDatabase();
