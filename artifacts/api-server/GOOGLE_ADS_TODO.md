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

## Live smoke test — BLOCKED by environment (not by the code)
Polled this sandbox IP for a cooldown across two windows (~37 min, then a full 2 h:
12:23→14:19 UTC) — it returned HTTP 429 on **every** probe. The IP is in a persistent
Google penalty because the diagnosis phase sent many rapid requests from it. A live scrape
cannot run from this IP right now. This is separate from the production deploy IP.

**Status of the live test:** deferred to a healthy IP. The offline end-to-end proof (real
captured payload → 3 CPS rows) already exercises the exact same code path end to end, so the
fix is verified; only the network egress is unavailable here.

## To activate the fix (deploy step for the operator)
1. Redeploy on Replit (the `.replit` build runs `pnpm install:playwright && pnpm build`), OR
   locally restart the api-server so it loads the rebuilt `dist/` (current dev server still
   holds the pre-fix code in memory).
2. Run a google_ads CPS job from a healthy/less-flagged IP (production egress, not this
   poisoned sandbox). It will now yield rows.
3. If a deploy IP is *persistently* 429'd, set a residential/less-flagged egress (proxy) —
   no in-code change defeats a hard IP block from the same IP (a real browser is blocked too).

## Round 2 (post-live-run) — circuit breaker + incremental CSV
The operator's live run on the deployment PROVED the discovery fix: **623 unique advertisers
from 40 keywords** (warm-up cookie → clean 200s for 38 keywords before the IP got flagged).
But the resolve phase then ground through blocked SearchCreatives calls (~22 s of retries ×
623 advertisers ≈ hours) writing nothing. Implemented, per operator request:
1. **Circuit breaker** (`googleAdsPipeline.ts`): after 3 consecutive advertisers whose
   creative lookups were soft-blocked, stop ALL further creative lookups for the job and
   resolve the remaining advertisers from their verified domains only (instant, no network).
   `resolveAdvertiserDestination` now reports `blocked` and accepts `skipCreativeLookups`.
2. **Incremental CSV flush**: the CSV is (re)written every 25 inserted leads and at the
   circuit-breaker trip, so the file exists and grows from the first lead — a blocked or
   killed job still leaves everything found so far in "Download CSV".
3. Mobile jobs that find only web leads now log an explicit hint (store URLs need creative
   lookups; re-run as CPS to export the web leads).
Verified offline by running the real `runGoogleAdsJob` against a temp DB with a mock that
429s all creative calls: 60 advertisers → breaker tripped after 3 → job completed in 4.4 s
with a 40-row CSV (previously: hours + empty CSV).

## Round 3 — godlike audit + blast radius + smoke + auto-fix
Full self-test surface (every module's `run*Tests`): all green EXCEPT `appgoblinDecoder`
(3 pass / 2 fail) — **pre-existing and unrelated** (file untouched since 14:07, imports
nothing from the changed modules, different pipeline). Left as-is; flag to operator.

Whole api-server typecheck: clean (exit 0) → no type-level blast-radius breakage; nothing
constructs `DestinationResult` without the new `blocked` field or misuses changed signatures.

Auto-fixes applied this round:
1. **Per-job session reset** (`googleAdsPipeline.runGoogleAdsJob` → `resetGoogleAdsSession()`):
   the `warmedUp` latch previously stayed true for the life of the server, so only the FIRST
   job warmed cookies and each job inherited the prior job's ratcheted `throttleFactor`. Now
   every job starts with fresh cookies (re-warmed) and a baseline throttle.
2. **Atomic CSV write** (`csv.buildCsv`): now that the Google Ads pipeline rebuilds the CSV
   repeatedly mid-job and the download route may serve it any moment, switched to
   write-temp-then-rename so a concurrent reader never sees a truncated file. Proven with a
   race test (600 concurrent reads over 300 rewrites → 0 partial/corrupt, 0 stray temp files).
   Transparent to all other pipelines that call buildCsv.

## Blast-radius findings (Explore sweep) + dispositions
1. **[FIXED] Cross-job scraper module state** (`warmedUp`/`cookieJar`/`throttleFactor` persisted
   process-wide; only job 1 ever warmed up). → `resetGoogleAdsSession()` now called at the top
   of `runGoogleAdsJob`. Verified: warm-up GET fires for every job (2/2 in a back-to-back test).
2. **[INTENDED, safe] `job_results.country` now carries advertiser HQ region** for named
   advertisers → CSVs can contain mixed ISO2 codes. HQ bucketing uses a *separately resolved*
   HQ (hqSplit/hqSplitWeb), NOT this column, and it stays a valid ISO2, so the Email-Prospector
   ingest contract holds. No consumer assumes a uniform job country. Documented, no code change.
3. **[known, harmless] `parseCreativesResponse.nextToken` is dead output** — no creative
   pagination exists (resolver reads only the first page). Left as-is (used by self-tests);
   wiring pagination would be a feature, not a fix.
4. **[FIXED] Doc/env drift** — `.env.example` delay default corrected 600→1500 and the new
   session/retry knobs documented (WARMUP, MAX_RETRIES, BACKOFF_BASE/MAX, AUTHUSER);
   GOOGLE_ADS_INTEGRATION.md test count 37→44 and keyword figure ~2,200→~2,650; README figure
   updated. Synced `source-code/` mirror via `scripts/sync-source-code.sh`.
5. **[FIXED, defensive] Atomic CSV write** — see Round 3; closes the residual "future reader of
   a mid-job file sees a truncated CSV" risk the sweep noted (today's download route only serves
   after completion, so it was never actually exposed).
