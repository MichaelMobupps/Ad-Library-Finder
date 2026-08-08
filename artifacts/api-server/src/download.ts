/**
 * Downloads, regenerated from the DATABASE at download time.
 *
 * WHY (order L-3.4g). A completion email hands the user two links — the result
 * CSV and the per-HQ-country .xlsx bundle. Until now both were served by
 * streaming a file out of `csv-output/` on the deployment's filesystem, and a
 * Reserved VM's disk does not survive a publish. So every emailed link died at
 * the next deploy, silently: the route answered 404 "CSV not yet ready" for a
 * job that had completed weeks earlier and whose rows were sitting right there
 * in the database.
 *
 * Nothing here touches the filesystem. The rows come from `job_results`, the
 * HQ resolutions come from the `hq_cache` table the split already populated,
 * and the bytes are built in memory. A link created after this order works for
 * as long as the job's rows exist, across any number of publishes.
 *
 * NO VENDOR CALLS, EVER. The original split resolves an unknown HQ by fetching
 * the store page and asking an LLM. Regeneration does NOT: a cache miss buckets
 * the row under "Unknown" exactly as an unresolvable row always did. A download
 * must not be able to spend money, take seconds, or block on somebody else's
 * rate limit — and a user clicking an old link must never trigger a paid API
 * call. In practice a completed job's rows are all cached, because the split
 * that ran during the job wrote every one of them.
 *
 * DETERMINISTIC. The manifest is stamped from the JOB's own timestamps rather
 * than from `new Date()`, so the same job downloaded twice — across a restart,
 * across a publish — produces byte-identical output. That is what makes
 * "the link answers identically before and after a restart" a testable claim
 * rather than an approximate one.
 */

import type { JobRow, JobResultRow } from './db.js';
import { getResults } from './db.js';
import { jobLeadCount } from './chief.js';
import { renderCsv, selectExportRows } from './csv.js';
import { lookupHqCache } from './hqCache.js';
import type { ResolvedHq } from './hqResolver.js';
import { countryToFilenameSlug, MOBILE_HQ_HEADER, mobileHqRow } from './hqSplit.js';
import { WEB_HQ_HEADER, webHqRow } from './hqSplitWeb.js';
import { buildXlsx } from './xlsxWriter.js';
import { buildZip, type ZipEntry } from './zipWriter.js';
import type { ProductType } from './db.js';

export interface RenderedCsv {
  filename: string;
  body: string;
  rows: number;
}

export interface RenderedZip {
  filename: string;
  body: Buffer;
  /** Per-HQ-country row counts, for the log line. */
  perCountryCounts: Record<string, number>;
  /** Rows whose HQ was never resolved (or whose cache entry is gone). */
  unresolved: number;
}

/**
 * The rows a job exports, straight from the database.
 *
 * `selectExportRows` with the job's own lead cap — the SAME selection the CSV,
 * the emailed .xlsx and the Chief's `/leads` all use. Reading the raw
 * `job_results` rows instead would hand back every advertiser the classifier
 * rejected, which is not what this app calls a lead.
 */
async function exportRowsFor(job: JobRow, productType: ProductType): Promise<JobResultRow[]> {
  return selectExportRows(await getResults(job.id), productType, jobLeadCount(job));
}

/**
 * The result CSV for a job.
 *
 * `productOverride` is the existing `?product=` recovery path: a mobile job
 * that happened to discover web leads can export them without re-scraping.
 * Returns null when the selection is empty, which the route turns into a 404 —
 * the same answer the old filesystem check gave for a job with no CSV.
 */
export async function renderJobCsv(job: JobRow, productOverride?: ProductType): Promise<RenderedCsv | null> {
  const productType = productOverride ?? job.product_type;
  const results = await getResults(job.id);
  const { csv, filename, rowsWritten } = renderCsv({
    jobId: job.id,
    productType,
    results,
    maxRows: jobLeadCount(job),
  });
  if (rowsWritten === 0) return null;
  return { filename, body: csv, rows: rowsWritten };
}

/**
 * The per-HQ-country .xlsx bundle for a job, rebuilt from stored rows plus the
 * HQ cache. Returns null when the job has no exportable rows.
 */
export async function renderJobHqZip(job: JobRow): Promise<RenderedZip | null> {
  const isMobile = job.product_type === 'mobile';
  const rows = await exportRowsFor(job, job.product_type);
  if (rows.length === 0) return null;

  const bucketed: Record<string, Array<{ result: JobResultRow; hq: ResolvedHq | null }>> = {};
  let unresolved = 0;

  for (const r of rows) {
    // The two splits cache under different keys, because they resolve different
    // things: a mobile lead's HQ is looked up from its STORE page, a web lead's
    // from its LANDING domain. Using one key for both would miss every hit.
    const cacheKey = isMobile ? r.store_url : r.landing_url;
    const hq = cacheKey ? await lookupHqCache(cacheKey) : null;
    if (!hq) unresolved++;
    const bucketKey = (hq?.primary_market || '').trim() || 'Unknown';
    (bucketed[bucketKey] ??= []).push({ result: r, hq });
  }

  const header = isMobile ? MOBILE_HQ_HEADER : WEB_HQ_HEADER;
  const shape = isMobile ? mobileHqRow : webHqRow;

  const zipEntries: ZipEntry[] = [];
  const perCountryCounts: Record<string, number> = {};
  // Sorted, so the zip's entry order is a property of the DATA rather than of
  // whatever order the buckets happened to be created in.
  for (const country of Object.keys(bucketed).sort()) {
    const items = bucketed[country];
    const slug = countryToFilenameSlug(country);
    const sheetRows: (string | number | null)[][] = [header, ...items.map((it) => shape(it.result, it.hq))];
    zipEntries.push({ path: `${slug}.xlsx`, data: buildXlsx({ name: slug.slice(0, 31), rows: sheetRows }) });
    perCountryCounts[country] = items.length;
  }

  const stamp = job.completed_at ?? job.started_at ?? job.created_at;
  const manifestLines = [
    `HQ split manifest for job ${job.id}`,
    // The JOB's time, not this download's — see the determinism note above.
    `Job completed: ${new Date(stamp).toISOString()}`,
    'Regenerated from the database at download time.',
    `Total rows considered: ${rows.length}`,
    `Rows with no resolved HQ: ${unresolved}`,
    'Per-country row counts:',
    ...Object.entries(perCountryCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([c, n]) => `  ${countryToFilenameSlug(c)}  (${c})  ${n}`),
  ];
  zipEntries.push({ path: 'manifest.txt', data: manifestLines.join('\n') + '\n' });

  return {
    filename: `${job.id}_by_hq.zip`,
    body: buildZip(zipEntries),
    perCountryCounts,
    unresolved,
  };
}
