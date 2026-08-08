/**
 * Lead mapping + "Send to Prospector" export (spec steps 12 & 13).
 *
 * One lead per publisher. Contact = the Play-published email + the store website.
 * The PREVIEW link is the publisher's top app store URL (chart-rank first, else
 * highest installs), placed ahead of the brand website — that is the column Email
 * Prospector auto-detects (`store_url`). Leads are de-duplicated on email, then
 * website domain, then normalized name so the same publisher never exports twice.
 *
 * The CSV is written with the same RFC-4180 + formula-injection guards the rest of
 * the app uses (csv.ts), and lands in csv-output/ like every other job export.
 */

import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { neutralizeFormula } from './csv.js';
import { mergeNameKey, registrableDomain } from './publisherRollup.js';
import { isSharedHost } from './storeDiscoveryConfig.js';
import { existingLeadIdentities, insertResult } from './db.js';
import type { PublisherRow } from './storeDiscoveryDb.js';

const CSV_DIR = path.resolve('csv-output');

function escapeCsv(v: string | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
const freeText = (v: string | null | undefined): string => escapeCsv(neutralizeFormula(v));

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** Pre-seeded dedupe state, so a batch can be de-duplicated against lead history. */
export interface DedupeSeed {
  /** Registrable domains already present in the Leadfinder lead store. */
  domains?: Iterable<string>;
  /** Normalized publisher/advertiser names already present. */
  names?: Iterable<string>;
}

/**
 * De-dupe publisher leads on email → website domain → normalized name, keeping the
 * first occurrence (callers pass highest-score-first). Exported for tests.
 *
 * Two DIFFERENT rules, because the two sources carry different keys:
 *
 *  • Against LEAD HISTORY (`seed`): job_results stores no email, so history can
 *    only be matched on domain and on normalized name. Both checks are
 *    UNCONDITIONAL, and name is a genuine THIRD FALLBACK — consulted whenever
 *    email and domain both miss, not only for publishers that have no website
 *    (spec step 12: email → domain → name). Gating it on `!domain` re-exported
 *    every publisher first exported WITHOUT a website: persistPublisherLeads
 *    wrote landing_url=null, so history holds its name and no domain, and when a
 *    later run's rollup filled the website in, the domain check missed and the
 *    name check was skipped. Nor may the checks be gated on the row lacking an
 *    email — doing so let a missing key (email, which history can never supply)
 *    veto the keys history does have, so every publisher with a Play email
 *    escaped the dedupe entirely and was re-exported on every run.
 *  • Within the BATCH: email is the strongest key, so a row with a fresh email is
 *    kept even if it shares a domain with an earlier row (two real contacts at one
 *    company are two leads). Domain and name are the fallbacks.
 */
export function dedupePublishers(rows: PublisherRow[], seed: DedupeSeed = {}): PublisherRow[] {
  const histDomain = new Set<string>(seed.domains ?? []);
  const histName = new Set<string>(seed.names ?? []);
  const seenEmail = new Set<string>();
  const seenDomain = new Set<string>();
  const seenName = new Set<string>();
  const out: PublisherRow[] = [];
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    // A shared platform host is not an identity. Many small developers list a
    // Facebook page or a sites.google.com page as their store website; keying
    // dedupe on that host would collapse them all into one lead — the same guard
    // the publisher MERGE already applies (mergeableDomains).
    const rawDomain = registrableDomain(r.website);
    const domain = rawDomain && !isSharedHost(rawDomain) ? rawDomain : '';
    // mergeNameKey, NOT normalizeName: normalizeName strips to [a-z0-9] and so
    // returns '' for a wholly non-Latin name ('株式会社ミクシィ', '카카오게임즈') or a
    // suffix-only Latin one ('Mobile Apps'). An empty key silently disables the name
    // fallback below, so such a publisher — with no email match possible, since
    // job_results has no email column — re-exported on EVERY run and accumulated a
    // duplicate job_results row each time. jp/kr/il/tr/br are all active markets.
    const name = mergeNameKey(r.name);
    // Already exported by an earlier job.
    if (domain && histDomain.has(domain)) continue;
    if (name && histName.has(name)) continue;
    // Already present earlier in this batch.
    if (email && seenEmail.has(email)) continue;
    if (!email && domain && seenDomain.has(domain)) continue;
    if (!email && !domain && name && seenName.has(name)) continue;
    if (email) seenEmail.add(email);
    if (domain) seenDomain.add(domain);
    if (name) seenName.add(name);
    out.push(r);
  }
  return out;
}