- **No hard breakages found.** Whole api-server typecheck clean; dashboard phase strings and
  vertical/language metadata shapes unchanged; no external `DestinationResult` literals.

### Out of scope (pre-existing, unrelated)
- `appgoblinDecoder` self-tests: 3 pass / 2 fail. Untouched file, no dependency on the changed
  modules, separate pipeline. NOT introduced by this work — flagged for the operator.

## Final verification (all green)
- Whole api-server build: clean (exit 0). Every module's self-tests pass except the pre-existing
  appgoblinDecoder. Google Ads: keywords 28, scraper 44, pipeline 5.
- Atomic-write race test: 600 concurrent reads / 300 rewrites → 0 partial, 0 stray temp files.
- Consolidated pipeline smoke (blocked creatives, 2 back-to-back jobs): both completed in ~4s
  with 24-row CSVs; circuit breaker + incremental flush + per-job warm-up all confirmed.

## Round 4 — proxy egress hook (the actual fix for a hard-blocked deploy IP)
The operator's deployment (`leadfinder.mobupps.net`) hit the persistently-hostile-IP case
the log predicted: two live jobs (`job_OCL7hjSZMS` mobile, `job_S810NE4qW1` cps) returned
empty CSVs because **discovery itself was 429'd** — the warm-up GET got `→ 429, 0 cookie(s)`
and every SearchSuggestions call blocked, so 0 advertisers were discovered (an earlier run on
the same IP got 623 when Google briefly allowed it). When discovery yields 0, the parser /
circuit-breaker / incremental-flush fixes never run — the CSV is empty by construction. No
in-code change defeats a hard IP block (a real browser from the same IP is blocked too — proven
in Round 1). The one remaining lever, listed but **never actually implemented** before, was the
outbound-proxy hook. Implemented now:
1. **`GOOGLE_ADS_PROXY_URL`** (scraper-scoped): routes ONLY the Transparency Center requests
   (warm-up GET + all RPCs) through an undici `ProxyAgent` dispatcher, via a `withProxy()`
   wrapper on both `fetch` call sites. The rest of the server (OAuth, googleapis, Anthropic)
   keeps direct egress — so the residential/mobile proxy is spent only where it's needed.
   Supports http(s):// proxies (CONNECT tunnel; SOCKS not supported) with `user:pass@`; credentials are redacted in logs
   (`routing via proxy http://***@host:port`). Bad URL ⇒ warn + direct egress, never crashes.
   Unset ⇒ byte-for-byte unchanged behaviour.
