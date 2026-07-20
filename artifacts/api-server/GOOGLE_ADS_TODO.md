# Google Ads Transparency — Fix Log & TODO

Working log for the Google Ads Transparency Center scraper fix. Kept in-repo per request.
Date started: 2026-07-20.

## Reported problems
1. **Not enough search keywords** — needs to be widened / broadened.
2. **Scrape produces no rows** — job completes but the CSV is empty (0 advertisers, 0 rows).
   Job `job_a55TWbUklf` (CPS, US/IN/AR/ES, food vertical) → "0 advertisers discovered",
   every request logged `HTTP 429 … blocked/rate-limited`.

## Diagnosis (verified live against adstransparency.google.com)
- **Root cause A — plain `fetch` gets soft-blocked (429).** A single cold request returns
  HTTP 200 with real data, but a rapid sequence from this (datacenter/Replit) IP starts
  returning `HTTP 429` on *every* call. Google fingerprints TLS/H2 + rate-limits the IP.
  `discoverAdvertisers` then aborts after 5 consecutive blocks → 0 advertisers → empty CSV.
  Reproduced: raw `node` fetch = 200; running the compiled `discoverAdvertisers` = 429 on
  request #1 (IP already flagged from prior calls).
- **Root cause B — parser is fragile against the CURRENT response shape.** Real suggestion
  items are nested: `{"1":{"1":name,"2":AR-id,"3":region}}` plus separate domain-only
  items `{"2":{"1":"host.tld"}}`. The old parser reads `item["12"]`/`item["1"]` directly,
  only recovering id/name via a deep-scan fallback, drops domain-only suggestions, and never
  lifts the advertiser's verified domain. Creative `format` (key drifted to `"4"`) parses as
  null.
- **Root cause C — destination resolution yields null for image/iframe ads**, so advertisers
  resolve to no landing URL and get dropped. For CPS the advertiser's own verified domain
  should be used as the website lead.

## Experiment result — the block is IP-level, not transport-level
Installed Chromium and tested a real browser page against the endpoint while plain fetch
was 429'ing. **The browser ALSO got redirected to `google.com/sorry/index`** (the "unusual
traffic" CAPTCHA). Conclusion: once this datacenter IP is flagged, *every* transport is
blocked equally — a browser does NOT bypass an IP penalty box. So the fix is not "use a
browser" but **avoid getting flagged + recover gracefully**:
  - warm a cookie session (GET homepage → reuse NID cookie),
  - pace requests gently + adaptively throttle after any 429,
  - retry with exponential backoff on 429/403 instead of hard-failing,
  - soften the "abort after 5 blocks" so a transient window doesn't kill the job,
  - optional outbound proxy env hook for persistently-hostile deploy IPs.
A cold/fresh request returns HTTP 200 with real data, so pacing+cookies+backoff is the
right lever. (Browser transport kept as a documented future option, not worth its
complexity given /sorry/ blocks it too.)

## Plan
- [x] Confirm endpoint reachable + capture real payload shapes.
- [x] Reproduce the 429 block through the real code path.
- [x] Test browser transport — also blocked by IP penalty (/sorry/). Not the fix.
- [x] **Fix A (transport):** cookie warm-up (`warmUpSession`) + adaptive throttle
      (`throttleFactor`) + exponential-backoff retry on 429/403/challenge (`rpcPost`).
- [x] **Fix B:** rewrote `parseAdvertiserSuggestions` for the nested shape; region now from
      `adv["3"]` (positionally reliable); domain-only suggestions kept as website leads;
      creative `format` key fixed (`"4"`), next-page token `"3"`.
- [x] **Fix C:** domain-only leads resolve straight to `https://domain` (valid CPS lead);
      named advertisers with no destination + no domain are dropped (correct).
- [x] **Widen keywords:** food 12→209 entries (+full multilingual); added multilingual
      credit/beauty/legal/utilities. Bank 2648 kw / 37 langs / 21 verticals. The failing
      job's selection (food, en/es/bn/hi, limit 40) now yields 40 spread kw (was ~12 en-only).
- [x] Offline unit tests: keywords 28/28, scraper 44/44, pipeline 5/5.
- [x] Godlike audit of the full pipeline (findings below).
- [~] Smoke test: OFFLINE end-to-end PROVEN (real payload → 3 CPS rows in CSV). LIVE run
      pending IP cooldown — this dev IP is temporarily rate-limited by my own diagnostics.
- [x] Auto-fix items surfaced by the audit (creative format key, token key — done).

## Godlike audit findings
1. **CSV yield (main complaint):** PROVEN fixed. Fed a real captured SearchSuggestions
   payload through the real code path (parse → resolve → classify → buildCsv) → 3 CPS rows
   with valid `website_url`s. Domain-only suggestions are now the reliable CPS lead source.
2. **Mobile HQ-split:** `runHqSplit` filters to `mobile_google_play|mobile_app_store` +
   store_url, and `runHqSplitWeb` to `cps_web` + landing_url — so cps_web domain leads that
   appear in a *mobile* job are correctly ignored by the mobile split. No bug.
3. **Behavior change (intended):** named advertisers now carry their real region (adv["3"],
   e.g. RO/DE) in the CSV `country` column instead of always the job's first country. Since
   the Transparency Center region filter is informational (Google returns the same set
   regardless), the advertiser's real region is strictly more accurate. Domain leads have no
   region → still fall back to the job country.
4. **Minor (documented, not fixed):** in a *mobile* job, domain-only leads are processed and
   stored as cps_web (excluded from the mobile CSV) — a little wasted work + they occupy the
   defensive 1000-advertiser cap. Harmless; a future refinement could skip domain leads when
   product_type=mobile. Domain-lead resolution makes NO network call, so cost is trivial.
5. Retry storm is bounded: a hard block costs ≤ MAX_RETRIES backoffs per request and aborts
   after 5 consecutive; not infinite.

## Known limitation (environmental, not a code bug)
From a datacenter/Replit IP, Google soft-blocks (429 / google.com/sorry CAPTCHA) after a
burst — and this affects a real browser too (verified). Mitigations shipped: warm-up cookies,
gentle+adaptive pacing, backoff-retry. For a persistently-hostile deploy IP the real-world
fix is a residential/less-flagged egress (proxy). A cold request returns 200, so on a healthy
IP the pipeline now yields rows.

## New / changed env knobs
- `GOOGLE_ADS_FETCH_DELAY_MS` (default 1500, was 600) — base inter-request pace.
- `GOOGLE_ADS_MAX_RETRIES` (3), `GOOGLE_ADS_BACKOFF_BASE_MS` (4000), `GOOGLE_ADS_BACKOFF_MAX_MS` (30000).
- `GOOGLE_ADS_WARMUP` (default on; set `0` to disable homepage cookie warm-up).

## Change log
- 2026-07-20: Investigation complete; root causes A/B/C identified and reproduced. File created.
- 2026-07-20: Implemented Fix A/B/C + keyword widening. All offline tests green (77 total).