function storesLabel(r: PublisherRow): string {
  if (r.both_stores === 1) return 'both';
  if (r.play_developer_id) return 'google_play';
  if (r.apple_seller_name) return 'app_store';
  return '';
}

/**
 * The Prospector leadlist header.
 *
 * The first four columns are exactly the ones csv.ts emits for every other
 * pipeline (`advertiser_name,country,store_url,store`) — Email Prospector keys on
 * those header names and ignores extra columns, so the store-first signal columns
 * ride along after them without breaking ingest. `store_url` carries the app
 * preview link, deliberately ahead of the brand website (spec step 12).
 */
export const PUBLISHER_CSV_HEADER =
  'advertiser_name,country,store_url,store,email,website,verticals,markets,charted_apps,best_rank,gatc_ads_count,meta_ads,confirmed,is_game,score';

/**
 * The single country EP reads: the publisher's primary charted market, falling
 * back to any market it was discovered in. Without the fallback every long-tail
 * lead exported with an empty country, since only chart sightings populate
 * countries_charted.
 */
function primaryCountry(r: PublisherRow): string {
  const charted = parseJsonArray(r.countries_charted);
  if (charted.length > 0) return charted[0].toUpperCase();
  const seen = parseJsonArray(r.countries_seen);
  return seen.length > 0 ? seen[0].toUpperCase() : '';
}

/**
 * Which store the preview link points at. Always one of csv.ts's two values —
 * `storesLabel` can also say 'both' or '', which are outside the vocabulary the
 * header promises, so a publisher on both stores resolves by its preview link
 * and otherwise by whichever store identity it actually has.
 */
function storeOf(r: PublisherRow): string {
  const url = r.preview_url || '';
  if (url.includes('play.google.com')) return 'google_play';
  if (url.includes('apps.apple.com') || url.includes('itunes.apple.com')) return 'app_store';
  if (r.play_developer_id) return 'google_play';
  if (r.apple_seller_name) return 'app_store';
  return '';
}

export function publisherToCsvRow(r: PublisherRow): string {
  return [
    freeText(r.name), // advertiser_name
    escapeCsv(primaryCountry(r)),
    escapeCsv(r.preview_url), // store_url — the preview link, ahead of the brand website
    escapeCsv(storeOf(r)),
    // email and website come straight off a store listing, so they are just as
    // developer-controlled as the name and need the same formula-injection guard.
    freeText(r.email),
    freeText(r.website),
    escapeCsv(parseJsonArray(r.verticals).join('|')),
    // All markets the publisher was discovered in, not just charted ones —
    // otherwise the column is empty for the entire long tail.
    escapeCsv((parseJsonArray(r.countries_seen).length ? parseJsonArray(r.countries_seen) : parseJsonArray(r.countries_charted)).join('|')),
    escapeCsv(String(r.charted_app_count)),
    escapeCsv(r.best_rank == null ? '' : String(r.best_rank)),
    escapeCsv(r.gatc_ads_count == null ? '' : String(r.gatc_ads_count)),
    escapeCsv(r.meta_active_ads == null ? '' : String(r.meta_active_ads)),
    escapeCsv(r.confirmed_advertiser === 1 ? 'true' : 'false'),
    escapeCsv(r.is_game_publisher === 1 ? 'true' : 'false'),
    escapeCsv(String(r.score)),
  ].join(',');
}

/**
 * CSV for the VIEW export (GET /publishers.csv): the rows exactly as given —
 * no batch dedupe and no file. The route's contract is export-what-you-see; the
 * batch dedupe belongs to the pipeline's own "new since last run" feed
 * (buildPublisherCsv below), where a shared contact email means one lead. Two
 * distinct publisher ROWS legitimately share an email (the rollup never merges
 * on email), both render in the table, and both must appear in its download.
 * Building the string in memory also stops the per-download file leak the
 * old unique-token file naming caused — nothing ever pruned csv-output/.
 */
export function publisherViewCsv(rows: PublisherRow[]): string {
  return [PUBLISHER_CSV_HEADER, ...rows.map(publisherToCsvRow)].join('\n') + '\n';
}