2. Added `undici@^6.21.0` to api-server deps (installed 6.27.0; it's the same library that
   already backs Node 20's global fetch, so fully compatible). `pnpm install` done.
3. Discovery now logs proxy status at job start (configured+redacted, or a hint to set the var).
4. **Verified**: build clean (exit 0); pointing the var at a dead proxy port makes the warm-up
   fail to reach Google at all (`fetch failed` vs an HTTP status) — proving traffic is routed
   through the dispatcher, not direct. Offline self-tests still green (scraper 44, pipeline 5,
   keywords 28). `.env.example` documents the knob; `source-code/` mirror synced.

**Operator step to get leads:** set `GOOGLE_ADS_PROXY_URL` to your residential/mobile proxy
gateway on the deployment, redeploy/restart so `dist/` reloads, then run a CPS job. For rotating
pools, point it at the provider's gateway (it rotates the exit IP per connection/session).

**Still-open secondary (NOT the cause of the empty CSVs, deferred):** in a job where discovery
succeeds but the *creative* endpoint blocks, the resolve-phase circuit breaker's
`consecutiveBlockedLookups` counter is reset by domain-resolved advertisers interleaved between
blocked ones, so on a mixed stream it can under-trip and grind longer than intended (observed in
the pre-restart `job_OWk_6De02k`: 623 advertisers, creative lookups 429'ing for ~13 min while
web-domain leads resolved fine). A healthy proxy makes creative lookups succeed, so this is now
lower-impact; worth tightening the breaker to count creative-endpoint outcomes only.

## Round 5 — real-time streaming CSV + robust pause + "found 250 → got 0" root cause
Operator ran two live jobs from the (proxy-published) deploy and BOTH emailed "0 advertisers":
- **CPS `job_1eI77Hfk5-`: Ads scraped = 0** → discovery itself found 0 (SearchSuggestions
  blocked at that moment). Nothing to resolve → empty CSV. Environmental (needs the proxy IP
  un-flagged), not a pipeline bug.
- **MOBILE `job_2vyvE-PPJu`: Ads scraped = 252, Advertisers in CSV = 0.** Root cause: the
  "insurance" advertisers resolve to WEBSITES (`cps_web`), and the mobile CSV writer
  (`csv.ts` keeps only `mobile_*` + `store_url`) discards every web lead → 0 rows. The creative
  429-storm compounded it (store URLs need SearchCreatives, which was blocked). i.e. **the 250
  leads were real; the product-type filter threw them away.** Fix = run insurance as **CPS**
  (web leads resolve from the verified domain with NO creative lookup, so they survive the
  429-storm). Reproduced in the streaming smoke, scenario C.

Operator ask: "fill the excel in real time, concurrently, so a halt loses nothing." Implemented:
1. **Streaming discover→resolve→write** (`googleAdsScraper.discoverAdvertisers` gained an awaited
   `onAdvertiser(adv)` hook + `shouldStop()`; pipeline moved its resolve/classify/insert into that
   callback). Each advertiser is resolved, inserted, and the CSV re-flushed the INSTANT it is
   discovered — discovery and writing are effectively concurrent. A block/kill mid-scrape keeps
   everything already found (smoke B: discovery aborts after keyword 1 → the 3 leads from keyword 1
   are already persisted).
2. **Real-time flush + downloadable partial**: CSV rebuilt on EVERY insert (was every 25); new
   `db.setJobCsvPath()` publishes `job.csv_path` on the first flush so "Download CSV" serves the
   growing file and a blocked/interrupted/FAILED job still exposes everything scraped
   (`markJobFailed` leaves csv_path intact; the download route already served whatever csv_path
   points at).
3. **Robust fast pause-on-block**: circuit breaker now counts CREATIVE-endpoint outcomes only
   (new `DestinationResult.attemptedCreativeLookup`) — fixes the old under-trip where a
   domain-resolved advertiser reset the counter. Trips on EITHER N-in-a-row (`GOOGLE_ADS_BREAKER_AFTER`,
   def 3) OR blocked-rate ≥ `GOOGLE_ADS_BREAKER_RATE` (def 0.6) over ≥ `GOOGLE_ADS_BREAKER_MIN_SAMPLE`
   (def 6). On trip: stop creative network calls, keep discovering + domain-resolving (instant),
   flush. Smoke A: exactly 3 SearchCreatives calls then paused; all 15 advertisers still saved.

### Godlike audit / blast radius / smoke (all green)
- Blast radius = exactly 3 source files (`db.ts` +setJobCsvPath, `googleAdsPipeline.ts` streaming
  rewrite, `googleAdsScraper.ts` hooks + attemptedCreativeLookup) + 1 new fixture. Whole api-server
  typecheck clean. `discoverAdvertisers`'s other caller (the e2e smoke) uses the OLD signature —
  the new hooks are optional, so it still passes 18/18 (backward-compatible).
- Other pipelines (affplus/appgoblin/meta) share `buildCsv` but not the streaming path and never
  call setJobCsvPath mid-job → unchanged. HQ split still runs at completion on the DB rows. Email
  attach still uses the final csv_path.
- **New behavioural smoke** `fixtures/google-ads-streaming-smoke.mjs` drives the REAL
  `runGoogleAdsJob` against a mocked network: A (block-storm CPS) 6/6, B (discovery-halt) 3/3,
  C (mobile-over-web reproduces 250→0) 4/4 → **13/13**.
- Module self-tests: csv 15, googleAdsKeywords 28, googleAdsScraper 44, googleAdsPipeline 5,
  hqResolver 27, hqSplit 7, hqSplitWeb 4 — all pass. Pre-existing `appgoblinDecoder` 3/2 still
  fails (untouched, unrelated — flagged since Round 3).
- **Auto-fix:** the mobile-vs-web zeroing is now unmissable — the completion logs a NOTE with the
  web-lead count + "re-run as CPS". (Left product semantics intact: mobile CSV = store URLs, CPS
  CSV = websites; changing that would break the Email-Prospector per-schema ingest.)

**Operator guidance to actually get leads:** for web verticals (insurance, forex, loans, etc.)
run **CPS**, not mobile — CPS leads resolve from the verified domain and survive the creative
429-storm. Keep `GOOGLE_ADS_PROXY_URL` set so discovery isn't blocked. The CSV now fills live and
a mid-scrape block keeps everything found.

## Round 6 — log-verified root cause + CPS domain-first + name-search + recovery route
Operator supplied the full deploy log for the two 0-result jobs; theory CONFIRMED line-by-line:
- Proxy WORKS for discovery: `warm-up GET → 200`, 19/19 suggest calls OK → **252 advertisers**.
- Mobile job: `inserted 138 rows (mobile 0, web 138)` → **138 real web leads saved in the DB**,
  then `CSV written … (0 mobile rows)` — the mobile filter discarded them. User's "I saw web
  leads found" is exactly right.
- CPS job started at 17:39:40 — the second the mobile job finished — and its FIRST suggest got
  429. **Causal, not random:** the mobile job's 2-minute creative-endpoint burst (SearchCreatives
  + GetCreativeById + retry ladders) through the single static proxy IP (81.181.174.82) flagged
  it; CPS inherited a poisoned IP. The mobile job took down the CPS job.

