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
 *        c. POST-RESOLVE FILTERS (downstream of EP feedback):
 *             - Drop candidates whose similarity score < MIN_SCORE (0.5):
 *               low-confidence matches like "LEX"→"Lex: Queer Social LGBT
 *               Friends" (j=0.20) or "MyCashery"→… (j=0.20) poison the CSV.
 *             - Drop offers whose OFFER NAME, CLEANED NAME, or any RESOLVED
 *               TITLE matches the dating/LGBT keyword set. Belt-and-suspenders
 *               for offers whose Affplus vertical tag is not a clean "Dating"
 *               (e.g. LEX carried RevShare/CPA only). Conservative — keyword
 *               list does not match mainstream social apps.
 *        d. Collapse to ONE row per offer (pick the highest-scoring platform).
 *        e. Dedupe globally by resolved store_url (in case two distinct
 *           offers resolve to the same app).
 *   5. buildCsv produces the mobile CSV. The header is "store_url" (NOT
 *      "preview_url"): Email Prospector auto-detects the store-URL column by
 *      header name, and its alias list includes store_url but not preview_url.
 *   6. After CSV: runHqSplit produces an HQ-bucketed .zip (mobile only).
 *
 * Operator-visible job log records: pages fetched, skip-list count,
 * unresolved/dropped count, dating-name-skip count, low-score-drop count,
 * resolved count, sample dropped reasons.
 */

import {
  appendLog,
  insertResult,
  getResults,
  clearJobResults,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  setJobPhase,
  setJobHqZipPath,
  getJob,
  deferJob,
  JobRow,
} from './db.js';
import { BudgetExceededError, nextJerusalemMidnightMs, DAILY_CAP_USD } from './llmBudget.js';
import { listOffers, AffplusOffer, Platform as AffPlatform } from './affplusScraper.js';
import { cleanOfferName } from './nameCleaner.js';
import { resolveAndVerify, Platform as ResolvePlatform, ResolvedStore } from './storeResolver.js';
import { buildCsv } from './csv.js';
import { notifyJobCompleted, notifyJobFailed } from './notifier.js';
import { runHqSplit } from './hqSplit.js';
import { verticalDecision, looksScammy } from './webPolicy.js';
import { resolveWebDestination, makeSearchBudget, normalizeWebOffer } from './webResolver.js';
import { log } from './logger.js';

const PAGES_PER_PLATFORM = Number(process.env.AFFPLUS_PAGES_PER_PLATFORM) || 3;
const RESOLVER_DELAY_MS = Number(process.env.AFFPLUS_RESOLVER_DELAY_MS) || 400;

/** Web/CPS path: pages of Desktop listing per country. */
const WEB_PAGES_PER_COUNTRY = Number(process.env.AFFPLUS_WEB_PAGES_PER_COUNTRY) || PAGES_PER_PLATFORM;
/** Web/CPS path: per-job cap on PAID name searches across all offers. */
const WEB_MAX_SEARCHES = Number(process.env.AFFPLUS_WEB_MAX_SEARCHES) || 40;
/** Web/CPS path: polite delay between per-offer destination resolutions. */
const WEB_RESOLVE_DELAY_MS = Number(process.env.AFFPLUS_WEB_RESOLVE_DELAY_MS) || RESOLVER_DELAY_MS;

/**
 * Minimum Jaccard score for a resolved candidate to be accepted into the CSV.
 * The verifier in storeResolver.ts will accept on a substring-match path with
 * any score; this is a second-stage gate downstream of EP feedback that low
 * scores (j<0.5) are almost always wrong matches.
 */
const MIN_SCORE = 0.5;

/**
 * Dating / LGBT-dating keyword skip list. Applied to the offer name, the
 * cleaned name, AND every resolved candidate title. Designed to catch offers
 * like "LEX: Queer Social LGBT Friends" whose Affplus vertical tag is not a
 * clean "Dating" (and so passes the upstream listOffers skip-list).
 *
 * Conservative: tokens are matched on word boundaries so "gay" does not match
 * "gaymer" or random substrings, and the list does NOT include generic terms
 * like "social", "chat", "friends", "meet" which would over-skip mainstream
 * social apps (Facebook, WhatsApp, Discord, Snapchat).
 */
