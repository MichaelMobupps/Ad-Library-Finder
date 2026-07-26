/**
 * Job cancellation ("Stop" button) support.
 *
 * The stop request is a DB flag (jobs.cancel_requested) set by the API route, so
 * it works across the request/worker boundary and survives nothing being in
 * memory: pipelines poll the flag between work items via throwIfCancelled() and
 * unwind with JobCancelledError. Each pipeline's catch turns that into
 * markJobCancelled — KEEPING everything scraped so far (partial CSV / results),
 * which is the whole point of a mid-run stop.
 *
 * Reads are throttled per job (CHECK_INTERVAL_MS) so a tight loop can call
 * throwIfCancelled on every iteration without paying a sqlite read each time.
 */

import { getDb } from './db.js';

export class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} stopped by user`);
    this.name = 'JobCancelledError';
  }
}

const CHECK_INTERVAL_MS = 750;

/** jobId → { at: last DB read, cancelled: last answer }. Entries are dropped on
 *  clearCancelState so a re-run of the same id (deferred jobs replay) starts clean. */
const lastCheck = new Map<string, { at: number; cancelled: boolean }>();

/** True when a stop has been requested for this job. Throttled DB read. */
export function isCancelRequested(jobId: string): boolean {
  const now = Date.now();
  const cached = lastCheck.get(jobId);
  // A cancelled answer is sticky — a stop is never un-requested mid-run.
  if (cached && (cached.cancelled || now - cached.at < CHECK_INTERVAL_MS)) {
    return cached.cancelled;
  }
  const row = getDb().prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(jobId) as
    | { cancel_requested: number }
    | undefined;
  const cancelled = !!row && row.cancel_requested === 1;
  lastCheck.set(jobId, { at: now, cancelled });
  return cancelled;
}

/** Unwind the pipeline when a stop has been requested. Call between work items. */
export function throwIfCancelled(jobId: string): void {
  if (isCancelRequested(jobId)) throw new JobCancelledError(jobId);
}

/** Drop the cached answer for a job (called when a run starts, so a job id that
 *  re-enters the worker — e.g. after a defer — re-reads the flag fresh). */
export function clearCancelState(jobId: string): void {
  lastCheck.delete(jobId);
}
