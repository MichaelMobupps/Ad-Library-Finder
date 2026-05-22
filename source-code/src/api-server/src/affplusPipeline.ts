/**
 * Affplus job pipeline.
 *
 * Parallel path to scraper.ts (Meta). For an Affplus job:
 *
 *   1. For each country (job.countries), fetch BOTH Android and iOS
 *      listing pages from Affplus (or one platform if the job is restricted).
 *   2. Skip-list filter happens inside listOffers (Adult/Dating/Cam/Nutra/
 *      Sweepstake verticals dropped).
 *   3. Dedup by slug (an offer may appear on multiple pages or both
 *      platform lists).
 *   4. For each surviving offer:
 *        a. Clean the name (nameCleaner.cleanOfferName).
 *        b. Resolve store URL on each platform tag the offer carries
 *           (Android → Play, iOS → iTunes) and verify match.
 *        c. If verification passes, write a job_results row with
 *           classification='mobile_google_play'|'mobile_app_store' and
 *           store_url set. If not, drop and increment unresolved counter.
 *   5. buildCsv produces the same mobile CSV schema the operator already
 *      expects. notifyJobCompleted runs the same way.
 *
 * Operator-visible job log records: pages fetched, skip-list count,
 * unresolved/dropped count, resolved count, sample dropped reasons.
 */

import {
  appendLog,
  insertResult,
  getResults,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  getJob,
  JobRow,
} from './db.js';
import { listOffers, AffplusOffer, Platform as AffPlatform } from './affplusScraper.js';
import { cleanOfferName } from './nameCleaner.js';
import { resolveAndVerify, Platform as ResolvePlatform } from './storeResolver.js';
import { buildCsv } from './csv.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { log } from './logger.js';

const PAGES_PER_PLATFORM = Number(process.env.AFFPLUS_PAGES_PER_PLATFORM) || 3;
const RESOLVER_DELAY_MS = Number(process.env.AFFPLUS_RESOLVER_DELAY_MS) || 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DroppedSample {
  name: string;
  cleaned: string;
  platform: ResolvePlatform;
  reason: string;
}

/**
 * Pick which platforms an offer should be resolved against, based on the
 * verticals tags. An Affplus offer fetched from ?platforms=Android may
 * carry both Mobile + Android + iOS tags (some listings span both). We
 * prefer the source-list platform but allow both if the tags claim both.
 */
function platformsFor(offer: AffplusOffer, sourcePlatform: AffPlatform): ResolvePlatform[] {
  const tagSet = new Set(offer.verticals.map((v) => v.toLowerCase()));
  const out: ResolvePlatform[] = [];
  // The platform we fetched from is always tried.
  out.push(sourcePlatform === 'Android' ? 'android' : 'ios');
  // If verticals also call out the other, include it. We expect this to be
  // rare; usually the listing platform is authoritative.
  if (sourcePlatform === 'Android' && tagSet.has('ios')) out.push('ios');
  if (sourcePlatform === 'iOS' && tagSet.has('android')) out.push('android');
  return out;
}