export function buildPublisherCsv(
  jobId: string,
  rows: PublisherRow[],
  seed: DedupeSeed = {},
  maxRows: number | null = null,
): { path: string; rowsWritten: number; exported: PublisherRow[] } {
  if (!existsSync(CSV_DIR)) mkdirSync(CSV_DIR, { recursive: true });
  // Cap AFTER dedupe, never before: `rows` arrives score-descending, so slicing
  // first would hand the deduper N candidates and export however few survived —
  // a user asking for 20 leads would silently receive 14. Capping here means the
  // best N SURVIVING publishers, which is what "20 leads" means.
  const all = dedupePublishers(rows, seed);
  const deduped = maxRows != null && maxRows > 0 ? all.slice(0, maxRows) : all;
  const lines = [PUBLISHER_CSV_HEADER, ...deduped.map(publisherToCsvRow)];
  const csv = lines.join('\n') + '\n';
  const fpath = path.join(CSV_DIR, `store_first-${jobId}.csv`);
  const tmp = `${fpath}.tmp-${process.pid}`;
  writeFileSync(tmp, csv, 'utf8');
  renameSync(tmp, fpath);
  return { path: fpath, rowsWritten: deduped.length, exported: deduped };
}

/**
 * Build the dedupe seed from the Leadfinder lead store (spec step 12).
 * Domains and names are normalized with the SAME helpers the publisher rollup
 * uses, so "Acme, Inc." in history matches "Acme Inc" here.
 */
export async function leadHistorySeed(): Promise<DedupeSeed>{
  const { names, urls } = await existingLeadIdentities();
  const domains = new Set<string>();
  for (const u of urls) {
    const d = registrableDomain(u);
    // Same shared-host guard as the batch dedupe: one platform host in history
    // must not knock out every publisher that lists it as their website.
    if (d && !isSharedHost(d)) domains.add(d);
  }
  const normNames = new Set<string>();
  for (const n of names) {
    // Must be the SAME key function dedupePublishers uses, or the history seed and
    // the per-row check disagree and the dedupe silently stops matching.
    const k = mergeNameKey(n);
    if (k) normNames.add(k);
  }
  return { domains, names: normNames };
}

/**
 * Persist exported publishers into job_results, the shared lead store every other
 * pipeline writes to. Without this, store-first leads were invisible to the rest
 * of the app AND could never be de-duplicated against on a later run.
 */
export async function persistPublisherLeads(jobId: string, rows: PublisherRow[]): Promise<number>{
  let n = 0;
  for (const r of rows) {
    await insertResult({
      job_id: jobId,
      advertiser_name: r.name,
      page_url: r.website,
      landing_url: r.website,
      classification: storeOf(r) === 'app_store' ? 'mobile_app_store' : 'mobile_google_play',
      store_url: r.preview_url,
      ad_text: null,
      country: primaryCountry(r),
    });
    n++;
  }
  return n;
}

// ── offline unit tests ───────────────────────────────────────────────────────

