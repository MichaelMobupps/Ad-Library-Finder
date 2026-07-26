# TODO — UI Simplification + Background Jobs + Scraper Speedup

> **Purpose of this file:** durable task record so work can resume if SSH disconnects.
> **If you are picking this up fresh:** read this whole file, check the ☐/☑ status marks,
> read the "Repo map" section (filled in during Phase 0), and continue from the first
> unfinished item. Update status marks as you go.

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

## Notes / decisions log

- 2026-07-26: File created from user's request. Order chosen: background jobs first (user: "most important thing"), then UI unification, then speed.