export async function runAffplusJob(job: JobRow): Promise<void> {
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };

  onLog('info', `affplus job started: countries=${job.countries}`);

  try {
    const countries: string[] = JSON.parse(job.countries);

    // 1+2+3. Gather offers across (country × platform), dedup by slug.
    type Tagged = { offer: AffplusOffer; sourcePlatform: AffPlatform; country: string };
    const seenSlugs = new Set<string>();
    const tagged: Tagged[] = [];
    let totalSkipped = 0;
    let totalPages = 0;

    const platforms: AffPlatform[] = ['Android', 'iOS'];

    for (const country of countries) {
      for (const platform of platforms) {
        onLog('info', `affplus: listing ${platform} / geo=${country}`);
        const { offers, skippedCount, pagesFetched } = await listOffers({
          platform,
          geo: country,
          maxPages: PAGES_PER_PLATFORM,
          onLog: (m) => onLog('debug', m),
        });
        totalSkipped += skippedCount;
        totalPages += pagesFetched;
        let added = 0;
        for (const offer of offers) {
          const key = offer.slug;
          if (seenSlugs.has(key)) continue;
          seenSlugs.add(key);
          tagged.push({ offer, sourcePlatform: platform, country });
          added++;
        }
        onLog('info', `affplus: ${platform}/${country} → ${offers.length} offers (${added} new), ${skippedCount} skipped by skip-list, ${pagesFetched} pages`);
      }
    }

    onLog('info', `affplus: listing phase done — ${tagged.length} unique offers, ${totalSkipped} skipped, ${totalPages} total pages`);

    // 4. Resolve + verify each offer.
    let resolvedCount = 0;
    let droppedCount = 0;
    const droppedSamples: DroppedSample[] = [];

    let processed = 0;
    for (const { offer, sourcePlatform, country } of tagged) {
      processed++;
      const cleaned = cleanOfferName(offer.name);
      if (!cleaned) {
        droppedCount++;
        if (droppedSamples.length < 8) {
          droppedSamples.push({
            name: offer.name,
            cleaned: '',
            platform: sourcePlatform === 'Android' ? 'android' : 'ios',
            reason: 'cleaned name empty after stripping',
          });
        }
        continue;
      }

      const targets = platformsFor(offer, sourcePlatform);

      let anyResolved = false;
      for (const target of targets) {
        const outcome = await resolveAndVerify(cleaned, target);
        if (outcome.resolved) {
          const classification = target === 'android' ? 'mobile_google_play' : 'mobile_app_store';
          insertResult({
            job_id: job.id,
            advertiser_name: offer.name, // preserve original for transparency
            page_url: `https://www.affplus.com/o/${offer.slug}`,
            landing_url: outcome.resolved.storeUrl,
            classification,
            store_url: outcome.resolved.storeUrl,
            ad_text: `Network: ${offer.network} · Verticals: ${offer.verticals.join(', ')} · Resolved: "${outcome.resolved.candidateTitle}" (j=${outcome.resolved.score.toFixed(2)})`,
            country: offer.geo || country,
          });
          resolvedCount++;
          anyResolved = true;
        } else if (droppedSamples.length < 8) {
          droppedSamples.push({
            name: offer.name,
            cleaned,
            platform: target,
            reason: outcome.reason || 'no match',
          });
        }
        await sleep(RESOLVER_DELAY_MS + Math.random() * 300);
      }

      if (!anyResolved) droppedCount++;

      if (processed % 10 === 0) {
        onLog('info', `affplus: resolved ${resolvedCount}, dropped ${droppedCount} (processed ${processed}/${tagged.length})`);
      }
    }

    onLog('info', `affplus: resolve phase done — ${resolvedCount} verified rows, ${droppedCount} dropped`);
    if (droppedSamples.length > 0) {
      onLog('info', 'affplus: dropped samples:');
      for (const d of droppedSamples) {
        onLog('info', `  - "${d.name}" → cleaned "${d.cleaned}" (${d.platform}): ${d.reason}`);
      }
    }
    onLog('info', `affplus: skip-list filtered ${totalSkipped} adult/dating/cam/nutra/sweep offers`);

    // 5. Build CSV using existing mobile schema.
    const allResults = getResults(job.id);
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
    });
    onLog('info', `affplus: CSV written: ${csvPath} (${rowsWritten} rows)`);

    markJobCompleted(job.id, csvPath, { ads: tagged.length, advertisers: rowsWritten });
    onLog('info', `affplus job completed`);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh)
        .then(() => onLog('info', 'notification dispatched'))
        .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
    }
  } catch (err) {
    const msg = (err as Error).message || 'unknown error';
    log.error(`affplus job ${job.id} failed`, err);
    onLog('error', `affplus job failed: ${msg}`);
    markJobFailed(job.id, msg);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobFailed(fresh).catch((e) => onLog('warn', `failure notification error: ${(e as Error).message}`));
    }
  }
}