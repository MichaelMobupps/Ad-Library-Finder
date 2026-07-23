# CLAUDE CODE PROMPT — Leadfinder: GATC App Advertiser Discovery Module

Copy everything below this line into Claude Code, run from the Leadfinder repo root.

---

## ROLE AND DISCIPLINE

You are the sole implementer on the Leadfinder Replit project. Think first. Read before you write. Deliver the minimum solution that fully achieves the goal. Make surgical edits inside existing patterns. Verify against the goal at the end.

**Never scrape adstransparency.google.com directly. Every Google Ads Transparency Center request goes through the paid API provider using the key in Replit Secrets.**

## GOAL

Add a discovery module named "App Advertisers" to Leadfinder. Its job: harvest the maximum number of advertisers currently running ads that promote a mobile app (Google Play listing, Apple App Store listing, or APK download) from the Google Ads Transparency Center (GATC), classify them, deduplicate them, score them, and store them as leads.

## WHY THE QUERY DOCTRINE BELOW WORKS (read before coding)

GATC search matches exactly two things: verified advertiser names and destination domains. It never matches ad copy text. Maximum yield therefore comes from three query classes:

1. **Class A. Destination domain queries.** A domain query returns ads from every advertiser account whose ads land on that domain. App install ads land on app store and APK host domains.
2. **Class B. MMP and tracking click domains.** Advertisers routing clicks through mobile measurement partners are performance app advertisers. These are the highest commercial value leads.
3. **Class C. Advertiser name token queries.** Keyword search matches legal entity names. Mobile app companies cluster around predictable name tokens ("Games", "Studio", "PTE. LTD.", "Network Technology").

One more lever: the GATC platform filter. Every ad served on the `google_play` surface is an app promotion ad by definition. Use it as the first-pass fetch for every advertiser.

Each advertiser search query returns at most 100 advertisers. Many narrow queries beat one broad query. Fan out.

## STEP 0. RECON (do this before writing any code)

1. Map the repo: stack, package manager, HTTP client pattern, DB layer and schema location, job/cron pattern, UI framework, existing lead schema.
2. Find any existing ad library integration (Meta Ad Library or similar) and note its module structure. Mirror it.
3. Check Replit Secrets for `SEARCHAPI_KEY` and `SERPAPI_KEY`.
4. If exactly one key exists, use that provider. If both exist, use the provider already used elsewhere in the codebase.
5. If neither key exists: **HALT** and ask Michael one question: "SearchAPI.io or SerpApi for GATC? I need the key added to Replit Secrets as SEARCHAPI_KEY or SERPAPI_KEY." Do not proceed without it.
6. Post a 10-line recon summary before implementation.

## API REFERENCE

### SearchAPI.io (two endpoints)

Advertiser search (keyword to advertisers + domains):

```
GET https://www.searchapi.io/api/v1/search
  ?engine=google_ads_transparency_center_advertiser_search
  &q=<QUERY>
  &region=<REGION>          # default: anywhere
  &num_advertisers=100      # max 100
  &num_domains=100          # max 100
  &api_key=<SEARCHAPI_KEY>
```

Returns: `advertisers[]` with `name`, `id` (AR...), `region`, `ads_count.lower/upper`, `is_verified`, plus `domains[]`.

Ads fetch (advertiser or domain to creatives):

```
GET https://www.searchapi.io/api/v1/search
  ?engine=google_ads_transparency_center
  &advertiser_id=<AR_ID>[,<AR_ID>...]   # or use domain=<DOMAIN> instead
  &region=<REGION>
  &platform=google_play                  # also: google_search, youtube, google_shopping, google_maps
  &time_period=last_30_days
  &api_key=<SEARCHAPI_KEY>
```

Returns: `ad_creatives[]` with creative id, format, target/destination data, and `search_information.total_results`.

### SerpApi (single endpoint, if that is the chosen provider)

```
GET https://serpapi.com/search
  ?engine=google_ads_transparency_center
  &text=<QUERY>                # free text, or advertiser_id=<AR_ID>
  &region=<REGION>
  &platform=PLAY               # also: SEARCH, YOUTUBE, SHOPPING, MAPS
  &num=100
  &api_key=<SERPAPI_KEY>
```

Paginate with `next_page_token`.

## SEED QUERY BATTERY (store these exact values as seed rows)

Class A, store and APK destination domains (run as domain / text queries):

```
play.google.com
apps.apple.com
itunes.apple.com
apkpure.com
apkcombo.com
uptodown.com
aptoide.com
appgallery.huawei.com
galaxystore.samsung.com
```

Class B, MMP and tracking click domains (run as domain / text queries; tag resulting advertisers `mmp_tracked=true`):

```
onelink.me
app.link
adj.st
go.link
sng.link
smart.link
appsflyer.com
adjust.com
branch.io
kochava.com
singular.net
```

Class C, advertiser name tokens (run through the advertiser search endpoint):