const DATING_KEYWORDS = [
  'dating',
  'hookup',
  'hookups',
  'lgbt',
  'lgbtq',
  'queer',
  'lesbian',
  'gay',
  'grindr',
  'tinder',
  'bumble',
  'okcupid',
  'badoo',
  'hinge',
  'flirt',
  'singles',
  'romance',
  'crush',
  'kink',
  'fetish',
  'nsfw',
];

function looksLikeDating(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const kw of DATING_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(lower)) return true;
  }
  return false;
}

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
  // markJobRunning sets phase='starting' / detail='launching browser'.
  markJobRunning(job.id);
  const onLog = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => {
    appendLog(job.id, level, msg);
    log.info(`[job ${job.id}] ${msg}`);
  };

  onLog('info', `affplus job started: countries=${job.countries}`);

  try {
    // Resume-safety: a job deferred for the daily cap replays from the top.
    // Drop any rows it inserted on the prior run so the deliverable is not
    // duplicated. Runs before the cps/mobile branch, so it covers both paths.
    // No-op on a fresh job.
    clearJobResults(job.id);

    const countries: string[] = JSON.parse(job.countries);

    // Web/CPS path is a separate flow: it resolves to advertiser websites, not
    // app stores, and skips store-resolution + HQ-split entirely. The mobile
    // flow below is unchanged; the shared catch / notifier wraps both.
    if (job.product_type === 'cps') {
      await runAffplusWebJob(job, countries, onLog);
      return;
    }

    // 1+2+3. Gather offers across (country × platform), dedup by slug.
    type Tagged = { offer: AffplusOffer; sourcePlatform: AffPlatform; country: string };
    const seenSlugs = new Set<string>();
    const tagged: Tagged[] = [];
    let totalSkipped = 0;
    let totalPages = 0;

    const platforms: AffPlatform[] = ['Android', 'iOS'];
    const totalLists = countries.length * platforms.length;
    let listIdx = 0;

    for (const country of countries) {
      for (const platform of platforms) {
        listIdx++;
        setJobPhase(
          job.id,
          'scraping',
          `Affplus ${platform} / ${country} (${listIdx}/${totalLists})`
        );
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

    // 4. Resolve + verify each offer; emit ONE row per offer (best candidate).
    setJobPhase(job.id, 'classifying', `verifying 0/${tagged.length} offers against stores`);

    let resolvedCount = 0;
    let droppedCount = 0;
    let datingNameSkipped = 0;
    let lowScoreSkipped = 0;
    let storeUrlDupSkipped = 0;
    const droppedSamples: DroppedSample[] = [];
    const insertedStoreUrls = new Set<string>();

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

      // Early dating-by-name guard on the offer itself. Most LGBT-dating
      // offers have it in the name or cleaned name; this avoids burning
      // resolver calls on them.
      if (looksLikeDating(offer.name) || looksLikeDating(cleaned)) {
        datingNameSkipped++;
        droppedCount++;
        if (droppedSamples.length < 8) {
          droppedSamples.push({
            name: offer.name,
            cleaned,
            platform: sourcePlatform === 'Android' ? 'android' : 'ios',
            reason: 'dating/LGBT keyword in offer name (pre-resolve)',
          });
        }
        continue;
      }

      const targets = platformsFor(offer, sourcePlatform);

      // Collect all successful resolutions across target platforms.
      const candidates: Array<{ resolved: ResolvedStore; platform: ResolvePlatform }> = [];
      const rejectionReasons: DroppedSample[] = [];

      for (const target of targets) {
        const outcome = await resolveAndVerify(cleaned, target);
        if (outcome.resolved) {
          candidates.push({ resolved: outcome.resolved, platform: target });
        } else {
          rejectionReasons.push({
            name: offer.name,
            cleaned,
            platform: target,
            reason: outcome.reason || 'no match',
          });
        }
        await sleep(RESOLVER_DELAY_MS + Math.random() * 300);
      }

      // Post-resolve dating filter: catches offers like LEX whose name is
      // innocuous but whose resolved Play/iTunes title is "Lex: Queer Social
      // LGBT Friends".
      const datingTitle = candidates.find((c) => looksLikeDating(c.resolved.candidateTitle));
      if (datingTitle) {
        datingNameSkipped++;
        droppedCount++;
        if (droppedSamples.length < 8) {
          droppedSamples.push({
            name: offer.name,
            cleaned,
            platform: datingTitle.platform,
            reason: `dating/LGBT keyword in resolved title "${datingTitle.resolved.candidateTitle}"`,
          });
        }
        continue;
      }

      // Score floor.
      const qualified = candidates.filter((c) => c.resolved.score >= MIN_SCORE);
      if (qualified.length === 0) {
        droppedCount++;
        if (candidates.length > 0) {
          lowScoreSkipped++;
          if (droppedSamples.length < 8) {
            const best = candidates.reduce((a, b) =>
              a.resolved.score >= b.resolved.score ? a : b
            );
            droppedSamples.push({
              name: offer.name,
              cleaned,
              platform: best.platform,
              reason: `best score ${best.resolved.score.toFixed(2)} < floor ${MIN_SCORE} ("${best.resolved.candidateTitle}")`,
            });
          }
        } else {
          // No verified candidates at all — record the resolver's reason
          // from the first platform attempt.
          if (rejectionReasons.length > 0 && droppedSamples.length < 8) {
            droppedSamples.push(rejectionReasons[0]);
          }
        }
        continue;
      }

      // Collapse to one row per offer: pick the highest-scoring candidate.
      qualified.sort((a, b) => b.resolved.score - a.resolved.score);
      const best = qualified[0];
      const alt = qualified.length > 1 ? qualified[1] : null;

      // Global dedupe by store URL — in case two distinct offers resolve to
      // the same app listing (rare but possible).
      if (insertedStoreUrls.has(best.resolved.storeUrl)) {
        storeUrlDupSkipped++;
        droppedCount++;
        continue;
      }
      insertedStoreUrls.add(best.resolved.storeUrl);

      const classification =
        best.platform === 'android' ? 'mobile_google_play' : 'mobile_app_store';
      const altSuffix = alt
        ? ` · alt_${alt.platform === 'android' ? 'play' : 'itunes'}: ${alt.resolved.storeUrl}`
        : '';

      insertResult({
        job_id: job.id,
        advertiser_name: offer.name,
        page_url: `https://www.affplus.com/o/${offer.slug}`,
        landing_url: best.resolved.storeUrl,
        classification,
        store_url: best.resolved.storeUrl,
        ad_text: `Network: ${offer.network} · Verticals: ${offer.verticals.join(', ')} · Resolved: "${best.resolved.candidateTitle}" (j=${best.resolved.score.toFixed(2)})${altSuffix}`,
        country: offer.geo || country,
      });
      resolvedCount++;

      if (processed % 5 === 0 || processed === tagged.length) {
        setJobPhase(
          job.id,
          'classifying',
          `verifying ${processed}/${tagged.length} offers (${resolvedCount} matched)`
        );
      }

      if (processed % 10 === 0) {
        onLog(
          'info',
          `affplus: resolved ${resolvedCount}, dropped ${droppedCount} (processed ${processed}/${tagged.length})`
        );
      }
    }

    onLog(
      'info',
      `affplus: resolve phase done — ${resolvedCount} verified rows, ${droppedCount} dropped (low-score ${lowScoreSkipped}, dating-name ${datingNameSkipped}, store-url dup ${storeUrlDupSkipped})`
    );
    if (droppedSamples.length > 0) {
      onLog('info', 'affplus: dropped samples:');
      for (const d of droppedSamples) {
        onLog('info', `  - "${d.name}" → cleaned "${d.cleaned}" (${d.platform}): ${d.reason}`);
      }
    }
    onLog('info', `affplus: skip-list filtered ${totalSkipped} adult/dating/cam/nutra/sweep offers`);

    setJobPhase(job.id, 'building_csv', `writing CSV (${resolvedCount} verified rows)`);

    // 5. Build CSV using existing mobile schema (header is now "store_url").
    const allResults = getResults(job.id);
    const { path: csvPath, rowsWritten } = buildCsv({
      jobId: job.id,
      productType: job.product_type,
      results: allResults,
    });
    onLog('info', `affplus: CSV written: ${csvPath} (${rowsWritten} rows)`);

    // 6. HQ split. Mobile-only, non-fatal on failure.
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
          onLog('info', `affplus hq-split: zip ready (${summary})`);
        }
        if (outcome.playBlocked) {
          onLog('warn', `affplus hq-split: Play page-fetch was blocked/rate-limited — Android resolution may be degraded`);
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        onLog('warn', `affplus hq-split failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // markJobCompleted sets phase='done'.
    markJobCompleted(job.id, csvPath, { ads: tagged.length, advertisers: rowsWritten });
    onLog('info', `affplus job completed`);

    const fresh = getJob(job.id);
    if (fresh) {
      void notifyJobCompleted(fresh)
        .then(() => onLog('info', 'notification dispatched'))
        .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const runAfter = nextJerusalemMidnightMs();
      const when = new Date(runAfter).toISOString();
      deferJob(job.id, runAfter, `LLM daily cap ($${DAILY_CAP_USD}) reached; resumes after ${when}`);
      onLog('warn', `affplus job deferred: LLM daily cap reached; resumes after ${when} (Jerusalem midnight)`);
      return;
    }
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

// ---------------------------------------------------------------------------
// Web / CPS flow (productType=cps). Resolves advertiser websites, not stores.
// Errors propagate to runAffplusJob's shared catch / failure notifier.
// ---------------------------------------------------------------------------

type WebLogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

async function runAffplusWebJob(job: JobRow, countries: string[], onLog: WebLogFn): Promise<void> {
  onLog('info', `affplus web/CPS job started: countries=${countries.join(', ')}`);

  // 1. Gather the Desktop listing across countries, dedup by slug. The mobile
  //    skip-list is bypassed in Web mode (it drops the web targets); webPolicy
  //    is the filter instead.
  type Tagged = { offer: AffplusOffer; country: string };
  const seen = new Set<string>();
  const tagged: Tagged[] = [];
  let totalPages = 0;
  let totalGeoMatch = 0;
  let totalListed = 0;
  let idx = 0;

  for (const country of countries) {
    idx++;
    setJobPhase(job.id, 'scraping', `Affplus Web / ${country} (${idx}/${countries.length})`);
    onLog('info', `affplus-web: listing Desktop / geo=${country}`);
    const { offers, pagesFetched } = await listOffers({
      platform: 'Web',
      geo: country,
      maxPages: WEB_PAGES_PER_COUNTRY,
      onLog: (m) => onLog('debug', m),
    });
    totalPages += pagesFetched;
    let added = 0;
    let geoMatch = 0;
    for (const offer of offers) {
      if ((offer.geo || '').toUpperCase() === country.toUpperCase()) geoMatch++;
      if (seen.has(offer.slug)) continue;
      seen.add(offer.slug);
      tagged.push({ offer, country });
      added++;
    }
    totalGeoMatch += geoMatch;
    totalListed += offers.length;
    onLog('info', `affplus-web: Desktop/${country} → ${offers.length} offers (${added} new, ${geoMatch} geo-match), ${pagesFetched} pages`);
  }
  // Geo binding is unverified for platforms=Desktop and recon saw params get
  // normalized away. If nothing came back tagged with a requested country, the
  // geos filter is probably not binding and every row's country is suspect.
  if (totalListed > 0 && totalGeoMatch === 0) {
    onLog('warn', `affplus-web: ZERO offers matched the requested geo across ${totalListed} listed — affplus geos filter may not be binding for Desktop; verify country targeting before trusting the CSV`);
  }
  onLog('info', `affplus-web: listing phase done — ${tagged.length} unique offers, ${totalPages} total pages, ${totalGeoMatch}/${totalListed} geo-match`);

  // 2. Cheap free gates first (vertical + scam on name/verticals), then resolve
  //    survivors to a real advertiser destination. The paid name search inside
  //    the resolver is capped per-job by this shared budget.
  setJobPhase(job.id, 'classifying', `resolving 0/${tagged.length} web offers`);
  const budget = makeSearchBudget(WEB_MAX_SEARCHES);

  let resolved = 0;
  let verticalBlocked = 0;
  let scamBlocked = 0;
  let unresolved = 0; // detail / intermediary / search dead-ends
  let brandTagged = 0;
  let dupHostSkipped = 0;
  const insertedHosts = new Set<string>();
  let processed = 0;

  for (const { offer, country } of tagged) {
    processed++;
    const advertiserName = normalizeWebOffer(offer.name).name;

    // Cheap gate A: vertical decision on tags alone (category not yet known).
    if (verticalDecision(offer.verticals) === 'block') {
      verticalBlocked++;
      continue;
    }
    // Cheap gate B: scam screen over name + verticals (free, pre-fetch).
    if (looksScammy(`${offer.name} ${offer.verticals.join(' ')}`)) {
      scamBlocked++;
      continue;
    }

    const dest = await resolveWebDestination({
      slug: offer.slug,
      offerName: offer.name,
      network: offer.network,
      verticals: offer.verticals,
      onLog,
      searchBudget: budget,
    });

    if (!dest) {
      unresolved++;
    } else if (insertedHosts.has(dest.finalHost)) {
      // One row per advertiser host: the operator dedups brands, not campaigns.
      dupHostSkipped++;
    } else {
      insertedHosts.add(dest.finalHost);
      if (dest.brandMismatch) brandTagged++;
      const mismatchNote = dest.brandMismatch ? ' · brand-mismatch: verify advertiser' : '';
      insertResult({
        job_id: job.id,
        advertiser_name: advertiserName,
        page_url: `https://www.affplus.com/o/${offer.slug}`,
        landing_url: dest.websiteUrl, // CPS CSV writes landing_url into website_url
        classification: 'cps_web',
        store_url: null,
        ad_text: `Network: ${offer.network} · Verticals: ${offer.verticals.join(', ')}${dest.category ? ` · Category: ${dest.category}` : ''} · Resolved via ${dest.reason}${mismatchNote}`,
        country: offer.geo || country,
      });
      resolved++;
    }

    if (processed % 5 === 0 || processed === tagged.length) {
      setJobPhase(job.id, 'classifying', `resolving ${processed}/${tagged.length} web offers (${resolved} kept)`);
    }
    if (processed % 10 === 0) {
      onLog(
        'info',
        `affplus-web: resolved ${resolved}, vertical-blocked ${verticalBlocked}, scam-blocked ${scamBlocked}, unresolved ${unresolved} (processed ${processed}/${tagged.length}, searches left ${budget.remaining()})`
      );
    }
    if (processed < tagged.length && WEB_RESOLVE_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, WEB_RESOLVE_DELAY_MS));
    }
  }

  onLog(
    'info',
    `affplus-web: resolve phase done — ${resolved} advertiser rows (${brandTagged} brand-mismatch tagged), vertical-blocked ${verticalBlocked}, scam-blocked ${scamBlocked}, unresolved ${unresolved}, host-dup ${dupHostSkipped}; name-searches used ${WEB_MAX_SEARCHES - budget.remaining()}/${WEB_MAX_SEARCHES}`
  );
  // The name search is the primary resolution path (the preview link is JS-bound),
  // so an exhausted budget silently caps yield. Make that visible.
  if (budget.remaining() === 0 && unresolved > 0) {
    onLog('warn', `affplus-web: name-search budget (${WEB_MAX_SEARCHES}) fully consumed with ${unresolved} offers unresolved — raise AFFPLUS_WEB_MAX_SEARCHES to resolve more (cost rises with it)`);
  }

  // 3. CSV using the existing CPS schema: advertiser_name,country,website_url,ad_text.
  setJobPhase(job.id, 'building_csv', `writing CPS CSV (${resolved} rows)`);
  const allResults = getResults(job.id);
  const { path: csvPath, rowsWritten } = buildCsv({
    jobId: job.id,
    productType: job.product_type,
    results: allResults,
  });
  onLog('info', `affplus-web: CSV written: ${csvPath} (${rowsWritten} rows)`);
  if (rowsWritten === 0) {
    onLog('warn', `affplus-web: CSV is empty — 0 advertiser destinations resolved. Check the warnings above (geo binding, detail parse, search budget) before concluding affplus has no inventory`);
  }

  // No HQ-split for web/CPS (mobile-only feature).
  markJobCompleted(job.id, csvPath, { ads: tagged.length, advertisers: rowsWritten });
  onLog('info', `affplus web/CPS job completed`);

  const fresh = getJob(job.id);
  if (fresh) {
    void notifyJobCompleted(fresh)
      .then(() => onLog('info', 'notification dispatched'))
      .catch((e) => onLog('warn', `notification error: ${(e as Error).message}`));
  }
}