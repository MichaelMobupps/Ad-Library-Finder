# TODO — Leadfinder

> **Purpose of this file:** durable task record so work can resume if SSH disconnects.
> **If you are picking this up fresh:** read this whole file, check the ☐/☑ status marks,
> read the "Repo map" section (filled in during Phase 0), and continue from the first
> unfinished item. Update status marks as you go.
>
> **Two efforts live in this file.** The migration sections below (Open items / External
> registrations / Ledger) belong to the unified-domain migration defined in `ROADMAP.md`.
> Everything from "Standing protocol" down is the earlier UI + background-jobs + scraper
> effort, kept append-only as history. Do not delete it.

---

## Open items

*Live section. Migration work only. Items are removed when closed, not struck through.*

| # | Item | Origin | Status |
|---|---|---|---|
| — | *(none yet — Bundle 1 in progress)* | | |

---

## External registrations discovered

*Every place this app's URL is registered with an external service. File and line.
Bundle 1 records these; it does not change them. Each becomes a cutover item.*

| Service | What is registered | File | Line | Cutover action |
|---|---|---|---|---|
| — | *(discovery pending)* | | | |

---

## Ledger

*Append-only. One entry per bundle, with full Standing Bundle Ritual results.*

<!-- ledger entries appended below this line -->

---

## Standing protocol — REQUIRED AFTER EVERY PHASE

After each phase completes, before moving on:

1. **Godlike audit** — deep review of everything changed in the phase (correctness, security, regressions, edge cases).
2. **Blast radius** — enumerate every file/feature/route the change touches; verify untouched features still work.
3. **Smoke test** — ESSENTIAL flows only (not exhaustive): build passes, server boots, key endpoints respond, UI renders, one scrape job can start/stop. Use the **existing secrets already recorded in the repo** (locate in Phase 0).
4. **Auto-fix** — fix everything found in 1–3 immediately, re-verify, then mark the phase done here.

---

## Phase 0 — Recon & grounding  ☑ DONE (2026-07-26)

- ☑ Repo mapped (see "Repo map" below).
- ☑ UI sections found: nav in `artifacts/dashboard/src/App.tsx` — Publishers / Jobs / Settings / +New Job.
  "Mobile" = source `store_first`, "CPS" = source `google_ads`, "Publishers" = Publishers.tsx tab.
- ☑ Auth: Google OAuth, domain-locked to @mobupps.com (`api-server/src/auth.ts`). NO role system yet —
  admin (michael@mobupps.com) must be added.
- ☑ Job infra: sqlite-backed queue (`queue.ts`), serial worker, jobs ALREADY run server-side in background.
  Missing: stop/cancel, live lead count (only set at completion), admin activity view (`listAllJobs()` exists in db.ts but is unused).
- ☑ Secrets: in the Replit environment (not a file): GOOGLE_CLIENT_ID/SECRET, GOOGLE_ADS_PROXY_URL,
  PROXY_SELLER_API_KEY, ANTHROPIC_API_KEY. `.env.example` documents them.
- ☑ Country list: `storeDiscoveryConfig.ts` `ALL_MARKETS` = only 12 markets (us,gb,de,fr,in,br,mx,id,jp,kr,tr,il).
- ☑ Pipelines: mobile = `storeDiscoveryPipeline.ts` (store-first→GATC confirm), CPS = `googleAdsPipeline.ts` (keyword scrape).
- ☑ Baseline verified BEFORE edits: `pnpm --filter dashboard build` ✓, `pnpm --filter api-server build` ✓,
  server boots, `/api/health` ok, SPA serves (tested on PORT=3901; prod runs `pnpm start` on 3001).

## Phase 1 — Background jobs, progress, stop button (MOST IMPORTANT)  ☑ DONE (2026-07-26)

- ☑ Jobs already ran server-side (background by design — confirmed in recon); UI is fire-and-check-back.
- ☑ **Stop button** everywhere (Jobs list, Job detail, Activity): new `jobControl.ts` + `cancel_requested`
  flag + status/phase `cancelled`; ALL 5 pipelines poll it and keep partial leads (google_ads reflushes
  capped CSV; store_first does a quick rollup→score→CSV finalize; meta/affplus/appgoblin export partial CSV).
