# CLAUDE CODE PROMPT — Leadfinder: Store-First Discovery + Long Tail (Combined)

Run from the Leadfinder repo root. This is the full spec for one session. It replaces GATC as the discovery engine and adds long-tail discovery in the same build. Think first, minimum solution, surgical edits inside existing patterns, verify against the goal.

**Discovery comes from app store data. GATC and Meta Ad Library are confirmation layers only, never discovery. A publisher found outside the top charts is never marked a confirmed advertiser without a GATC or Meta hit.**

## WHY (read before coding)

GATC search matches only advertiser names and verified domains, caps at 100 advertisers per query, hides full destination URLs, and hides unverified advertisers outside the EU. It cannot enumerate app advertisers. The stores can: top chart positions imply active paid UA, Play listings expose the developer's contact email, and the store's own graph (similar apps, developer catalogs, store search) reaches the long tail. So the pipeline is: store discovery produces publishers, enrichment produces contacts and categories, GATC and Meta confirm ad activity and feed the score.

## STEP 0. RECON

1. Map the repo: stack, HTTP client pattern, DB layer, job/cron pattern, UI framework, existing lead schema, constants location.
2. Identify any existing GATC discovery module and its tables. If present, it gets demoted in step 14, never deleted.
3. Confirm `SEARCHAPI_KEY` exists in Replit Secrets. Check whether `SCRAPECREATORS_API_KEY` exists (optional, Meta confirmation).
4. Check whether `google-play-scraper` (npm) installs in this Replit. If installation fails, use the SearchAPI `google_play` engine as the Play source and say so in the recon summary.
5. Post a 10-line recon summary before implementation.

## DATA SOURCES (exact)

Play charts, primary (free): `google-play-scraper` npm.
- Charts: `gplay.list({ category, collection: gplay.collection.TOP_FREE | TOP_GROSSING, country, num: 500 })`
- Full detail: `gplay.app({ appId, country })` returns `developer, developerId, developerEmail, developerWebsite, installs, minInstalls, genre, genreId, updated, free, offersIAP`
- Similar apps: `gplay.similar({ appId, country })`
- Developer catalog: `gplay.developer({ devId, country: 'us' })`
- Store search: `gplay.search({ term, country, num: 30 })`
- Throttle 1 request per second. Cache app details permanently.

Play charts, fallback (paid, same key): `https://www.searchapi.io/api/v1/search?engine=google_play&store_device=phone&chart=topselling_free|topgrossing&category=<CATEGORY>&gl=<COUNTRY>&api_key=<SEARCHAPI_KEY>`

Apple charts, primary (free, official): `https://rss.applemarketingtools.com/api/v2/<country>/apps/top-free/200/genre=<GENRE_ID>/apps.json` (omit the genre segment for all categories). Lowercase country codes.

Apple charts, fallback (paid, same key): SearchAPI `engine=apple_app_store_top_charts` with `category` and `country`.

Apple app detail and catalogs (free, official):
- Detail: `https://itunes.apple.com/lookup?id=<ID1>,<ID2>,...&country=us` in batches up to 100. Fields: `sellerName, sellerUrl, artistId, artistName, primaryGenreId, genreIds, primaryGenreName, bundleId`.
- Developer catalog: `https://itunes.apple.com/lookup?id=<artistId>&entity=software&country=us`
- Store search: `https://itunes.apple.com/search?term=<TERM>&country=<CC>&entity=software&limit=200`
- Throttle 10 requests per minute across all iTunes endpoints.

GATC confirmation (paid, existing key): advertiser search `engine=google_ads_transparency_center_advertiser_search` with `q=<developer name>` and separately `q=<developer website domain>`, `region=anywhere`. Record best-matching advertiser id and `ads_count`.