export function runStoreLeadsTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  const mk = (o: Partial<PublisherRow>): PublisherRow => ({
    id: 0, merge_key: 'k', name: 'N', play_developer_id: null, apple_seller_name: null, website: null,
    email: null, countries_charted: '[]', countries_seen: '[]', verticals: '[]', charted_app_count: 0, app_count: 1, best_rank: null,
    both_stores: 0, in_band: 0, source_mix: '{}', gatc_advertiser_id: null, gatc_ads_count: null,
    meta_active_ads: null, confirmed_advertiser: 0, is_game_publisher: 0, is_charted: 0, preview_url: null,
    preview_title: null, score: 0, last_confirm_at: null, created_at: 0, updated_at: 0, ...o,
  });

  // Dedupe by email.
  const byEmail = dedupePublishers([
    mk({ id: 1, email: 'a@x.com', name: 'A' }),
    mk({ id: 2, email: 'A@X.com', name: 'A dup' }),
  ]);
  check(byEmail.length === 1 && byEmail[0].id === 1, 'dedupe: same email (case-insensitive) → 1');

  // Dedupe by website domain when no email.
  const byDomain = dedupePublishers([
    mk({ id: 1, website: 'https://acme.com' }),
    mk({ id: 2, website: 'http://www.acme.com/x' }),
  ]);
  check(byDomain.length === 1, 'dedupe: same website domain → 1');

  // Different emails survive even with same domain.
  const twoEmails = dedupePublishers([
    mk({ id: 1, email: 'a@acme.com', website: 'https://acme.com' }),
    mk({ id: 2, email: 'b@acme.com', website: 'https://acme.com' }),
  ]);
  check(twoEmails.length === 2, 'dedupe: distinct emails both kept');

  // Dedupe against lead history: a seeded domain/name knocks the publisher out.
  const seeded = dedupePublishers([mk({ id: 1, website: 'https://acme.com', name: 'Acme Inc' })], {
    domains: ['acme.com'],
  });
  check(seeded.length === 0, 'dedupe: seeded history domain drops the publisher');
  // Regression: an email must NOT veto the history checks. History has no email
  // column, so gating on it let every email-bearing publisher re-export forever.
  check(
    dedupePublishers([mk({ id: 1, email: 'a@acme.com', website: 'https://acme.com' })], { domains: ['acme.com'] })
      .length === 0,
    'dedupe: history domain still drops a publisher that HAS an email',
  );
  check(
    dedupePublishers([mk({ id: 1, email: 'a@acme.com', name: 'Acme Inc' })], { names: [mergeNameKey('Acme Inc')] })
      .length === 0,
    'dedupe: history name still drops an email-bearing publisher with no website',
  );
  // Regression: name is the THIRD FALLBACK, not a no-website special case. Run 1
  // exported this publisher with website=null, so job_results holds its NAME and
  // no landing_url; run 2's rollup filled a website in. Gating the name check on
  // `!domain` made the domain check miss and the name check unreachable, and the
  // publisher shipped to the operator a second time.
  check(
    dedupePublishers([mk({ id: 1, name: 'Acme Inc', website: 'https://acme.com' })], {
      names: [mergeNameKey('Acme Inc')],
    }).length === 0,
    'dedupe: history name drops a publisher that has since gained a website',
  );
  // Two real contacts at one company are two leads — batch domain dedupe must
  // still defer to distinct emails.
  check(
    dedupePublishers([
      mk({ id: 1, email: 'a@acme.com', website: 'https://acme.com' }),
      mk({ id: 2, email: 'b@acme.com', website: 'https://acme.com' }),
    ]).length === 2,
    'dedupe: distinct emails at one domain both survive within a batch',
  );
  const seededByName = dedupePublishers([mk({ id: 1, name: 'Acme, Inc.' })], {
    names: [mergeNameKey('Acme Inc')],
  });
  check(seededByName.length === 0, 'dedupe: seeded history name (normalized) drops the publisher');
  check(
    dedupePublishers([mk({ id: 1, website: 'https://other.com' })], { domains: ['acme.com'] }).length === 1,
    'dedupe: unrelated domain survives the history seed',
  );
  // A shared platform host must never act as an identity, from history or within
  // the batch — otherwise every developer listing a Facebook page collapses to one.
  check(
    dedupePublishers([mk({ id: 1, website: 'https://facebook.com/alpha' })], { domains: ['facebook.com'] }).length === 1,
    'dedupe: shared host in history does NOT drop a publisher',
  );
  check(
    dedupePublishers([
      mk({ id: 1, name: 'Alpha', website: 'https://facebook.com/alpha' }),
      mk({ id: 2, name: 'Beta', website: 'https://www.facebook.com/beta' }),
    ]).length === 2,
    'dedupe: two publishers sharing a platform host both survive',
  );

  // Regression: the name fallback keyed on normalizeName, which strips to [a-z0-9]
  // and so returned '' for a wholly non-Latin name — disabling the ONLY check that
  // could catch these (job_results stores no email, and these publishers often have
  // no usable website). They re-exported on every run, one duplicate row per run.
  // jp/kr/il/tr/br are all active markets, so this is the common case there.
  for (const nonLatin of ['株式会社ミクシィ', '카카오게임즈', 'Кэшбэк']) {
    check(
      mergeNameKey(nonLatin) !== '',
      `dedupe: non-Latin name "${nonLatin}" produces a usable dedupe key`,
    );
    check(
      dedupePublishers([mk({ id: 1, name: nonLatin, email: 'dev@example.jp' })], {
        names: [mergeNameKey(nonLatin)],
      }).length === 0,
      `dedupe: history name drops an already-exported "${nonLatin}"`,
    );
  }
  // Same hole for a Latin name that is nothing but company suffixes.
  check(mergeNameKey('Mobile Apps') !== '', 'dedupe: suffix-only Latin name still yields a key');
  check(
    dedupePublishers([mk({ id: 1, name: 'Mobile Apps' })], { names: [mergeNameKey('Mobile Apps')] }).length === 0,
    'dedupe: history name drops an already-exported suffix-only publisher',
  );
  // ...while distinct non-Latin publishers must still both survive.
  check(
    dedupePublishers([mk({ id: 1, name: '株式会社ミクシィ' }), mk({ id: 2, name: '카카오게임즈' })]).length === 2,
    'dedupe: two distinct non-Latin publishers both survive',
  );

  // CSV header must lead with the exact Prospector columns csv.ts emits, so
  // Email Prospector's ingest detects them and ignores the extra signal columns.
  const cols = PUBLISHER_CSV_HEADER.split(',');
  check(cols[0] === 'advertiser_name', 'csv: 1st column is advertiser_name (Prospector)');
  check(cols[1] === 'country', 'csv: 2nd column is country (Prospector)');
  check(cols[2] === 'store_url', 'csv: 3rd column is store_url (EP preview)');
  check(cols[3] === 'store', 'csv: 4th column is store (Prospector)');
  const row = publisherToCsvRow(
    mk({ name: 'Acme, Inc', email: 'a@acme.com', website: 'https://acme.com', countries_charted: '["us","gb"]', preview_url: 'https://play.google.com/store/apps/details?id=com.acme', confirmed_advertiser: 1, score: 77 }),
  );
  // Comma-free name so plain column indexing is valid here.
  const plainRow = publisherToCsvRow(mk({ name: 'Acme', countries_charted: '["us","gb"]' }));
  check(plainRow.split(',')[1] === 'US', 'csv: country is the primary charted market, uppercased');
  check(row.includes(',google_play,'), 'csv: store derived from the preview link');
  check(
    publisherToCsvRow(mk({ preview_url: 'https://apps.apple.com/us/app/x/id1' })).includes(',app_store,'),
    'csv: apple preview link → app_store',
  );
  // NB: a quoted field contains the delimiter, so split(',') is not a column
  // reader — assert on the emitted prefix/suffix instead.
  check(row.startsWith('"Acme, Inc",'), 'csv: name with comma quoted');
  check(row.includes('play.google.com'), 'csv: preview store url present');
  check(row.endsWith(',77'), 'csv: score last column');

  // Formula-injection guard on every developer-controlled free-text column.
  const evil = publisherToCsvRow(mk({ name: '=HYPERLINK(1)' }));
  check(evil.startsWith("'=HYPERLINK(1)") || evil.startsWith('"\'=HYPERLINK'), 'csv: formula neutralized on name');
  check(publisherToCsvRow(mk({ email: '=cmd|1' })).includes("'=cmd|1"), 'csv: formula neutralized on email');
  check(publisherToCsvRow(mk({ website: '+HYPERLINK(2)' })).includes("'+HYPERLINK(2)"), 'csv: formula neutralized on website');

  // `store` must always be one of csv.ts's two values, never 'both' or ''.
  check(publisherToCsvRow(mk({ both_stores: 1, play_developer_id: 'd' })).includes(',google_play,'),
    'csv: both-stores publisher resolves to a single store value');
  check(publisherToCsvRow(mk({ apple_seller_name: 'S' })).includes(',app_store,'),
    'csv: apple-only publisher without preview link → app_store');

  // View export (export-what-you-see): rows sharing a contact email are DISTINCT
  // rows in the table (the rollup never merges on email) and must all appear in
  // its CSV — the batch dedupe belongs only to the pipeline's history feed.
  const shared = [
    mk({ id: 1, name: 'Alpha Ltd', email: 'dev@whitelabel.com' }),
    mk({ id: 2, name: 'Beta GmbH', email: 'dev@whitelabel.com' }),
  ];
  check(
    publisherViewCsv(shared).trimEnd().split('\n').length === 3,
    'csv: view export keeps both shared-email rows (header + 2)',
  );
  check(
    dedupePublishers(shared).length === 1,
    'csv: …while the pipeline batch dedupe still collapses them',
  );

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeLeads.js') || process.argv[1].endsWith('storeLeads.ts'));
if (isMain) {
  const { passed, failed, failures } = runStoreLeadsTests();
  console.log(`storeLeads tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