```
games
gaming
game studio
studios
interactive
entertainment
mobile
apps
app
play
casino
slots
puzzle
vpn
dating
network technology
information technology
internet technology
pte. ltd
labs
media limited
```

Region sweep list (run every query once per region; keep configurable in one constants file):

```
anywhere, US, GB, DE, FR, ES, IT, NL, PL, IN, BR, MX, ID, VN, PH, TH, JP, KR, TR, SA, AE, IL
```

Note: EU regions and Türkiye also expose unverified advertisers, so EU passes catch advertisers invisible in US-region results.

## IMPLEMENTATION STEPS

1. Create table `gatc_queries`: `id, query, class (A/B/C), query_type (domain|keyword), region, status (active|retired|candidate), runs, advertisers_found, app_advertisers_found, yield_ratio, last_run_at`. Seed it with the battery above.
2. Create table `gatc_advertisers`: `advertiser_id (PK), name, region, ads_count_lower, ads_count_upper, is_verified, mmp_tracked (bool), first_seen_at, source_query_id`.
3. Create table `gatc_app_ads`: `creative_id (PK), advertiser_id (FK), platform, format, destination_url, destination_domain, store (google_play|app_store|apk|mmp_tracked|unknown), app_id, last_seen_at`.
4. Write the classifier as one pure function with unit tests. Rules, in priority order:
   1. Destination matches `play.google.com/store/apps/details` with `id=([A-Za-z0-9._]+)` → `store=google_play`, `app_id=<package>`.
   2. Destination matches `apps.apple.com` or `itunes.apple.com` with `/id(\d+)` → `store=app_store`, `app_id=<numeric id>`.
   3. Destination scheme `market://` → `store=google_play`.
   4. Destination domain in the Class A APK host list → `store=apk`.
   5. Destination domain in the Class B MMP list → `store=mmp_tracked`.
   6. Otherwise `store=unknown` (keep the row only if platform was `google_play`).
5. Write the runner (single entry point, wired into the existing job pattern): for each active query × region, call the provider, upsert advertisers, then for each new advertiser fetch creatives with `platform=google_play` first; if that returns zero, fetch once without the platform filter and classify every creative.
6. Enforce the budget cap: constant `GATC_MAX_API_CALLS_PER_RUN=300`. Count every outbound request. On reaching the cap, stop cleanly and print a summary (calls used, advertisers found, app advertisers found, estimated USD cost).
7. After each run, update `yield_ratio = app_advertisers_found / advertisers_found` per query. After 3 runs, set `status=retired` on any query with `yield_ratio < 0.10`. Keep retirement thresholds in the constants file.
8. Keyword expansion loop: tokenize the names of confirmed app advertisers, count token frequency across the corpus, and insert the top 20 tokens that are not yet in `gatc_queries` as `status=candidate` Class C rows. Candidates run only after manual activation in the UI.
9. Map confirmed app advertisers into the existing Leadfinder lead schema. Dedupe on advertiser_id first, then on normalized company name. Use the Google Play / App Store URL of the advertiser's app as the preview link on the lead, ahead of any brand website.
10. UI: add an "App Advertisers" section following the existing Leadfinder UI patterns. Columns: advertiser name, GATC profile link (`https://adstransparency.google.com/advertiser/<AR_ID>`), stores, app IDs linked to their store pages, ad count range, regions seen, MMP flag, score, first seen. Include CSV export and a query management view (activate/retire queries, activate candidates, per-query yield).
11. Scoring (0 to 100, weights in the constants file): ads_count_upper scaled (40), mmp_tracked (25), present in both stores (15), seen in 3+ regions (10), active in last 30 days (10).

## CALIBRATION RULE

Treat the seed battery as hypotheses. GATC behavior on mega-domains like `play.google.com` is undocumented and may return capped, region-dependent, or empty results. The `gatc_queries` yield table is the source of truth. Keep what performs, retire what does not, and report the top 10 queries by app advertisers found in the run summary.

## VERIFICATION (goal-driven, run before declaring done)

1. Unit tests for the classifier pass, including all six rule branches.
2. Smoke run with the cap set to 30 calls and three queries only: `play.google.com` (Class A), `onelink.me` (Class B), `games` (Class C), region `anywhere`. Assert at least one advertiser stored with a correctly extracted `app_id`, end to end.
3. Manually sample 5 stored `gatc_app_ads` rows and confirm the `app_id` opens a real store listing.
4. Typecheck gate, then tests gate (use `tail -20` for vitest), then build. Halt on any gate failure and report.
5. Print the run summary table.

## CONSTRAINTS

1. Reuse the existing HTTP client, DB layer, and job patterns. No new frameworks.
2. Never log API keys or full request URLs containing keys.
3. Keep every tunable (query battery, regions, caps, thresholds, weights) in one constants file with comments.
4. If any decision has two reasonable options and the codebase does not settle it, ask one short question instead of choosing silently.