Meta confirmation (optional, only if `SCRAPECREATORS_API_KEY` exists): `https://api.scrapecreators.com/v1/facebook/adLibrary/search/ads?query=<app title>` with header `x-api-key`. Count active ads whose `link` contains `play.google.com`, `apps.apple.com`, `itunes.apple.com`, `onelink.me`, `app.link`, `adj.st`, `go.link`, `sng.link`, or `smart.link`. If the key is absent, skip Meta confirmation and leave its score component at 0.

## CONFIG (constants file, exact seed values)

Markets: `us, gb, de, fr, in, br, mx, id, jp, kr, tr, il`. Default active: `us, gb, de`.

Vertical map:
- finance → Play `FINANCE`, Apple genre `6015`
- shopping → Play `SHOPPING`, Apple genre `6024`
- health_fitness → Play `HEALTH_AND_FITNESS`, Apple genre `6013`
- entertainment → Play `ENTERTAINMENT`, Apple genre `6016`
- social → Play `SOCIAL`, Apple genre `6005`
- productivity → Play `PRODUCTIVITY`, Apple genre `6007`
- travel → Play `TRAVEL_AND_LOCAL`, Apple genre `6003`
- education → Play `EDUCATION`, Apple genre `6017`
- games → Play `GAME` plus every `GAME_*` subcategory constant, Apple genre `6014`

Charts: Play `TOP_FREE` + `TOP_GROSSING`; Apple `top-free`.

Long-tail tunables: `SIMILAR_MAX_DEPTH=2`, `SIMILAR_MAX_APPS_PER_RUN=5000`, `TAIL_MIN_INSTALLS=50000`, `TAIL_MAX_INSTALLS=5000000`, `CONFIRMATION_MAX_API_CALLS_PER_RUN=200`.

`TAIL_SEARCH_TERMS`: 15 terms per vertical, seed finance with `loan app, personal loan, budget tracker, money transfer, crypto wallet, trading app, cashback, credit score, invoice app, savings app, bnpl, forex, stock alerts, expense manager, instant loan` and generate equivalent lists for the other active verticals.

## IMPLEMENTATION STEPS

