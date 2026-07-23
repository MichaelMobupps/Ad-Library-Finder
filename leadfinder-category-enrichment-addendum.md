# CLAUDE CODE PROMPT — Leadfinder Addendum: App Category Enrichment (Game vs Non-Game)

Run from the Leadfinder repo root. This is a delta on the existing "App Advertisers" GATC module. Make surgical edits only. Do not restructure the module.

---

## GOAL

Every stored app advertiser gets an authoritative store category and an `is_game` flag, so Leadfinder can filter and score non-game app advertisers precisely. Do not attempt game filtering at GATC query time. Category comes from the app stores themselves, keyed on the `app_id` values the module already extracts.

**Category truth comes from the store listing, never from advertiser names or ad text.**

## IMPLEMENTATION STEPS

1. Create table `gatc_apps`: `app_id (PK), store (google_play|app_store), title, category_raw, is_game (bool), enrichment_source, enriched_at, enrichment_failed (bool)`. One row per unique app_id across all advertisers.
2. Add columns to the lead mapping: `app_category`, `is_game`. Populate from `gatc_apps` on lead upsert.
3. Write the enrichment worker as a queue over unenriched `app_id` values, wired into the existing job pattern. Cache is permanent: never re-enrich a row that succeeded.
4. Apple enrichment (store = app_store): call `https://itunes.apple.com/lookup?id=<ID1>,<ID2>,...&country=us` in batches of up to 100 IDs. Read `primaryGenreId`, `genreIds`, `primaryGenreName` per result. Rule: `is_game = true` when `primaryGenreId` is `6014` or `genreIds` contains `6014`. Store `primaryGenreName` as `category_raw`. Throttle to 10 requests per minute. `enrichment_source = itunes_lookup`.
5. Google Play enrichment (store = google_play), primary path: fetch `https://play.google.com/store/apps/details?id=<PACKAGE>&hl=en&gl=us`, parse the JSON-LD block (`application/ld+json`), read `applicationCategory`. Rule: `is_game = true` when the value starts with `GAME`. Store the value as `category_raw`. Throttle to 1 request per second. `enrichment_source = play_listing`.
6. Google Play enrichment, fallback path: when the fetch fails or `applicationCategory` is absent, call the SearchAPI Google Play Product endpoint with the existing `SEARCHAPI_KEY` (`engine=google_play_product`, `product_id=<PACKAGE>`), read the category from the response, same `is_game` rule. `enrichment_source = searchapi_play_product`. Count these calls against `GATC_MAX_API_CALLS_PER_RUN`.
7. A lookup that fails on both paths sets `enrichment_failed = true` and retries on the next run, maximum 3 attempts, then stays `category_raw = NULL`, `is_game = NULL` (unknown, shown as "Unclassified" in the UI).
8. Add a non-game Class C token battery to `gatc_queries` as active rows: `fintech, wallet, loan, bank, pay, payments, trading, crypto, exchange, insurance, health, fitness, telehealth, delivery, taxi, ride, travel, booking, shopping, commerce, marketplace, education, learning, streaming, news, productivity`.
9. Change the creative fetch order in the runner: for each new advertiser fetch `platform=google_search` first, then `platform=youtube`, then `platform=google_play`. The Play surface skews toward games; Search and YouTube surface more non-game app campaigns. Keep the classifier unchanged.
10. UI changes in the App Advertisers section: add a Category column, an `is_game` filter (All / Games / Non-Games / Unclassified), and a category facet filter. Include both fields in the CSV export.
11. Scoring change: add a configurable weight `NON_GAME_BONUS` (default 0) in the constants file, applied when `is_game = false`. Leave the default at 0 so scoring behavior is unchanged until Michael sets it.

## VERIFICATION

1. Unit tests for both `is_game` rules: Apple genre 6014 positive and negative cases, Play `GAME_CASUAL` positive, Play `FINANCE` negative.
2. Smoke run: enrich 10 known app IDs (5 Play packages, 5 Apple IDs, mixed games and non-games) and print a table of app_id, category_raw, is_game, enrichment_source. Manually confirm all 10.
3. Confirm the permanent cache: run the enrichment worker twice and assert zero store requests on the second pass.
4. Typecheck gate, tests gate (`tail -20` for vitest), build. Halt on any gate failure and report.

## CONSTRAINTS

1. Reuse the existing HTTP client, throttling, DB, and job patterns.
2. Never log API keys.
3. All tunables (batch sizes, throttles, retry cap, NON_GAME_BONUS, the new token battery) live in the existing constants file.
4. If any decision has two reasonable options and the codebase does not settle it, ask one short question instead of choosing silently.