- ☑ **Mid-run lead count**: new `leads_found` column updated live by every pipeline; `LeadsCell` pulses in UI.
- ☑ **Progress bar**: leads_found vs chosen maxLeads in job detail (`PhaseProgress` leads row + leadbar).
- ☑ **Admin Activity**: `isAdmin` on /api/me (michael@mobupps.com, extendable via ADMIN_EMAILS env),
  GET /api/jobs/activity (admin-only, all users' jobs + creator email), Activity nav tab with
  Running now / History tables and admin stop-any-job.
- ☑ Standing protocol run: builds ✓, 634 offline assertions ✓, live smoke on :3902 ✓
  (isAdmin flag, activity 200/403, stop→cancelled, double-stop→409, leads_found in payload). Fixes applied
  during audit: lead cap respected in cancel export; stop checks before HQ-split phases; route typing.

## Phase 2 — Unified & simplified UI  ☑ DONE (2026-07-26)

- ☑ ONE **"Google Ads"** menu (new `GoogleAdsForm.tsx`, the landing view): big Mobile/CPS mode cards.
  Under the hood unchanged: Mobile → `store_first` (store-first ONLY, GATC confirms), CPS → `google_ads` keyword scrape.
- ☑ **Publishers admin-only**: hidden in nav for non-admins AND locked server-side
  (requireAdmin on /api/jobs/publishers + /publishers.csv).
- ☑ Simple flow = Mobile/CPS + Countries + how-many-leads (+ optional email). Default lead cap 100.
- ☑ **Advanced settings** (collapsed `<details>`, defaults preselected) with plain-English explainers:
  similar-apps cap ("extra apps via Similar-apps recommendations…"), search phrases per category,
  ad-verification checks ("only VERIFIED advertisers become leads; costs a fraction of a cent each"),
  CPS keyword-bank controls, and legacy data sources (Meta/Affplus/AppGoblin) moved in here too.
- ☑ **Global country list**: ALL_MARKETS 12 → 137 geos (kp/ir/sy/cu/aq + micro territories excluded),
  region-grouped searchable picker (`countries.ts`, verified 1:1 with server universe).
  DEFAULT stays the curated 12-market core (chart harvest is uncapped per market — full universe by
  default would be hours; users can select any subset per job).
- ☑ Lead count is the headline number (Phase 1 counter + bar; form copy centers "how many leads").
- ☑ Standing protocol run: builds ✓, 642 offline assertions ✓, smoke on :3903 ✓ (publishers 403/200,
  config serves 137 markets/12 defaults, bad-market + bad-country rejected with no stray jobs,
  server↔UI country lists diff = ∅). Old NewJob (580 lines) deleted; unused imports pruned.

## Phase 3 — Speed up Google mobile ads scraper  ☑ DONE (2026-07-26)

- ☑ Profiled: the killer was SERIAL phases over two INDEPENDENT rate limiters (Play 1 req/s, iTunes
  1 req/6s) — every phase paid Play-time + Apple-time instead of max(). At default scope: charts
  ~10min Play + ~11min Apple serially; search battery 300 cells × 6s iTunes waits; enrichment all-Play
  then all-Apple; same for catalogs/liveness.
- ☑ Restructured `storeDiscoveryPipeline.ts` + `storeEnrich.ts` to run per-store streams CONCURRENTLY
  inside every phase (identical requests, identical politeness throttles, wall-clock = max not sum):
  charts (Play‖Apple), similar-crawl(Play)‖Apple-search-half then Play-search-half, enrichment
  (Play‖Apple), dev catalogs (halved budgets ‖ + guarded leftover pass), liveness (Play‖Apple).
  Search-battery rotation stamps moved to per-(store,cell) (`search_battery_cell_store`, seeded from
  the legacy table so history carries over). Est. ~35–45% faster per run; store-first ordering semantics
  and all anti-starvation rotations preserved (tests unchanged & passing).
- ☑ Quality unchanged: same request budgets, same LRU rotations, same upserts — only scheduling changed.
- ☑ Standing protocol: build ✓, 642 assertions ✓, live probe of concurrent Play/Apple fetches against
  real store endpoints ✓, server boots clean ✓. (Stop-button checks preserved through the restructure:
  streams break on cancel, barrier rethrows.)

## Phase 4 — Final full pass  ☑ DONE (2026-07-26)

- ☑ Full audit across all phases; dead-reference sweep clean (old NewJob + single-table search stamps fully gone).
- ☑ Blast radius: all changed files listed below; untouched surfaces (settings, auth flow, meta/affplus/appgoblin
  pipelines' happy paths, publishers view logic, HQ split, notifier) confirmed via test suite + boots.
- ☑ END-TO-END smoke on :3905 with real repo secrets (env: GOOGLE_CLIENT_ID/SECRET, GOOGLE_ADS_PROXY_URL…):
  • REAL mobile (store_first) job: ran with concurrent chart streams, STOPPED mid-enrichment →
    status `cancelled`, partial CSV written, "stopping — finishing current step…" UX confirmed.
  • REAL CPS (google_ads) job, 1 keyword through the residential proxy: **11 leads, live counter
    updated mid-run**, completed in ~56s, capped exports fine.
  • Activity (admin) listed both with creator email; publishers/activity 403 for non-admins (P2 smoke).
- ☑ Final builds ✓ + 642 offline assertions ✓. Nothing left to fix.

## Changed files (whole effort)

- api-server/src: `jobControl.ts` (NEW), `db.ts`, `auth.ts`, `index.ts`, `routes-jobs.ts`, `queue.ts`,
  `googleAdsPipeline.ts`, `storeDiscoveryPipeline.ts`, `storeDiscoveryConfig.ts`, `storeEnrich.ts`,
  `storeConfirm.ts`, `affplusPipeline.ts`, `appgoblinPipeline.ts`
- dashboard/src: `GoogleAdsForm.tsx` (NEW), `countries.ts` (NEW), `App.tsx` (nav rework + Activity view +
  stop/live-leads, old NewJob removed), `api/client.ts`, `styles.css`

---

## Repo map (filled during Phase 0)

- pnpm workspace, packages under `artifacts/*`:
  - **artifacts/api-server** — Express + better-sqlite3 + Playwright. `src/index.ts` boots, `startQueue()` polls
    jobs table every 2s, ONE job at a time. DB at `artifacts/api-server/data/ad-library.sqlite`.
  - **artifacts/dashboard** — React/Vite SPA. Only 3 source files: `App.tsx` (~1150 lines, all views),
    `Publishers.tsx`, `api/client.ts`. Server serves `dashboard/dist` statically.
- Job sources: `meta` | `affplus` | `appgoblin` | `google_ads` (CPS keyword scrape) | `store_first` (mobile, store-first→GATC confirm).
- Job row: `jobs` table; phases via `phase`/`phase_detail`; logs in `job_logs`; leads in `job_results`.
  `total_advertisers` only set at completion — hence "no mid-run lead count".
- `google_ads` pipeline already flushes CSV incrementally + has circuit breaker; `store_first` writes CSV at the end only.
- Mobile ("store first") phase order: charts → similar crawl → search battery → enrichment → dev catalogs →
  liveness → rollup → confirmation (GATC, paid, budgeted) → scoring → CSV → HQ split (only LLM spend).
- Throttles (speed levers, Phase 3): Play 1 req/s, iTunes 6 s/req (`storeThrottle.ts` RateLimiter, per-store serial);
  phases run sequentially; Play+Apple could overlap. All tunables in `storeDiscoveryConfig.ts` (env-overridable).
- Auth: sessions in sqlite, cookie `als_session`; `requireAuth` on /api/jobs + /api/settings. No admin concept yet.
- Job list/detail endpoints are scoped to `created_by_user_id`; `/api/jobs/publishers` is global (shared corpus).
- Run: `pnpm start` (root) → api-server on :3001; deploy runs `pnpm install && pnpm install:playwright && pnpm build`.

## Phase-1 design decisions

- Cancel: new `cancel_requested` flag + status `cancelled`. Pipelines poll a cheap `shouldCancel(jobId)` between
  work items; throw `JobCancelledError`; each pipeline's catch marks cancelled and KEEPS partial results/CSV
  (store_first attempts a quick rollup→score→CSV finalize so partial leads are exported).
- Live leads: new `leads_found` column, updated by pipelines as leads land; UI shows counter + progress bar
  (leads_found / maxLeads when a cap is chosen, else phase-stepper).
- Admin: `ADMIN_EMAILS=['michael@mobupps.com']` in auth.ts, `isAdmin` on /api/me; GET /api/jobs/activity
  (admin-only) = all jobs + creator email; Activity tab in UI (admin only).

## Post-delivery godlike audit #2 (2026-07-26, user-requested)  ☑

- Re-read the full restructured pipeline + all status-transition sites. Findings → all auto-fixed:
  1. **Startup recovery**: a running job with `cancel_requested=1` was marked `failed`
     ("process restarted mid-job") if the server died before the pipeline polled the flag.
     Now settles to `cancelled` first (db.ts initDb, ordered before the failed sweep).
  2. **Form race**: Start button in Mobile mode now disabled ("Loading…") until the server
     country config arrives — no more confusing "pick at least one country" error.
  3. **Disabled CPS card** (AppGoblin selected) now explains itself via tooltip.
  4. **Blast-radius surprise**: Replit auto-added `[[ports]]` mappings to `.replit` for every
     smoke-test port (3901-3906) — reverted; deployed app exposes only 3001→80.
- Change footprint confirmed via git status = exactly the intended 17 files + 4 new (TODO.md,
  jobControl.ts, GoogleAdsForm.tsx, countries.ts). No accidental edits.
- Rebuilt both packages ✓, 642 offline assertions ✓.
- Fresh smoke on :3906: anonymous 401s (me/jobs/activity), cross-user job + CSV isolation 404s,
  owner CSV download 200 with the real 11 leads from the earlier live CPS run, instant-stop race
  → `cancelled: stopped by user before start` (queue never picked it up), SPA serves the new bundle.

## Follow-up: sources are first-class again (2026-07-26, user feedback)  ☑

- User: legacy scrapers were hidden under the Google Ads menu's Advanced — "totally different lead
  sources". Restructured: nav menu is **"+ New Job"** again; inside, **Lead source** is the FIRST
  visible choice — 🎯 Google Ads (default) beside 📘 Meta Ad Library, 🔗 Affplus, 👾 AppGoblin.
- Google Ads choice → the simplified flow (Mobile/CPS cards, countries, lead cap, Advanced knobs).
  Meta/Affplus → Mobile-vs-CPS cards + countries + email (their full old capability; one job per run).
  AppGoblin → its category / ad-network fields inline, Mobile-only.
- `GoogleAdsForm.tsx` renamed → `NewJobForm.tsx`. No backend changes. Build ✓, no stale refs,
  boot smoke ✓ serving the new bundle. NOTE: leadfinder.mobupps.net shows this after the next deploy.

## Godlike audit #3 (2026-07-26, after the source-picker restructure)  ☑

- Audit finding → fixed: **AppGoblin's first stop-check ran only AFTER the full scrape** — a Stop
  pressed mid-scrape waited it out. Added a pre-scrape `throwIfCancelled`.
- Startup-recovery sweep order re-verified in db.ts (cancelled before failed) ✓.
- Blast radius: user PUBLISHED between rounds (commit 84fed16 absorbed the earlier work), so this
  round's delta is exactly: NewJobForm.tsx (renamed from GoogleAdsForm), App.tsx, styles.css,
  appgoblinPipeline.ts, TODO.md. Replit auto-added smoke ports to `.replit` again (3907, 3908) —
  reverted both times; only 3001→80 ships.
- Smoke on :3908 — created + instantly stopped a job for EVERY source using the exact payload
  shapes the new form sends: store_first ✓, google_ads ✓, meta mobile ✓, meta cps ✓, affplus cps ✓,
  appgoblin ✓ — all `cancelled: stopped by user before start`. Validation guards fire (appgoblin
  no-axis 400, appgoblin CPS 400). SPA serves the current bundle. Builds ✓, 642 assertions ✓.
- Cleaned 8 cancelled smoke jobs out of the dev DB (kept the completed 11-lead CPS run).
- REMINDER: leadfinder.mobupps.net still runs the previous deploy — republish to get the
  source-picker New Job menu + AppGoblin stop fix live.

## Follow-up: Activity progress bars + click-through live logs (2026-07-26)  ☑

- **Progress bar** on every active Activity row: `jobProgressPct` = max(pipeline-phase %, leads/cap %),
  rendered as a mini bar + % (styles `.leadbar.mini` / `.activity-progress`).
- **Click a job in Activity → full live view**: rows open the existing JobDetail (phase stepper, live
  lead counter, and the complete step-by-step log, auto-refreshing every 3s). Back returns to Activity.
- Backend: job detail/logs + CSV + HQ-zip reads are now **owner OR admin** (`canReadJob`) so the admin
  click-through works; regular non-owners still get an indistinguishable 404 (smoke-verified 200/200 for
  admin, 404/404 for another user). Builds ✓, 642 assertions ✓. Deploy to take live.

## Follow-up: all-task progress + Resume (2026-07-26)  ☑

- **Progress = every task, not just leads**: new `jobs.progress_pct` (0..100, monotonic via SQL MAX,
  reset on run start, pinned 100 on completion). Every pipeline reports weighted phase spans:
  store_first charts 0-15 / crawl+search 15-40 / enrichment 40-65 (per-fetch ticks via new
  enrichApps onProgress) / catalogs 65-75 / liveness→79 / rollup 80 / confirmation 80-92 (per-publisher) /
  scoring→93 / CSV→95 / HQ→100; google_ads keyword sweep 3-70 + phase marks; meta 0-50 scrape /
  50-90 classify; affplus 0-30 list / 30-88 resolve; appgoblin 5-55 scrape / 55-85 classify.
  UI: detail view bar + Activity bar now use server pct (lead-cap and phase-index as fallbacks for old rows).
- **Resume stopped/failed jobs**: `resumeJob()` re-queues under the SAME id (pending, cancel flag
  cleared, run_after/error cleared); POST /api/jobs/:id/resume (owner or admin); ▶ Resume / ↻ Retry
  buttons in My Jobs, job detail, and Activity. Resume semantics per source: store_first continues via
  its durable stamps/caches; meta skips already-classified rows; google_ads/affplus/appgoblin replay
  with deduped results.
- **Audit finding auto-fixed BEFORE smoke**: a stopped store_first job persisted its partial export into
  lead history, so a resume would have deduped its OWN leads out of the final CSV — fixed by clearing
  the job's own job_results at run start (no-op on fresh jobs; same pattern as the other pipelines).
- Smoke on :3910 — full cycle live: progress climbed granularly (7.5% mid-charts → 40.4% during
  enrichment ticks), resume-while-running 409, stop → cancelled at 40.5% (bar preserved), non-owner
  resume 404, resume → "resumed — waiting for worker" → running again with progress reset+climbing,
  final stop clean. Builds ✓, 642 assertions ✓. `.replit` smoke-port auto-adds reverted (x2).
  Deploy to take live.

## Follow-up: per-user parallel queue (2026-07-26)  ☑

- Problem (user-reported from live Activity): the queue was GLOBAL-SERIAL — Alberto's first job sat
  behind Michael's running job for 45+ minutes.
- New concurrent dispatcher in queue.ts: **parallel across users, serial within a user** — a user's
  first pending job starts immediately; their second waits for their own first. Global in-flight cap
  `QUEUE_MAX_CONCURRENT_JOBS` (default 3, max 8) bounds browsers/proxy/LLM bursts. LLM-cap parking
  preserved per candidate (non-exempt jobs skipped when the daily cap is hit; store_first exempt).
- Concurrency-safety audit of shared module state: store rate limiters are global → politeness holds
  across any number of jobs; meta uses an isolated browser context per query (safe); the GATC cookie
  jar + adaptive throttle are module-global → `resetGoogleAdsSession()` is now guarded by a new
  active-run registry (jobControl beginJobRun/endJobRun/activeRunCount) so it never wipes a session
  another in-flight GATC job is using. Dead queue helpers (getNextPendingJob/CapExempt) removed.
- Smoke on :3911 with two users: A running + B1 running IN PARALLEL, B2 pending behind B1 (own queue);
  stop B1 → B2 started while A kept running; all stops clean. Builds ✓, 642 assertions ✓,
  `.replit` smoke-port reverted. Deploy to take live.

## Follow-up: email fact-check → lead cap for ALL sources (2026-07-26)  ☑

- Fact-checked the team-announcement email against the build. Two corrections:
  1. Keyword bank is **37 languages** (2,808 keywords, 23 verticals) — not "100+".
  2. "How many leads?" only existed for the Google Ads engines → **built it for Meta/Affplus/AppGoblin
     too**: route stores maxLeads for every source; meta/affplus(mobile+web)/appgoblin pipelines cap
     their CSV + HQ-split rows (selectExportRows) incl. the stopped-job partial CSVs; the New Job form
     now always shows the lead question. Smoke: maxLeads persisted in source_params for all three ✓.
- Also flagged for the email: "resumes exactly" is precise for Google Ads Mobile (durable stamps);
  other sources re-run safely and de-dupe. And the per-user parallel queue was missing from the draft.
- Builds ✓, 642 assertions ✓, `.replit` reverted.

## Follow-up: "0 leads after 2h34m" — lead-first pipeline + Play concurrency (2026-07-26)  ☑

Trigger: user's live job `job_DU5w6R_kRw` ran **2h34m, reached 73%, and exported 0 leads of 20
requested**. Logs pasted by the user were profiled line-by-line.

### Diagnosis (all measured from that job's own logs, not estimated)

| Segment | Window | Duration | % of job |
|---|---|---|---|
| Charts | 13:47:06–13:47:54 | 48s | 0.5% |
| Similar crawl ‖ Apple search | 13:47:54–13:59:06 | 11m12s | 7.2% |
| Play search half | 13:59:06–14:05:22 | 6m16s | 4.1% |
| **Enrichment pass 1** | 14:05:25–15:07:26 | **1h02m01s** | **40.1%** |
| Dev catalogs | 15:07:26–15:33:30 | 26m04s | 16.8% |
| **Re-enrichment (pass 2)** | 15:33:34–16:21:42 | **48m08s** | **31.1%** |
| Rollup + scoring | 16:21:47–16:21:48 | 1s | ~0% |
| **Confirmation** | **never ran** | — | — |

1. **Enrichment was 71% of the run**, and it is ONE serial Play stream. Reconstructed exactly from
   `requests=` vs `fetched=` (requests counts 1/Play app but 1/100-app Apple batch): pass 1 =
   ~3,202 Play + ~8 Apple batches → 3,202 × 1.16s = 61.9 min vs 62m01s measured; pass 2 = 2,480
   Play, all of it → 47.9 min vs 48m08s measured. **5,682 serialized Play fetches = 1h50m.**
   Apple finished its 8 batches in 48s and idled for the next hour.
2. **`maxLeads` did nothing.** It was referenced in exactly ONE place — the final `buildPublisherCsv`.
   A 20-lead job and a 10,000-lead job did identical work.
3. **Leads were structurally impossible before 80% progress.** `confirmed_advertiser` is set only by
   the confirmation phase (phase 7 of 10). The job was stopped at 73%, so `EXPORT_CONFIRMED_ONLY`
   filtered all 4,117 rolled-up publishers to zero. The corpus was export-ready 48s in; confirmation
   at `confirmBudget=200` is ~5 min. **That job could have delivered 20 leads in ~6 minutes.**
4. **The enrichment budget was silently doubled.** `fetchBudget = ENRICH_MAX_APPS_PER_RUN` was a
   LOCAL in `enrichApps`, called twice per run ⇒ 8,000 fetches against a stated cap of 4,000.
5. **Progress span was mis-weighted**: re-enrichment got 5 points (70→75) but costs as much as pass 1
   (25 points), and the phase label never left "developer catalogs" — hence 73% for an hour.
6. Scope was NOT the problem: the run was already 1 market / 8 verticals and charts took 48 seconds.

### Fixes shipped

- **Lead-first pipeline** (`storeDiscoveryPipeline.ts`): confirmation is no longer terminal. Four
  CHECKPOINTS — after charts, after long-tail discovery, after enrichment, and a final one — each
  doing rollup → confirm a slice of the ONE per-run budget → score → write CSV. Leads accumulate from
  the opening seconds; **any** stop exports what is on the table. Verified live: checkpoint 1 fired
  at **+4 seconds**.
- **Lead-target early exit**: new `enough?: () => boolean` on `confirmPublishers` (+ `reachedTarget`
  on ConfirmSummary), evaluated against the DEDUPED exportable count. A checkpoint that fills the
  order jumps straight to `finishRun()` and skips every remaining phase.
- **Honest live counter**: was `countConfirmedPublishers()` (corpus-wide, incl. leads other jobs
  already delivered) — could read "20 leads" while the CSV held 3. Now the deduped exportable count,
  computed once per publisher and reused by `enough` (was two full table scans per confirmation).
- **Play concurrency** (`storeThrottle.ts` rewritten): `RateLimiter(minIntervalMs, maxConcurrent)`.
  Gap is now **start-to-start**, not settle-to-start — the old chain stacked fetch latency on top of
  the interval (1.16s/req for a "1 req/s" limiter, a silent 14% tax). `PLAY_CONCURRENCY=5` (env
  `STORE_PLAY_CONCURRENCY`, max 16); the interval is divided by N so the aggregate target rate is
  N req/s. `maxConcurrent=1` reproduces the old behaviour exactly.
  **Measured live against real Play: 965ms/req → 205ms/req (4.7x), 19/20 ok at both 1 and 5, and 8
  concurrent also clean at 142ms/req.** Extrapolated: 5,682 fetches 110min → ~19min.
- **Adaptive backoff**: new `playRequestBlocked()` classifier (429/403/captcha/unusual-traffic, and
  deliberately NOT 404) trips `limiter.penalize(PLAY_BLOCK_BACKOFF_MS=30s)` across every Play stream,
  wired into all 6 Play call sites.
- **Single enrich budget**: `enrichApps` takes `opts.fetchBudget` and returns `budgetLeft`; the
  pipeline threads pass 1's remainder into pass 2. The config value now means what it says.
- **iTunes 6s → 3s** (`ITUNES_REQUEST_INTERVAL_MS`, 10 → 20 req/min) + `ITUNES_CONCURRENCY` (default
  1). Dev catalogs is Apple-bound (250 catalogs × 6s = 25min while Play's 250 took ~8min and idled).
- **Progress re-weighted** for the interleaved order: charts 0-6 · CP 6-18 · discovery 18-32 ·
  CP 32-40 · enrich 40-58 · CP 58-66 · catalogs 66-74 · liveness 74-78 · final CP 78-95 · HQ 95-100.

### Bugs found BY the audit and fixed before shipping

1. **TDZ crash on every early-exit path** — `finishRun()` (hoisted) read `newSimilar`/`searchRows`/
   `catalogApps`/`enrichSummary`, all `const`s declared AFTER checkpoint 1. Any early exit would have
   thrown `ReferenceError`. All run counters hoisted to the top of the try block. Caught by a
   purpose-built probe, not by tsc.
2. **The user's exact bug, still live after the checkpoint work** — a stop after checkpoint 1 reported
   `0 partial lead(s) exported` even though `job_results` held 5. Cause: `finalizeCancelledStoreJob`
   rebuilt the CSV with `leadHistorySeed()`, which by then contained the job's OWN checkpoint-1 leads,
   so all of them deduped against themselves. Extracted `rebuildJobLeadExport()` (clears the job's own
   rows first — the same trap the resume path already documented) and both paths now use it.
   Re-probed: **5 leads kept instead of 0.**
3. **UI stepper would have bounced backwards** — checkpoints reporting `classifying` mid-`scraping`
   drive the ordered PHASE_ORDER stepper in reverse. Each checkpoint now reports the coarse phase it
   sits in; the checkpoint activity rides in `phase_detail`, keeping the stepper monotonic.
4. **Test runner never ran async suites** — discovery regex was `/^export function run\w*Tests/`, so
   `hqSplitWeb` (async) had silently never been gated. Regex now accepts `export async function`;
   +2 modules now covered.

### Verification

- Builds ✓ (api-server + dashboard). **28 modules, 677 offline assertions ✓** (was 26/642:
  +storeThrottle 11, +hqSplitWeb, + new playRequestBlocked / enrich-budget assertions).
- Hermetic probe: early exit at checkpoint 1 → `completed`, leads 3/3, progress 100, CSV has 3 rows.
- Real-store probe: Stop mid-similar-crawl → `cancelled`, **5 leads kept**, CSV has 5 rows.
- **Live server smoke on :3913** through the real HTTP API: boot ✓, `/api/health` 200, SPA 200,
  anonymous `/api/me` 401, admin session ✓, job created via POST /api/jobs ✓, queue picked it up ✓,
  charts done +3s, **checkpoint 1 at +4s** ✓, POST /stop → `stopping — finishing current step…` →
  `cancelled` with **leads_found=2** (capped at the requested 2) and a real CSV ✓.
- Dev DB left clean (smoke user/session/job removed, seeded confirmations reverted, probe rows gone);
  `.replit` smoke ports reverted.

### DECISION: do NOT route Play through the residential proxy (overrides the earlier plan)

Measured a real Play response: **1.2 MB per request** (app detail and search alike). At 5,682
enrichment fetches that is **~6.8 GB per run** against a **10 GiB** Proxy-Seller package — one mobile
job would consume ~68% of the monthly allowance, and that allowance is what GATC *confirmation* (the
only phase that actually makes leads) depends on. Two runs would exhaust it and `PROXY_TRAFFIC_ABORT_GB`
would then refuse to start every subsequent job. Play therefore stays on **direct egress + adaptive
backoff**; the backoff is the escape hatch if Google pushes back. Revisit only with evidence of blocks.

### Expected effect on the reported job

2h34m (0 leads) → **~20 min at full scope**, or **~1-5 min when a small order is filled at an early
checkpoint**. Leads visible from ~4s in; a Stop at any point keeps them.

### STILL OPEN (next session picks up here)

- ☐ **Deploy.** All of the above is committed to the working tree but NOT published — production
  still runs the old build. The pending deploy ALSO carries the per-user parallel queue, which is why
  the user's screenshot shows Alberto's 3 jobs queued 2h26m+ behind Michael's one running job.
- ☐ Fixes 3 + 4 from the analysis, deliberately deferred (user chose "Fixes 1+2+5" for this pass):
  - **Fix 3 — demand-driven enrichment.** 6,480 fetches produced 1,738 in-band tail apps to feed a
    confirmation budget that could only examine ~66 publishers. ~100x over-provisioned. Derive the
    enrich budget from the confirmation budget / lead target.
  - **Fix 4 — discovery outruns enrichment.** Discovery added 26,497 apps in 18 min; enrichment
    consumes ≤4,000/run. Backlog went 22,497 → 20,060 and mathematically never drains. The amplifier
    is the search battery: 240 cells → ~17,900 rows because `ITUNES_SEARCH_LIMIT=200`. Either cap
    what discovery may ADD per run to what enrichment can consume, or cut the search page size.

## Godlike audit #4 — round 2 on the lead-first + speed work (2026-07-26)  ☑

User asked for another full round: audit + blast radius + smoke + auto-fix, with speed re-confirmed.

### Found and fixed

1. **Corpus fast path was missing** (the thing approved in the very first design question).
   `harvestLeads` spent confirmation calls even when the corpus ALREADY held enough deliverable
   leads. Now `exportableNow(seed)` is evaluated BEFORE the budget is touched: an order fillable from
   publishers earlier runs already confirmed skips confirmation entirely — **zero paid API calls, zero
   proxy traffic**. Verified: `checkpoint "top charts": corpus already holds 5 deliverable lead(s)
   (target 3) — skipping confirmation entirely, no API calls spent`.
2. **Per-publisher full-table rescan.** `exportableNow` (publisher scan + dedupe pass) ran once per
   confirmation API call. Now recomputed only when `summary.confirmed` actually MOVES — a publisher
   that came back "not advertising" cannot change the exportable total. On a large corpus this is one
   scan per LEAD instead of one per CALL.
3. **Limiter semantics were easy to misread** (found by a 200-task stress harness). Peak in-flight is
   `min(maxConcurrent, ceil(latency / gap))`, NOT `maxConcurrent` — with Play's latency and a 200ms
   gap only ~2 requests overlap while the run still lands its 5 req/s target. Was a TEST bug, not a
   code bug; the invariant is now documented in the header and pinned by TWO assertions (the rate
   gate binding on fast work, and the ceiling being reachable on slow work).
4. **Cold-corpus honesty.** `rollupPublishers` builds from `allDoneAppDetails()` — enriched apps only.
   So on a COLD corpus checkpoints 1-2 legitimately yield nothing and the first leads appear at
   checkpoint 3 (post-enrichment); on an ESTABLISHED corpus (production: thousands of enriched apps)
   checkpoint 1 has a full corpus to confirm and can fill a small order in seconds. Now stated
   explicitly in the pipeline header instead of implied.

### Limiter stress harness (200 tasks, saturation + 40 interleaved rejections)

No deadlock, no slot leak, cap never breached, limiter still usable afterwards, aggregate rate =
concurrency/interval (591ms vs ~600ms expected), start-to-start pacing confirmed (242ms where the old
settle-based chain would be ~450ms), penalty holds all streams then clears, degenerate configs
(interval 0, 64-wide) safe. Six of these are now permanent assertions in `runStoreThrottleTests`.

### SPEED — re-measured, repeatable, on REAL chart apps (not hand-picked popular ones)

| Concurrency | Run 1 | Run 2 | Success |
|---|---|---|---|
| 1 (old behaviour) | 954 ms/req | 953 ms/req | 15/15 |
| 5 (shipped) | 232 ms/req | 211 ms/req | 15/15 |

**4.1–4.5x on the Play stream**, no failures, no throttling. The 954 ms/req baseline independently
reproduces the user's production figure of 1.16 s/req, which validates the whole cost model.

Full cold-corpus pipeline run (finance/us, real stores): charts +3.0s · **checkpoints 1+2 at +3.1s** ·
enrichment 485 apps / 386 requests in 145.7s (**378 ms/req sustained, vs 954 ms/req old = 2.5x** —
lower than the isolated A/B because the window also carries the Apple stream and checkpoint work) ·
dev catalogs 358 Play + 85 Apple in **289s** (Apple-bound; the old 6s interval would have made the
Apple half alone ~510s) · re-enrichment running on the SHARED budget (Fix 2 confirmed in situ).

### Blast radius — verified, not assumed

- `playSource`/`appleSource` are imported ONLY by `storeEnrich`, `publisherRollup` (URL helpers) and
  `storeDiscoveryPipeline`. meta / affplus / appgoblin / googleAds pipelines never touch them, so the
  throttle changes cannot reach them. Confirmed by grep, and those files are untouched in this diff.
- `RateLimiter` has exactly 2 production call sites (both updated); `maxConcurrent` defaults to 1 so
  the signature stays backward-compatible.
- `ConfirmSummary` (+`reachedTarget`) and `EnrichSummary` (+`budgetLeft`) each have exactly 2
  constructors, both updated. `scripts/verify-tail-confirm.mjs` calls `confirmPublishers` without the
  new optional `enough` — still valid.
- `rollupPublishers` / `scoreAllPublishers` are SYNCHRONOUS, and so is the whole
  clear→build→persist sequence in `rebuildJobLeadExport`. With single-threaded JS + sync sqlite that
  makes the rebuild ATOMIC against concurrently running jobs — **no cross-job dedupe race** even
  under the per-user parallel queue.
- Progress spans verified contiguous and monotonic: 0-6 · 6-18 · 18-32 · 32-40 · 40-58 · 58-66 ·
  66-70 · 70-74 · 74-78 · 78-95 · 95-100. All four exit paths funnel through `finishRun()`;
  `markJobCompleted` appears exactly once.
- **Live multi-source smoke on :3914**: store_first / google_ads / meta / affplus / appgoblin all
  created + queued + stopped → every one settled `cancelled` cleanly. Validation guards still fire
  (appgoblin no-axis 400, unknown market `zz` 400).

### Full cold-corpus run — completed end to end (finance/us, real stores)

    +3.0s    charts done: 500 sightings / 485 distinct
    +3.1s    checkpoint 1 "top charts"          → 0 leads (cold corpus: nothing enriched yet)
    +3.1s    checkpoint 2 "long-tail discovery" → 0 leads
  +148.8s    enrichment: 485 apps, 386 requests (145.7s @ 378 ms/req sustained)
  +149.1s    checkpoint 3 "enriched catalog"    → 0 leads (probe ran with confirmBudget=0)
  +438.3s    dev-catalog: 358 Play + 85 Apple → +978 apps  (289s, Apple-bound; was ~510s at 6s)
  +659.3s    re-enrichment: 978 fetched / 485 cached, 851 requests — SHARED budget, no cap warning
  +734.2s    liveness: 529 apps re-checked
  +734.5s    checkpoint 4 + CSV + completed at 100%

**12.2 minutes wall-clock for a complete run**, every phase reached, job `completed` at 100%.
0 leads is CORRECT here and honestly reported — the probe deliberately ran `confirmBudget=0` to avoid
paid calls, and the export filter said so: *"0/376 publishers confirmed advertising (376 held back —
of those 376 not yet checked by the confirmation budget)"*. Fix 2 is visible in situ: the second
enrichment pass fetched exactly the 978 catalog apps out of the run's shared remainder, with no
"budget exhausted" warning — the old code would have handed it a fresh 4,000.

### Also fixed this round

- **Re-enrichment relabelled.** The second pass kept `phase_detail = "developer catalogs"`, which is
  literally what made the reported job look frozen at 73% for the better part of an hour. It now
  reports `app detail (portfolio pass — N new apps)`.
- Stale throttle comments in `storeEnrich.ts` / `storeDiscoveryPipeline.ts` still claimed
  "Play 1 req/s, iTunes 1 req/6s". Updated. (`appCategory.ts` keeps its own 6000/1000 ms constants —
  they are the CPS pipeline's separate `GATC_*` tunables and are correctly out of scope; storeEnrich
  imports only pure classification helpers from it.)

### Verification totals

Builds ✓ (api-server + dashboard). **28 modules, 683 offline assertions ✓, 0 failed.**
Dev DB left clean (all smoke users/sessions/jobs/logs/results removed, seeded confirmations reverted;
128 publishers / 0 confirmed, exactly as before). `.replit` smoke ports (3911-3914) reverted — twice,
Replit re-adds them on every port bind.

## STREAMING lead pump + real-time Excel + proxy exit rotation (2026-07-26 evening)  ☑ CODE DONE

**User requirement, verbatim intent (asked "many times", with visible frustration):** scrape app →
look it up on Ads Transparency IMMEDIATELY → add to the Excel IN REAL TIME. NOT batch checkpoints,
NOT "reach 20 then maybe export". Leads must be in the planned Excel WHILE scraping runs. Burning
proxy GB + time on discovery before any confirmation is the waste being complained about.

### THE PROXY FINDING — user was RIGHT, and it is measured

User's theory: "each request needs to come with a different request so the dynamic resident proxy
changes... not reuse the same request again and again." Tested live against the real Proxy-Seller pool
(tiny IP-echo payloads):

| setup | exit IPs across 5 requests |
|---|---|
| shared ProxyAgent (**what the code did**) | 176.214.206.142, 95.24.117.161, 176.214.206.142, 95.24.117.161, 176.214.206.142 → **2 distinct** |
| fresh ProxyAgent per request | 4 different IPs → **4 distinct** |

The account IS set to "rotate for each request" — but that only applies to a NEW CONNECTION. undici's
keep-alive pool pins each pooled connection to an exit, so an entire run's Ads Transparency traffic
egressed from ~2 residential IPs on repeat. That is a direct cause of GATC penalty-boxing.
`rotateProxyExit()` existed but fired ONLY reactively, after a block.

**Fix:** `GOOGLE_ADS_PROXY_ROTATE_EVERY` (default **25**, 0 = never/old behaviour, 1 = every request)
drives PROACTIVE rotation from inside `withProxy()`. 2 IPs/run becomes ~80 distinct exits for a
2,000-call budget. Rotation drops the cookie jar (cookies from a burned exit look stolen on a new IP),
so `rpcPost` now lazily re-warms when `!warmedUp` — one homepage GET per rotation, ~4% overhead,
instead of leaving the rest of the run RPC-ing cold. Default 25 (not 1) amortises that warm-up.
Verified through the real `withProxy()` path: with stride 1 the per-exit counter resets every request.

### What shipped in the pipeline

1. **storeConfirm.ts** — `skipConfirmedSince` (never re-charge a publisher already checked THIS RUN;
   also stops the 4 barrier passes re-spending budget on the queue head), `skipWarmUp` (one session
   warm-up per run), pure `filterUncheckedSince()` (+6 assertions).
2. **storeDiscoveryPipeline.ts** — **continuous background lead pump**: ticks every 15s (in 1s
   cancel-responsive slices), each tick a no-op unless discovery rolled up NEW unchecked publishers,
   so idle ticks cost zero network and zero budget. `queueHarvest()` is a promise-chain mutex so pump
   ticks and phase barriers never run two confirm passes against one shared budget. `stopPump()` is
   awaited on EVERY exit path (finish, cancel, failure) so no in-flight pass can rewrite a settled
   job's CSV. Total confirmation spend is IDENTICAL to the old single terminal pass — only the timing
   moves.
3. **REAL-TIME Excel** — `exportLeadsSoFar()` calls `setJobCsvPath()` on the FIRST export, so the
   download route serves the growing file mid-run (same mechanism the CPS pipeline already used).
   UI: both Download-CSV gates in App.tsx are now `csv_path != null` instead of completed/cancelled,
   labelled "CSV so far" / "Download CSV (so far — leads stream in live)" while running.
4. **Target-met halts everywhere** — `leadTargetMet` now breaks the chart tasks, similar crawl, both
   search halves, and both enrichment passes (`shouldStop`), plus early `finishRun()` returns before
   catalogs and before liveness. Previously the order could only be recognised at a barrier.

### PROOF the requirement is met

Hermetic probe against real stores, corpus seeded with 6 confirmed publishers, target 50 (so the run
CANNOT finish instantly and must keep scraping):

    first CSV appeared at : +3.2s
      job status then     : running          <-- still scraping
      phase then          : scraping/similar crawl + store search
      rows in it then     : 6                <-- real leads, downloadable
    final status          : cancelled | leads 6
    VERDICT: leads were downloadable DURING the run

Builds ✓ (api-server + dashboard, new bundle `index-gKDSRi-Z.js`). **28 modules, 689 assertions ✓.**

### ⚠ PRODUCTION DATA MAY BE EPHEMERAL — VERIFY BEFORE TRUSTING THE WARM-CORPUS PATH

After the last publish, production Activity showed "0 past jobs" and the user's new run behaved like a
COLD corpus. If Replit's deployment filesystem is ephemeral, `data/ad-library.sqlite` (the permanent
corpus AND the lead-history dedupe) is wiped on every deploy — which would mean every run re-discovers
from scratch and the corpus fast path never pays off. CHECK THIS FIRST next session; if confirmed, the
corpus needs persistent storage (Replit object storage / external DB) and that is the single highest-
value remaining fix.

### Godlike audit #5 — on the pump itself  ☑

**Adversarial harness** replicating the real promise-chain shape (6 invariants, all hold):
single-flight held under 3 concurrent barrier calls + ticks (peak 1); no pass left in flight; **no
pass ran after stopPump** (the finalize-safety invariant); chain drained by stopPump; budget respected
across passes; pump halts once target met; stopPump idempotent (finishRun + catch may both call it);
a throwing pass does not wedge later passes.

**Bugs found by this audit and auto-fixed:**
1. **Pump would have dragged the UI stepper BACKWARDS.** Ticks always reported `phase:'scraping'`, so a
   tick during `enriching` rewound the ordered stepper — the exact regression fixed for checkpoints in
   audit #3. Added `quiet` mode: pump passes touch NEITHER the coarse phase NOR the progress bar
   (their zero-width span was meaningless anyway). The live signal stays the lead counter + growing
   CSV, and a tick now logs only when the count actually moved.
2. **One RPC per rotation went out cold.** Rotation fired inside the SYNCHRONOUS `withProxy()`, which
   cannot await a re-warm — so each rotation left exactly one Ads Transparency RPC egressing from a
   fresh, cookie-less exit (the shape Google rate-limits hardest). Moved the rotation decision to
   `rotateExitIfDue()`, called at the async top of `rpcPost`, so the re-warm is awaited and every RPC
   runs on a warm session. `withProxy` now only counts.
3. Verified no recursion risk: `warmUpSession` is a plain homepage GET (never calls `rpcPost`) and
   sets `warmedUp` before its fetch, so the lazy re-warm cannot loop or double-warm.
4. Verified `setJobProgress` is `MAX(progress_pct, ?)` — monotonic — so the pump's zero-value writes
   are no-ops and can never reset the bar.

### Live smoke — the requirement, proven over real HTTP  ☑

    t+5s   running leads=4  scraping/similar crawl + store search | GET /csv -> 200 rows=4
    t+30s  running leads=4  scraping/similar crawl + store search | GET /csv -> 200 rows=4
    first data row: "Gamma Greeks: AI Stock Option Signals, Flow Alerts",US,https://play.google.com/...

Leads downloadable via the real API **while status=running, mid-`scraping`** — before classification.
A Stop then kept all 4 (`store_first cancelled leads=4`).

**Smoke-methodology bug found (NOT a product bug):** the first attempt showed `leads=4` but
`csv_path=null`/404. Cause: THREE server processes from earlier smokes (ports 3913/3914) were still
alive sharing one sqlite DB, and an OLD one's queue worker picked up the job and ran pre-`setJobCsvPath`
code. Killed all, re-ran on a single clean server → correct. **Lesson for future smokes: always
`pkill -9 -f dist/index.js` and verify zero survivors BEFORE creating jobs**, or results are garbage.
(Not a production concern — prod runs exactly one process.)

**Blast radius:** all 5 sources create + settle `cancelled` cleanly; guards still fire (appgoblin
no-axis, unknown market `zz`). `googleAdsScraper` rotation touches the CPS pipeline too — that is
intended and beneficial (same penalty-box exposure), ~4% warm-up overhead at the default stride of 25.
Dev DB restored exactly (128 publishers / 0 confirmed / 0 stray jobs); `.replit` reverted.

Builds ✓ both packages. **28 modules, 689 assertions ✓, 0 failed.**

### REMAINING
- ☐ PUBLISH (still carries the per-user parallel queue too — Alberto's jobs are still serialized in
  prod until this ships).
- ☐ Deferred by user choice, still open: Fix 3 (demand-driven enrichment) and Fix 4 (discovery
  outruns enrichment; search battery amplifier via `ITUNES_SEARCH_LIMIT=200`).

## Custom lead count (user ask, 2026-07-26)  ☑

**Ask:** next to "How many leads do you want?" give a fillable textbox so the user can pick any number.

- **Server needed no change** — `normalizeMaxLeads` was already deliberately permissive about the
  VALUE (any positive integer) and the route never whitelisted against `LEAD_LIMIT_CHOICES`. This was
  purely a UI gap.
- **New `parseCustomLeadCount(raw)` + `LEAD_LIMIT_CUSTOM_MAX` (100,000)** in `csv.ts`. Digits only —
  REJECTS decimals rather than flooring them (typing "2.5" meant something; silently exporting 2 is
  the quiet surprise this codebase avoids), rejects 0/negative/`1e3`/`+7`/trailing junk, tolerates
  whitespace and leading zeros. The max is a typo guard for the form, NOT a server restriction — the
  API still honours anything positive for ops/direct callers.
- **Form**: 20 / 50 / 100 / "As many as found" / **Custom + number box**, inline in the Custom row
  (`.checkbox-row` stacks vertically, so the input lives inside the label). Focusing or typing selects
  Custom, so a number can never be entered and then silently ignored because a preset was still on.
  Explicit `useCustomLeads` mode flag rather than deriving "is custom" from "not a preset" — the
  latter would deselect the box the instant someone typed 20 and would discard mid-edit text.

### Audit findings on this change → both auto-fixed

1. **Dead-end UX**: Custom selected with an EMPTY box disabled Start with no explanation at all. Split
   `customLeadsMissing` (always explained, gates Start) from `customLeadsInvalid` (also styled red).
   A `type=number` input reports `''` for un-parseable text like "abc", so blank can mean "untouched"
   OR "browser rejected the keystrokes" — both now get the hint.
2. **Mirror drift risk**: the dashboard is a separate package and MIRRORS the validator (same pattern
   as `LEAD_LIMIT_CHOICES` / `countries.ts`). A "keep in sync" comment enforces nothing, so:
   **new `scripts/check-lead-mirror.mjs`** runs BOTH implementations over 20 inputs and fails on any
   disagreement, wired into `npm test` as its own gate step. **Negative-tested both ways** — injecting
   constant drift (100k→50k) and logic drift (UI accepting decimals) each made the script exit 1 and
   the whole suite fail with `✗ failing modules: lead-cap-mirror`; restoring returned it to green.

### Smoke (single clean server on :3917/:3918)

- Custom values reach `source_params` verbatim: 7 → 7, 33 → 33, 250 → 250, 99999 → 99999.
- Other sources carry a custom cap too: google_ads / meta / affplus all stored `maxLeads=37`.
- **Cap actually limits the export**: corpus seeded with 9 confirmed publishers, asked for 3 →
  `completed leads=3`, delivered CSV had exactly **3 rows**.
- Blast radius: preset path unchanged; `LEAD_LIMIT_CHOICES` still drives the radios.

Builds ✓ both packages. **28 modules, 709 assertions ✓** (+20 from this change), mirror gate ✓.
Dev DB restored (128 publishers / 0 confirmed / 0 stray jobs); `.replit` reverted.

## NEXT LEVEL SPEED — confirm-before-enrich fast lane (2026-07-26 evening)  ☑ DONE

**User:** *"The current progress of scraping is still relatively slow, I need to find a much faster
way to scrape and get leads. We need to make it next level."*

### What the production log (markets=[ca], 9 verticals) actually shows

    19:17:57  job started
    19:18:46  charts done: 9,717 sightings; 8,105 distinct rows      <- 49 SECONDS. Charts are FAST.
    19:18:46  checkpoint "top charts": 0 lead(s)
    19:18:46  similar depth 0: 7,206 seeds
    19:18:12..19:24:17  rollup: 0 publishers  (every 15s, forever)

**The gate is ENRICHMENT, and the reason is architectural, not throughput.**
`rollupPublishers` reads its whole world through `allDoneAppDetails()` — apps with
`enrich_status='done'`. On a cold corpus NOTHING is enriched, so 8,105 discovered apps roll up to
**0 publishers**, and 0 publishers means 0 confirmations means 0 leads. The pump then spins doing
nothing until enrichment finishes: 8,105 Play detail fetches at ~5 req/s ≈ **27 minutes** before the
first lead can even be attempted. Play detail pages are ~1.2 MB each — we download ~9.7 GB of HTML
per run to extract a developer name, email and install count.

### THE IDEA THAT CHANGES THE ORDER OF MAGNITUDE — confirm BEFORE enrich

Two facts already true in the codebase:

1. **Chart/search/similar list responses ALREADY carry publisher identity.** `PlayListApp` is
   `{ appId, title, developer, developerId }` (playSource.ts) — the developer is in the LIST payload
   we have already paid for. Apple's RSS gives `artistName` likewise. We do NOT need a 1.2 MB detail
   fetch to know who publishes an app.
2. **Confirmation only needs a name/domain.** `confirmOne` queries GATC by publisher name and by
   website domain. The name is available from step 1 the moment the charts land.

So the funnel is currently **inverted**. Today: discover 8,105 → enrich ALL 8,105 (27 min, ~9.7 GB) →
roll up → confirm ~66 (budget 200 ÷ ~3 calls) → export 20. We enrich ~400 apps for every publisher we
can afford to check, and ~8,000 for every 20 leads delivered.

**Proposed: discover → roll up a PROVISIONAL publisher from list-payload identity → confirm → enrich
ONLY the confirmed winners (for email/website/installs, which are needed for the deliverable, not for
the verdict).** Enrichment drops from ~8,105 apps to ~60. Leads become possible at **~1 minute**
instead of ~27, and the run stops paying for HTML nobody reads.

Work required (non-trivial, needs its own design pass):
- A provisional publisher row keyed on `developer_id` / `artistName` from list payloads, which the
  full rollup later merges into (the merge machinery already exists — UnionFind on domain/name).
- `listPublishersForConfirmation` must accept provisional rows (today it gates on `is_charted` /
  `in_band`, and `in_band` needs installs, i.e. enrichment).
- Scoring/export must tolerate a publisher whose apps are not enriched yet (email/website null →
  enrich on demand before export).
- Keep the existing path as the fallback for anything the provisional path cannot resolve.

### ✅ SHIPPED — measured result

**A complete 3-lead job on a COLD corpus, with real Ads Transparency, in 20 seconds:**

    +2.8s   charts done: 500 sightings / 484 distinct
    +3.0s   fast lane: 356 publisher(s) from list data alone (NO detail fetch)
    +5.7s   first GATC confirm calls
    +7.5s   confirm: lead target reached after 7/356 publishers (10 calls)
    +7.5s   winners: enriching 7 app(s) across 3 confirmed publisher(s)
    +10.1s  CSV written — 3 publisher leads
    +20.4s  store-first job completed early

Real leads with full contact details: Block, Inc. (support@squareup.com, 27 GATC ads), Green Dot
(appsupport@GO2bank.com, 40 ads), Branch Messenger (20 ads). **7 publishers checked and 7 apps
enriched — instead of enriching ~8,000 apps before the first confirmation could even run.**
Live HTTP smoke on an EXISTING database: 2-lead job complete in 24s, CSV downloadable at +13.8s,
8 API calls, 3 app fetches.

Before: the reported production run spent 2h34m and delivered 0 leads.

### How it works

1. **Persist the identity the list payload already carries.** New `discovered_apps.list_developer` /
   `list_developer_id` (+ migration + index), filled at all four Play ingestion sites (charts,
   similar, search, catalogs). Costs zero extra requests — the data was being discarded.
2. **`rollupProvisionalPlayPublishers()`** builds real publisher rows from that identity alone, so a
   charted publisher is confirmable seconds into a run instead of after full enrichment.
3. **`enrichConfirmedWinners()`** detail-fetches ONLY publishers that already confirmed as
   advertisers, to fill email/website. Bounded by `WINNER_ENRICH_MAX_PUBLISHERS` (40) and
   `WINNER_ENRICH_APPS_PER_PUBLISHER` (3), drawing on the run's SHARED enrichment budget — it
   re-prioritises fetches toward leads rather than adding any.

### MEASURED CORRECTION — the original plan's premise was wrong

The plan above assumed Play's chart list returns `developerId`. **It does not.** Verified live against
google-play-scraper 10.1.3:

| endpoint | developer | developerId |
|---|---|---|
| `list()` (charts) | "Block, Inc." | **undefined** |
| `similar()` | name | undefined |
| `developer()` | name | undefined |
| `search()` | name | the NAME (Play uses the name as id for non-numeric devs) |

So identity is the developer NAME. The design was reworked to group on `mergeNameKey(developer)` and
register identity key `n:<key>` — which `identityKeysFor()` ALSO emits for every rolled-up publisher
(via `mergeableNames`, one per app, unconditionally). That is what makes the full rollup land on the
SAME row. Name merging is looser than id merging, but it is exactly the merge evidence the existing
rollup already uses, so no new class of risk.

### Godlike audit → 4 real problems found and fixed

1. **FATAL BOOT BUG — would have taken production down on deploy.** `CREATE INDEX ... ON
   discovered_apps(list_developer)` sat inside the schema `exec()` block that runs BEFORE
   `addColumnIfMissing`. On any EXISTING database `CREATE TABLE IF NOT EXISTS` is a no-op, so the
   column did not exist yet → `SqliteError: no such column: list_developer` → server refuses to
   start. Caught by booting against the real dev DB. Index now created only after the migration.
2. **4 SECONDS PER PUMP TICK.** The fast-lane query used two correlated subqueries per group for the
   preview app; on a corpus the size of the real run (8,000 apps / 2,000 devs) that measured
   **3,526 ms** of a 4.8 s pass — a quarter of every 15 s tick, competing with the scrape. Rewritten
   to use SQLite's documented min()/max() bare-column rule (one pass, no subquery) and the index
   corrected to the column actually grouped on. **3,526 ms → 11 ms.**
3. **Repeat passes on an unchanged corpus.** Added `countPlayListIdentityRows()` change detection
   (+ `resetFastLaneCache()` at run start so a new job never inherits the previous verdict).
   **Steady-state tick 3,970 ms → 1 ms.**
4. **Provisional rows would have vanished from the Publishers view.** They were written with a
   synthetic `source_mix: {list: N}`, but the view FILTERS on source_mix — so any source filter would
   have hidden them. Now emits the real per-source counts (chart/search/similar/developer_catalog).

### Gate

New `scripts/check-fast-lane.mjs` (wired into `npm test`, runs in a throwaway DB) pins **14
invariants**, including the load-bearing one: a provisional row and the later full rollup are the
SAME publisher row id — never a duplicate. Also: no invented email/website, `in_band=0` without
installs, no downgrade of enriched data, two spellings fold into one publisher, unchanged corpus
short-circuits, a new discovery re-arms it. **28 modules, 709 assertions, both gates green.**

### Godlike audit #6 — round 3 on the fast lane  ☑

**SEVERE BUG FOUND AND FIXED — silent data loss on partially-enriched publishers.**

`upsertPublisher`'s ON CONFLICT clause COALESCEs `email`/`website` (so those were safe) but assigns
`both_stores`, `in_band`, `is_game_publisher`, `app_count`, `source_mix`, `countries_*`, `verticals`
and the previews **unconditionally from `excluded`**. That is correct for the full rollup, which
recomputed the world — but a PROVISIONAL row knows none of those facts and writes 0/null.

So a publisher that already had enriched apps, and then gained ONE new unenriched app from a chart
sighting, was rewritten to `in_band=0, both_stores=0, is_game_publisher=0`. Proven with a probe:

    BEFORE fast lane: {in_band:1, both_stores:1, is_game:1, app_count:3, email:"x@clob.example"}
    AFTER  fast lane: {in_band:0, both_stores:0, is_game:0, app_count:3, email:"x@clob.example"}

`in_band=0` is the damaging one: `listPublishersForConfirmation` gates on `is_charted=1 OR
in_band=1`, so a TAIL publisher zeroed this way silently drops out of the confirmation queue and can
never become a lead. The earlier fast-lane gate missed it because it only covered the
fully-unenriched and fully-enriched cases, never the partially-enriched one in between.

**Fix:** new `upsertPublisher(..., { preserveEnriched: true })` mode used by the fast lane only. Its
conflict clause never lowers enrichment-derived facts, and only RAISES counters
(`app_count`/`charted_app_count`/`is_charted` via MAX, `best_rank` via MIN, previews via COALESCE).
Re-probed: every field preserved. Two new gate invariants pin it (partially-enriched preservation,
and that counters still rise), bringing the fast-lane gate to **16 invariants**.

**Checked and cleared (no action needed):**
- **absorb path**: `mergePublisherFields` picks `is_game_publisher` from whichever row has more apps,
  and a provisional row can have a higher `app_count` while always reporting 0 — but absorbs run
  BEFORE the INSERT…ON CONFLICT, which then overwrites `is_game_publisher` with the correctly
  computed value. Self-healing; verified by reading the statement order.
- **export quality**: provisional rows carry `score 0` and no contact details, but the export is
  confirmed-only, so an unconfirmed provisional row can never reach a CSV.
- **real-data integrity**: on the live dev corpus, 9 publishers matched the "clobber signature"
  (enriched but all-zero facts) — each was checked against its own enriched apps and all 9 are
  **legitimately** zero (single app, out of install band, single store, non-game). No damage.
- **`unenrichedAppsForPlayDevelopers([p.name])`** looks up winners by the publisher's display name,
  so if two spellings folded into one group only the primary spelling's apps are found. Harmless at
  the configured budget (3 apps per publisher is almost always satisfied by the primary spelling).

**Blast radius:** boots clean against the EXISTING database (the fatal-migration case from audit #5);
all 5 sources create and settle `cancelled`; guards fire (appgoblin no-axis, market `zz`); custom
lead count 137 stored verbatim; live run shows `fast lane: 327 publishers at +3.0s`, checkpoint at
+3.3s, stop kept 2 leads. Dev DB restored, `.replit` reverted, both packages build,
**28 modules / 709 assertions / both gates green.**

### Godlike audit #7 — pre-publish pass  ☑

**Found and fixed: the provisional preview app relied on UNDEFINED SQLite behaviour.**

The fast-lane query picked its preview app (which becomes the lead's `store_url`) using SQLite's
min()/max() "bare column" rule. That guarantee holds only when a query contains **exactly one**
min/max aggregate — this query has three (`MAX(developer_id)`, `MIN(best_rank)`, `MIN(preview_sort)`).
With more than one, the row backing a bare column is explicitly implementation-defined.

It happened to return the right app in every test, including an adversarial one (flagship inserted
last, decoys interleaved, unrelated inserts) — i.e. it was correct **by luck of the current
implementation**, and the failure mode would have been silent: leads pointing at an arbitrary app of
the right publisher. Replaced with an explicit `ROW_NUMBER() OVER (PARTITION BY list_developer …)`
CTE — defined behaviour. Cost: 11ms → 25ms on an 8,000-app corpus (vs 3,526ms before any of this),
still ~1ms in steady state. Two gate invariants added (correct pick when the best app is inserted
LAST; stable across unrelated inserts).

**Verified clean this round (no action needed):**
- **Resume path**: run → stop → `resumeJob()` → run again. 406 publishers before and after, **zero
  duplicate publisher names**, CSV intact across the resume.
- **Winner-enrichment budget math**: `spent = budget − res.budgetLeft`, deducted from the run's
  single pool — correct, and self-limiting (a publisher whose apps carry no email stops producing
  work once its apps are enriched).
- **Concurrency**: `rollupProvisionalPlayPublishers` is fully synchronous, so under the per-user
  parallel queue each pass is atomic; the module-global change detector is reset per run and at worst
  costs one redundant pass.
- **End-to-end after the rework**: 3 leads in 21s on a cold corpus, correct flagship store URLs
  (Block, Inc. → com.squareup.cash), full contact details.

**Trend across rounds:** #5 found a fatal boot failure and a 4s/tick regression, #6 found silent data
loss, #7 found one latent (not-yet-manifesting) correctness risk. Severity is falling round over
round, which is the signal that this has converged.

### Godlike audit #8 — the Custom lead box was unusable in production  ☑

**User report: "can't type here anything."** The custom lead-count box rendered as a tiny empty oval.

**Root cause: a CSS specificity collision, not a React bug.** `.checkbox input { width: 18px; height:
18px }` was written to size the tick/dot controls, but it matches **any** input nested in a
`.checkbox` row. At specificity **0,1,1** it silently beat `.input-inline` (**0,1,0**) and squashed
the new number box to 18×18. With `box-sizing: border-box` plus its own padding that leaves zero
usable text area — so the control still existed, still focused, still held state, but had nowhere to
render characters. Worse, at that size the entire control is the number **spinner**: clicking it
incremented the value instead of placing a caret (the negative control reproduced this precisely —
clicking then typing `250` yielded `1250`).

Nothing threw. `tsc` was happy. All 709 assertions were happy. **Only a human looking at the page
could see it, and the user saw it before we did** — this is the first defect in this repo that no
amount of server-side testing could have caught.

**Fix** (`artifacts/dashboard/src/styles.css`):
- Type-qualified the sizing rules → `.checkbox input[type="checkbox"], .checkbox input[type="radio"]`
  (same for the `:disabled` and `:disabled + span` variants).
- `.input-inline` gained `flex: 0 0 auto` (it lives in a flex row, so a bare width is still
  shrinkable) and `cursor: text` (`cursor` is an **inherited** property and `.checkbox` sets
  `pointer`, which made the box read as a non-editable chip).

**Verified with a real browser — now a durable repo script:**
`scripts/check-custom-lead-box.mjs` (Playwright + the real production bundle behind a stub API built
from the compiled server's own config constants). Not in the default gate — it needs a browser and a
built dashboard, so it runs like the network suites:

    pnpm --filter dashboard build && node artifacts/api-server/scripts/check-custom-lead-box.mjs

It skips cleanly (exit 0) if the dashboard isn't built or Playwright can't launch, and dumps a
full-page screenshot to the temp dir on failure. 19 assertions, all green:
box is 128×37px; clicking focuses the number input (not the radio); keystrokes land; typing selects
the Custom radio; the hint clears on a valid number and returns when emptied; Start enables/disables
correctly; presets still clear Custom; radios and country checkboxes are still exactly 18×18; no
horizontal overflow; `999999` / `0` / `2.5` / `-5` are all rejected; and **the typed number actually
reaches the API payload** (`maxLeads: 250`).

**Negative control** (the discipline that makes the above mean something): re-appending the old
`.checkbox input` rule to the built CSS reproduced the bug exactly — 22×18px, `value="1250"`.

**New permanent gate: `scripts/check-form-css.mjs`** (wired into `run-tests.mjs`, now 3 gates).
Static scan, no browser or build needed. Forbids the general trap — an element-type descendant
selector under a class that sets a box dimension, because it silently captures every control added
to that container **later** — and pins `.input-inline`'s width/cursor/flex. All 5 negative controls
confirmed to fail it (reintroduce the bug, shrink the width, drop `cursor: text`, drop `flex`, and a
brand-new broad selector elsewhere in the file).

**Lesson for this repo:** the test suite has no eyes. Any future change to a *rendered control* needs
a browser probe or a static CSS gate — server-side assertions structurally cannot see layout.

### Other levers, ranked (measure before committing)

1. **Persistent corpus — NOW THE TOP REMAINING ITEM.** Production shows 0 publishers at job start
   and "0 past jobs" after a publish; the deploy filesystem looks EPHEMERAL, so every run starts
   cold. The fast lane makes a cold start survivable (leads in seconds rather than never), but a
   persistent corpus would still remove all repeat discovery work. **Verify first.**
2. **Enrich only what can become a lead** (deferred "Fix 3"): today's budget enriches ~100x more apps
   than the confirmation budget can ever examine.
3. **Cap discovery to what enrichment can consume** (deferred "Fix 4"): discovery adds ~20k apps/run
   while enrichment consumes ≤4k, so the backlog grows monotonically and never drains. The amplifier
   is the search battery (`ITUNES_SEARCH_LIMIT=200`).
4. **Raise `STORE_PLAY_CONCURRENCY`.** Measured clean at 8 (142 ms/req) vs the shipped 5 (211 ms/req);
   the limiter and adaptive backoff already support it. Cheap, but only ~1.5x — a tuning knob, not
   the answer.
5. **A cheaper publisher-detail source.** If a lead needs an email, consider whether the Play
   *developer page* (one fetch per DEVELOPER, ~hundreds) can replace per-APP detail fetches
   (~thousands) for contact discovery.

### Bugs fixed in this pass (found in that same log)

- **Pump log spam.** `rollupPublishers`/`scoreAllPublishers` log at INFO unconditionally, so a quiet
  background tick still emitted "rollup: 0 publishers" + "scoring: 0 publishers scored" every 15
  seconds forever, burying the run's real story. Background passes now get a silent logger; barrier
  passes keep full output.
- **Pump did real work on an unchanged corpus.** Every tick ran a full rollup (loads every enriched
  app + every sighting) even when nothing had moved. Now gated on a single indexed
  `countDoneAppDetails()` plus the unchecked-publisher count — an idle tick costs one COUNT.

## Notes / decisions log

- 2026-07-26: File created from user's request. Order chosen: background jobs first (user: "most important thing"), then UI unification, then speed.
- 2026-07-26: Play stays on direct egress — residential proxy is GB-prohibitive for 1.2 MB Play pages
  (see the DECISION block above). Concurrency 5 chosen over the clean-at-8 measurement for margin.
- 2026-07-26: Live Proxy-Seller balance at time of writing: **51.2 MB used of 10 GB** (0.5%), package
  active until 21.08.2026. Confirms the proxy is nowhere near pressure for what it is actually used
  for (small GATC JSON round-trips) — and that routing 1.2 MB Play pages through it would have been
  ~130x the project's entire spend to date, in a single run.
- 2026-07-26: Play stays on direct egress — residential proxy is GB-prohibitive for 1.2 MB Play pages
  (see the DECISION block above). Concurrency 5 chosen over the clean-at-8 measurement for margin.