Operator directives: concurrency (lead → CSV the moment it's found — shipped in Round 5),
stop-the-scrape when 429 arrives and present what's found, and resolve advertisers like Affplus
(name → web search, or domain, whichever works). Implemented:
1. **CPS = domain-first, ZERO creative calls** (`GOOGLE_ADS_CPS_USE_CREATIVES=1` restores old
   behaviour). The lead for a web vertical is the advertiser's own site; creative lookups added
   nothing except the burst that flags the IP. A CPS job now costs ~1 request per keyword.
   Smoke D proves 0 SearchCreatives / 0 GetCreativeById for a CPS job, 15/15 leads exported.
2. **Affplus-style name→web-search fallback** (CPS, advertisers with NO verified domain — the
   `unresolved 114` in the log): new `webResolver.searchAdvertiserWebsite(name, hint)` export
   wraps the same Anthropic web_search engine Affplus uses (LLM-budget-capped, intermediary/
   tracker hosts rejected). Budget `GOOGLE_ADS_WEB_MAX_SEARCHES` (def 40)/job. A daily-cap hit
   mid-job disables further searches but lets the job COMPLETE with its saved leads (deliberate:
   deferJob would replay-from-top and re-scrape). No ANTHROPIC_API_KEY ⇒ graceful skip.
3. **Stop-on-429 defaults tightened**: breaker `GOOGLE_ADS_BREAKER_AFTER` default 3→**1** (a
   "blocked" verdict already survived the 4-attempt retry ladder — one is proof); discovery abort
   hardcoded 5→env `GOOGLE_ADS_DISCOVERY_ABORT_AFTER` default **2**. With Round-5 streaming,
   stopping early presents everything found so far — nothing is lost.
4. **Recovery route**: `GET /api/jobs/:id/csv?product=cps` rebuilds a CSV from the STORED
   job_results under the other product filter — **the mobile job's 138 web leads are downloadable
   right now, no re-scrape**. Mobile-job NOTE log now prints that exact link.

Verification: build clean; streaming smoke extended to **18/18** (A mobile breaker exactly-N-calls,
B discovery-halt no-loss, C 250→0 repro + ?product=cps rebuild, D CPS zero-creative); e2e smoke
18/18; self-tests all green incl. webResolver 45 (touched) — appgoblinDecoder 3/2 pre-existing.
`.env.example` knobs documented; mirror synced.

## Round 7 — the smoking gun: stale dev-DB smoke jobs shipped in the deploy + penalty-renewal loop
Operator's 18:30 deploy log went "straight to 429". Line-by-line analysis found TWO causes:
1. **Self-inflicted (my fixtures):** at boot the deploy's queue processor ran
   `job_smoke_ga_web_1784570586744 / …1644283 / …1736638` — pending smoke-test jobs from the
   LOCAL dev `data/ad-library.sqlite`, which ships inside the deploy image (`.replitignore`
   didn't exclude `data/`). Three stale jobs hammered the live endpoint through the operator's
   proxy for ~4 min at boot, re-flagging the IP before the operator's real jobs even started.
   Verified locally: those exact job IDs sat status=pending in the dev DB (20 total purged).
2. **Penalty-renewal loop:** the proxy IP (81.181.174.82, single static exit) has been
   continuously re-flagged since 17:38 because every job — stale or real — sends dozens of
   requests (warm-up + retry ladders ×2 keywords) into the penalty box, renewing it. The IP
   never gets a quiet window to recover.

Fixes:
1. **Ship-hygiene:** `.replitignore` now excludes `data/` and `csv-output/` (both root and
   api-server) — dev DBs/CSVs never ship again; each deploy starts with a clean DB. Purged all
   20 `job_smoke_%` rows locally; `google-ads-smoke.mjs` now `markJobCompleted`s its synthetic
   job so it can never be picked up by a queue processor (proven: 0 stale rows after a run).
2. **Penalty-box probe (scraper):** `warmUpSession` now reports `blocked`; when the homepage
   itself 429s, discovery sends ONE probe keyword with NO retry ladder — both blocked ⇒ instant
   abort ("PENALTY BOX CONFIRMED"), total 2 requests instead of ~25 + minutes of backoffs.
3. **Cooldown latch (scraper):** a proven hard block (probe-confirmed or consecutive-block
   abort) starts `GOOGLE_ADS_COOLDOWN_MS` (default 15 min): subsequent google_ads jobs abort
   INSTANTLY with zero requests and a clear "COOLDOWN ACTIVE — wait ~N min" message. This
   breaks the renewal loop (the boot sequence in the operator's log would have sent ~2 requests
   total instead of ~5 jobs × retry storms). Latch is process-local; survives
   resetGoogleAdsSession (deliberate — it models the IP, not the job).
4. rpcPost gained a per-call `maxRetries` override (used by the probe).

Verification: build clean; streaming smoke grew to **25/25** (E: cooldown ⇒ 0 network calls;
F: warm-up 429 ⇒ exactly 1 probe + abort, retry ladder proven bypassed); e2e smoke 18/18 (and
leaves 0 pending rows); self-tests all green. `.env.example` documents COOLDOWN_MS; mirror synced.

**Operator runbook after republish:** the proxy IP needs a QUIET window to shed the penalty.
(1) Republish (clean DB ships — no boot-time ghost jobs). (2) Do NOT run any google_ads job for
45–60 min (the app now enforces 15 min itself after any confirmed block; the IP has been hot for
hours, so give it longer manually). (3) Then run ONE CPS job. If it opens with "warm-up GET →
200", it will fill live. If it aborts with PENALTY BOX after one probe, the IP is still hot —
wait longer or ask the proxy provider for a rotating port / second exit IP. Long-term: a
rotating residential gateway makes this entire class of problem disappear.

## Change log
- 2026-07-20: Investigation complete; root causes A/B/C identified and reproduced. File created.
- 2026-07-20: Implemented Fix A/B/C + keyword widening. All offline tests green (77 total).
- 2026-07-20: Offline end-to-end proof (real payload → 3 CPS rows). Godlike audit clean.
- 2026-07-20: Live smoke test blocked — sandbox IP 429 for 2h straight. Deferred to healthy IP.
  Build + dist current; fix ready to deploy.
- 2026-07-20 (Round 4): Deploy IP confirmed hard-blocked at discovery (empty CSVs). Implemented
  scraper-scoped outbound-proxy hook (`GOOGLE_ADS_PROXY_URL`, undici ProxyAgent); build clean,
  routing verified, self-tests green, docs + mirror synced. Operator to set the proxy var + redeploy.
- 2026-07-20 (Round 5): Proxy published (commit d6a3bce). Two live jobs still 0 — CPS discovery=0
  (env), MOBILE 252→0 (web advertisers dropped by the mobile filter). Built streaming real-time CSV
  (write each lead the instant it's found), downloadable partial on halt (setJobCsvPath), and a
  robust creative-only circuit breaker. Build clean; streaming smoke 13/13; e2e smoke 18/18; mirror
  synced. Safe to republish. Guidance: run web verticals as CPS.
- 2026-07-20 (Round 6): Deploy log verified the theory (138 web leads WERE saved; mobile job's
  creative burst poisoned the proxy IP → CPS discovery 429). CPS now domain-first with ZERO
  creative calls; Affplus-style name→web-search for no-domain advertisers; breaker default 1 /
  discovery abort default 2; `?product=cps` recovery download for stored web leads. Streaming
  smoke 18/18, e2e 18/18, all self-tests green. Safe to republish.