1. Create table `discovered_apps`: `id, store, app_id, title, vertical, country, source (chart|similar|developer_catalog|search), discovery_depth, chart, rank, first_seen_at, last_seen_at, last_rank`. Unique on (store, app_id, country). Chart rows carry chart and rank; other sources leave them null.
2. Create table `publishers`: `id, name, play_developer_id, apple_seller_name, website, email, countries_charted (json), verticals (json), charted_app_count, best_rank, both_stores (bool), source_mix (json), gatc_advertiser_id, gatc_ads_count, meta_active_ads, confirmed_advertiser (bool), is_game_publisher (bool), score, created_at`.
3. Chart harvester job: for each active vertical × active market × chart × store, pull the chart (Play num=500, Apple 200), upsert `discovered_apps` with `source=chart`, `discovery_depth=0`.
4. Similar-apps crawl job (Play): seeds are all chart apps of active verticals. For each seed call `gplay.similar`, store results with `source=similar`, `discovery_depth=parent+1`. Never crawl from an app at `SIMILAR_MAX_DEPTH`. Stop at `SIMILAR_MAX_APPS_PER_RUN` new apps.
5. Search battery job: for each active vertical × active market, run every `TAIL_SEARCH_TERMS` entry against Play search and iTunes search. Store with `source=search`.
6. Enrichment job with permanent cache and retry cap 3. Play: full detail per app; capture email, website, developerId, minInstalls, genreId, updated. Apple: batched iTunes lookup; capture sellerName, sellerUrl, artistId, genres. Category rule: `is_game=true` when Play `genreId` starts with `GAME` or Apple `primaryGenreId` is `6014` or `genreIds` contains `6014`; store `category_raw` from the store's own value.
7. Install-band gate (Play only): non-chart apps outside `TAIL_MIN_INSTALLS..TAIL_MAX_INSTALLS` skip further enrichment and confirmation but remain stored. Chart apps are exempt. Enrichment order: chart apps first, then non-chart by minInstalls descending, then by most recent `updated`.
8. Developer catalog expansion: for every publisher with an email or website, fetch the full Play and Apple portfolios, store with `source=developer_catalog`, and attach the apps to the publisher.
9. Publisher rollup: group by Play developerId and Apple sellerName; merge across stores when website domain or normalized name matches. One publisher row per entity with its app portfolio, `is_game_publisher` true when the majority of its apps are games.
10. Confirmation job, budgeted by `CONFIRMATION_MAX_API_CALLS_PER_RUN`. Queue order: (a) charted publishers, (b) in-band tail publishers with email, (c) in-band tail publishers without email. Per publisher: two GATC advertiser searches (name, website domain); store advertiser id and ads_count; Meta search only when the key exists. `confirmed_advertiser=true` for charted publishers when ads_count > 0 or Meta store-link ads > 0. Tail-only publishers require a GATC or Meta hit; no chart fallback exists for them.
11. Scoring (0 to 100, weights in constants). Charted publishers: best rank scaled (25), 2+ countries (15), 2+ charted apps (10), both stores (10), GATC ads_count scaled (25), Meta store-link ads (15). Tail-only publishers: GATC ads_count scaled (40), Meta store-link ads (20), install band midpoint proximity (20), portfolio 2+ (10), updated within 90 days (10). Include `NON_GAME_BONUS` (default 0) applied when `is_game_publisher=false`.
12. Lead mapping: one lead per publisher. Contact fields: email from Play, website from either store. Preview link: the top-ranked (or highest-install) app's store URL, ahead of the brand website. Dedupe against existing Leadfinder leads on email, then website domain, then normalized name.
13. "Send to Prospector" export: CSV matching the Prospector leadlist format, store URLs as preview links.
14. If an old GATC discovery module exists: keep the code, set its domain-based query rows to `status=retired` with note `structural: domain search resolves domain owners only`, leave name-token rows inactive by default, and keep its advertiser view as a secondary tab.
15. UI: publisher table as the primary view: name, email, website, verticals, markets, source mix, charted apps, best rank, install band, stores, GATC ads count, Meta ads, confirmed flag, game flag, score. Filters: vertical, market, source, is_game, confirmed-only, has-email-only. Discovery funnel widget in the run summary: apps by source, in-band, enriched, publishers, confirmed. CSV export.

## VERIFICATION (goal-driven, run before declaring done)

1. Unit tests: the is_game rule (Play GAME_CASUAL positive, Play FINANCE negative, Apple 6014 positive, Apple 6015 negative), the install-band gate, and the publisher merge on matching website domain.
2. Smoke run: vertical `finance`, market `us`, both stores, `SIMILAR_MAX_APPS_PER_RUN=500`, search battery limited to 5 terms, confirmation cap 100. Assert: 800+ discovered apps, 200+ with source other than chart, 150+ publishers, 80+ publishers with a non-empty email, 20+ GATC-confirmed publishers, 10+ in-band tail publishers queued or confirmed.
3. Manually sample 5 publishers: email present, website resolves, store URL opens the correct app, and for confirmed ones the GATC link (`https://adstransparency.google.com/advertiser/<id>`) shows their ads.
4. Assert no similar-crawl request was issued from a depth-2 app.
5. Run the pipeline twice; assert zero duplicate (store, app_id, country) rows, zero duplicate publishers, zero re-fetches of cached app details.
6. Typecheck gate, tests gate (`tail -20` for vitest), build. Halt on any gate failure and report.
7. Print the run summary: apps by source, publishers, emails captured, confirmations run, API calls used, estimated USD cost, top 10 publishers by score.

## CONSTRAINTS

1. Reuse the existing HTTP client, DB, job, and UI patterns. The only new dependency allowed is `google-play-scraper`.
2. Never log API keys. Never collect contact data beyond the fields the stores publish.
3. Every tunable (markets, verticals, charts, caps, throttles, install band, search terms, weights) lives in one constants file with comments.
4. If any decision has two reasonable options and the codebase does not settle it, ask one short question instead of choosing silently.
