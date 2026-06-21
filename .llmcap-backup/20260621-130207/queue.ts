import {
  getNextPendingJob,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  setJobPhase,
  setJobHqZipPath,
  appendLog,
  insertResult,
  getResults,
  getJob,
  JobRow,
} from './db.js';
import { scrapeQuery, RawAd, closeBrowser } from './scraper.js';
import { classify } from './classifier.js';
import { buildCsv } from './csv.js';
import { keywordsFor } from './keywords.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { runAffplusJob } from './affplusPipeline.js';
import { runAppgoblinJob } from './appgoblinPipeline.js';
import { runHqSplit } from './hqSplit.js';
import { log } from './logger.js';

const POLL_INTERVAL_MS = 2000;
let running = false;

export function startQueue() {
  if (running) return;
  running = true;
  log.info('queue processor started');
  void tick();
}

async function tick() {
  while (running) {
    try {
      const job = getNextPendingJob();
      if (job) {
        if (job.source === 'affplus') {
          await runAffplusJob(job);
        } else if (job.source === 'appgoblin') {
          await runAppgoblinJob(job);
        } else {
          await runMetaJob(job);
        }
      } else {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      log.error('queue tick error', err);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

async function runMetaJob(job: JobRow) {
  // markJobRunning sets phase='starting' / detail='launching browser'.
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };
  onLog('info', `job started: ${job.product_type}, countries=${job.countries}`);

  try {
    const countries: string[] = JSON.parse(job.countries);
    const keywords = keywordsFor(job.product_type);

    onLog('info', `using ${keywords.length} keywords × ${countries.length} countries`);

    const seenAdvertisers = new Set<string>();
    const collected: RawAd[] = [];

    const totalQueries = countries.length * keywords.length;
    let queryIdx = 0;

    for (const country of countries) {
      for (const keyword of keywords) {
        queryIdx++;
        setJobPhase(
          job.id,
          'scraping',
          `${country} / "${keyword}" (${queryIdx}/${totalQueries})`
        );
        onLog('info', `scrape ${country} / "${keyword}"`);
        const ads = await scrapeQuery(country, keyword, (m) => onLog('debug', m));
        let newCount = 0;
        for (const ad of ads) {
          const key = `${ad.advertiser_name.toLowerCase().trim()}|${country}`;
          if (seenAdvertisers.has(key)) continue;
          seenAdvertisers.add(key);
          collected.push(ad);
          newCount++;
        }
        onLog('info', `  +${newCount} new advertisers (${ads.length} ads on page)`);
      }
    }

    onLog('info', `scraping done: ${collected.length} unique advertisers`);
    onLog('info', `classifying landing URLs...`);
    setJobPhase(job.id, 'classifying', `0/${collected.length} advertisers`);

    let classified = 0;
    let matched = 0;
    for (const ad of collected) {
      const cls = await classify(ad.landing_url, ad.ad_text);
      const isMatch =
        (job.product_type === 'mobile' &&
          (cls.classification === 'mobile_google_play' || cls.classification === 'mobile_app_store')) ||
        (job.product_type === 'cps' && cls.classification === 'cps_web');

      insertResult({
        job_id: job.id,
        advertiser_name: ad.advertiser_name,
        page_url: ad.page_url,
        landing_url: ad.landing_url,
        classification: cls.classification,
        store_url: cls.store_url,
        ad_text: ad.ad_text,
        country: ad.country,
      });

      classified++;
      if (isMatch) matched++;
      if (classified % 10 === 0 || classified === collected.length) {
        setJobPhase(
          job.id,
          'classifying',
          `${classified}/${collected.length} advertisers (${matched} matched)`
        );
      }
      if (classified % 25 === 0) {
        onLog('info', `  classified ${classified}/${collected.length} (matched product type: ${matched})`);
      }
    }

    onLog('info', `classification done: ${matched} matched ${job.product_type}`);
    setJobPhase(job.id, 'building_csv', `writing CSV (${matched} matched rows)`);

    const allResults = getResults(job.id);
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
    });
    onLog('info', `CSV written: ${csvPath} (${rowsWritten} rows)`);

    // HQ split (mobile only). Fire-and-forget for failures inside the split:
    // we don't want a downstream HQ-resolution issue to fail the whole job.
    if (job.product_type === 'mobile') {
      setJobPhase(job.id, 'hq_splitting', `resolving HQ for ${rowsWritten} apps`);
      try {
        const outcome = await runHqSplit({ jobId: job.id, results: allResults, onLog });
        if (outcome.zipPath) {
          setJobHqZipPath(job.id, outcome.zipPath);
          const summary = Object.entries(outcome.perCountryCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([c, n]) => `${c}=${n}`)
            .join(', ');
          onLog('info', `hq-split: zip ready (${summary})`);
        }
        if (outcome.playBlocked) {
          onLog('warn', `hq-split: Play page-fetch was blocked/rate-limited — Android resolution may be degraded`);
        }
      } catch (err) {
        onLog('warn', `hq-split failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // markJobCompleted sets phase='done'.
    markJobCompleted(job.id, csvPath, { ads: collected.length, advertisers: rowsWritten });
    onLog('info', `job completed`);

    // Notify (fire-and-forget; we don't fail the job if the email fails)
    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh).then(() => onLog('info', 'notification dispatched')).catch((e) => {
        onLog('warn', `notification error: ${(e as Error).message}`);
      });
    }
  } catch (err) {
    const msg = (err as Error).message || 'unknown error';
    log.error(`job ${job.id} failed`, err);
    onLog('error', `job failed: ${msg}`);
    markJobFailed(job.id, msg);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobFailed(fresh).catch((e) => {
        onLog('warn', `failure notification error: ${(e as Error).message}`);
      });
    }
  }
}

process.on('SIGTERM', async () => {
  running = false;
  await closeBrowser();
});
process.on('SIGINT', async () => {
  running = false;
  await closeBrowser();
});