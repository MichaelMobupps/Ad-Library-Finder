/**
 * Per-(store_url) cache of resolved HQ records.
 *
 * The hqResolver makes one Anthropic call per app. Apptica/Affplus jobs
 * frequently surface the same store URLs across runs (same publisher across
 * pages, same offer carrying multiple platform tags collapsed to one row).
 * Caching by store_url means the second hit costs zero LLM tokens.
 *
 * Table is additive-idempotent: it just stores the JSON-serialized ResolvedHq
 * keyed on store_url. No TTL — store URLs are stable identifiers and the
 * resolved HQ rarely changes for a given app. Operator can wipe via SQL if
 * a known misresolution needs to be re-queried.
 */

import { getDb } from './db.js';
import type { ResolvedHq } from './hqResolver.js';
import { log } from './logger.js';

export interface HqCacheRow {
  store_url: string;
  resolved_json: string;
  created_at: number;
}

export async function ensureHqCacheTable(): Promise<void>{
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hq_cache (
      store_url TEXT PRIMARY KEY,
      resolved_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export async function lookupHqCache(storeUrl: string): Promise<ResolvedHq | null>{
  if (!storeUrl) return null;
  const row = await getDb()
    .prepare(`SELECT resolved_json FROM hq_cache WHERE store_url = ?`)
    .get(storeUrl) as { resolved_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.resolved_json) as ResolvedHq;
  } catch (err) {
    log.warn(`hq_cache: bad JSON for ${storeUrl}, ignoring — ${(err as Error).message}`);
    return null;
  }
}

export async function storeHqCache(storeUrl: string, resolved: ResolvedHq): Promise<void>{
  if (!storeUrl) return;
  const now = Date.now();
  await getDb()
    .prepare(
      `INSERT INTO hq_cache (store_url, resolved_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(store_url) DO UPDATE SET resolved_json = excluded.resolved_json, created_at = excluded.created_at`
    )
    .run(storeUrl, JSON.stringify(resolved), now);
}

/** Count rows in cache — used by integration tests to verify cache hits. */
export async function countHqCache(): Promise<number>{
  const row = await getDb().prepare(`SELECT COUNT(*) AS n FROM hq_cache`).get() as { n: number };
  return row.n;
}

/** Test helper: delete a single entry (NOT exposed as a route). */
export async function deleteHqCacheEntry(storeUrl: string): Promise<void>{
  await getDb().prepare(`DELETE FROM hq_cache WHERE store_url = ?`).run(storeUrl);
}