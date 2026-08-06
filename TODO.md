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
| O-1 | **Confirm `PUBLIC_BASE_URL` is actually set in production.** It defaults to `''`, and every emailed link is built as `${PUBLIC_URL}${path}`. If unset, every "Download CSV" / "Download HQ split" / "View full job log" link ever sent is a bare rooted path (`/api/jobs/<id>/csv`) — not clickable from an inbox. Pre-existing, unchanged by Bundle 1. Verify on the Reserved VM before cutover. **V1 partial evidence:** in the *workspace* environment it IS set, to `https://leadfindermobupps.replit.app` (read from `process.env`, no secret printed). That is the workspace's own env, which is not necessarily the Reserved VM's — the check still has to run there. | B1 discovery | OPEN — needs operator check on the VM |
| O-2 | **Count live emailed links on production.** Cannot be determined from the workspace: the workspace `data/ad-library.sqlite` is the dev copy and is empty (0 jobs, 0 users, 0 sessions). Production data lives on the Reserved VM (`deploymentTarget = "vm"`). Run there: `SELECT COUNT(*) FROM jobs WHERE notification_status='sent';` | B1 discovery | OPEN — needs production query |
| O-3 | Emailed download links carry a **job id, never a token, and never expire**. Access is re-checked per request by session cookie + `canReadJob` (`routes-jobs.ts:565`: owner or admin only). A link forwarded to a non-owning, non-admin colleague returns 404, not 403. Product decision, not a bug. Revisit if result sharing is ever wanted. | B1 discovery | OPEN — informational |
| O-4 | `/api/auth/google/debug` still echoes the **raw** env var (`routes-auth.ts:57`), not the resolved config. Add `basePath`/`publicUrl` resolved values so a cutover can be diagnosed from one endpoint. | B1 audit | **Still open.** Bundle 2 deliberately did NOT take it: it changes a response body, and B2's DARK gate is byte-identity against the recorded baseline — which pins this exact response. Take it in the cutover bundle, and add the fields only while `IS_PREFIXED` so the unprefixed shape stays frozen. Boot logs already print the resolved config. |
| O-5 | `urls.ts` ↔ `config.ts` are a mirror pair with **no automated drift gate**. The repo already has the pattern (`scripts/check-lead-mirror.mjs`). Add an equivalent so the two validators cannot diverge. | B1 audit | DEFERRED |
| O-6 | Job ids are interpolated raw into emailed links (`notifier.ts:28,32,36`). Safe today — ids are `job_${nanoid(10)}`, URL-safe by construction — but not safe *by construction at the sink*. Add `encodeURIComponent` when a bundle can afford the behaviour delta. | B1 audit | DEFERRED |
| O-8 | `artifacts/dashboard/tsconfig.tsbuildinfo` is tracked in git and churns on every build. Should be gitignored. Out of scope (repo hygiene, predates this bundle). | B1 audit | DEFERRED |
| O-9 | ☑ **CLOSED by L2's lineage check (2026-08-02).** The deletion is no longer uncommitted: `main` sits 2 commits ahead of `origin/main`, both platform *"Published your App"* commits, and together they are exactly the `.replit` port-block removal (`git diff origin/main main` = `.replit`, 60 deletions, nothing else). The platform committed its own pruning, which settles the attribution and removes the operator decision. Original text kept below for the record. ~~**`.replit` lost its port mappings, and not from any bundle.**~~ `3901`–`3917` (15 `[[ports]]` blocks) are deleted in the working tree. **V1 attribution:** file mtime `2026-08-01 08:11:39`, i.e. mid-Bundle-2-session (`ROADMAP.md` 07:25, `TODO.md` 08:30) and hours before the V1 session's first write (16:23) — so neither session authored it. Every prior commit touching `.replit` is an automated *"Published your App"*; the deleted blocks are exactly Replit's auto-generated forwarding table (3901→3000 … 3917→9000), and the one mapping the app actually uses (`3001`→`80`, matching `PORT=3001`) survives. Platform-authored pruning on the balance of evidence — no platform log exists to prove it outright. Harmless either way; still **uncommitted and unstaged deliberately**. Restore with `git checkout -- .replit`, or keep it — **operator's call**. | B2 discovery, V1 attribution | OPEN — needs operator decision |
| O-10 | **Updated by L2 (2026-08-02): `/` now answers 307 → `/leadfinder/`, not 404, and `/api/health` answers 200 at BOTH addresses** — so a probe that follows redirects, or better one aimed at `/api/health`, reads healthy. The remaining ask is unchanged and still needs an operator: confirm the Reserved VM's readiness check is port-based, or point it at `/api/health`; a probe that treats a 3xx as failure would still read `/` as unhealthy. Original text: While prefixed, the app's own root `/` returned **404** — only `<prefix>/…` is served. Fine behind the gateway (it forwards `/leadfinder/*`), but anyone hitting the Repl's direct address gets nothing, and any HTTP health probe aimed at `/` would read as unhealthy. Confirm the Reserved VM's readiness check is port-based, not `GET /`. One-line mitigation if needed: redirect `/` to `BASE_PATH` when `IS_PREFIXED`. | B2 audit | OPEN — verify before cutover |
| O-11 | `/version` — the autonomous deploy-detect poller's endpoint (`routes-health.ts:6`) — becomes `/leadfinder/version` at cutover. **Downgraded by L2 (2026-08-02): `/version` now keeps a first-class legacy mount while prefixed, so the existing poller keeps working after the cutover with no external change** (a real mount, not a redirect, precisely because pollers ignore or fail 3xx). Still worth pointing the poller at the prefixed address eventually, so the legacy mount can be retired with the old domain. | B2 audit | OPEN — no longer blocking the cutover |
| O-12 | ☑ **APP-SIDE HALF CLOSED by L2 (2026-08-02).** Live emailed links point at this app's OWN address (`https://leadfindermobupps.replit.app/api/jobs/<id>/csv`, `/hq-zip`, `/#/jobs/<id>`), which keeps serving directly after the cutover — the gateway is not in that path at all. The app now answers all three with a 307 to the prefixed form, proved end to end. What remains is gateway-side and only if the `.replit.app` address is ever RETIRED: any redirect standing in for it must be path-preserving **and** prefix-adding, or every link ever emailed 404s. Original text below. ~~**Emailed-link back-compatibility (its own order, post-cutover).**~~ Now concrete: live links are `<old-address>/api/jobs/<id>/csv`, `/hq-zip` and `/#/jobs/<id>`. When the old address becomes a permanent redirect it must be **path-preserving AND prefix-adding** (`/api/…` → `<gateway>/leadfinder/api/…`), or every link ever emailed 404s. A bare redirect to the gateway root silently breaks all of them. Fragments (`/#/jobs/<id>`) survive a 301 on their own — browsers re-attach them. | B2 audit | OPEN — gateway-side work |
| O-13 | The unprefixed SPA arm still uses `app.get('*')` (**moved by L2 from `index.ts:144` to `app.ts:194`**, behaviour unchanged), which **throws at registration on Express 5** (this repo runs 4.22.2). The prefixed arm is already `app.use(BASE_PATH, …)` and is version-safe. Convert the unprefixed arm when Express is upgraded — it is a boot failure, not a warning. | B2 audit | DEFERRED — blocks an Express 5 upgrade |
| O-14 | `pnpm dev:ui` (Vite dev server) is not prefix-aware: with `BASE_PATH` set, the dev server serves at `/leadfinder/` while its API proxy still matches only `/api`. Nothing in the workflow uses it (`.replit` runs `pnpm start`), so this is a developer-ergonomics gap, not a deploy one. | B2 audit | DEFERRED |
| O-15 | **Mount matching is case-INsensitive, the cookie `Path` is case-sensitive.** Express's default (`case sensitive routing` off, unchanged by any bundle) means `/LEADFINDER/api/me` matches the mount and is served — but RFC 6265 path-match is byte-exact, so the browser would not attach `lf_session` (`Path=/leadfinder/`) and the user reads as signed out. Confirmed by probe: `/LEADFINDER/api/me` → `401`. Not reachable through the gateway, which forwards the exact prefix, and unprefixed it cannot happen at all (`Path=/` matches everything). New only because Bundle 2 narrowed the cookie Path. One line if it is ever wanted: `app.set('case sensitive routing', true)`. **L2 note:** the legacy matcher is deliberately case-SENSITIVE, so `/API/JOBS/<id>/CSV` is not adopted as a legacy address. No emitted link has ever been uppercase — every one is built from a literal — so this affects only hand-typed URLs, which today's case-insensitive mounts happen to serve. | V1 audit | OPEN — informational |
| O-16 | **The emailed "View full job log" link has never deep-linked to the job.** `notifier.ts:29` emits `…/#/jobs/<id>`, but `App.tsx:124` only reacts to `#/settings`; every other fragment is ignored and the user lands on the job list. Pre-existing and unchanged by L2 — surfaced because the link's survival was verified end to end (it now reaches `/leadfinder/` in one hop, fragment re-attached by the browser per RFC 7231 §7.1.2). Fixing it means teaching the SPA to open a job from the fragment; that is a product change, not a migration one. | L2 audit | OPEN — informational |
| O-17 | A legacy **POST with a malformed or oversized JSON body** is answered 400/413 by `express.json` before the 307, because the legacy layer sits after the body parser. That placement is deliberate: the parser and the request logger both precede it, and the log is what proves the method arrives intact. No caller POSTs to a legacy address — the three emailed shapes are GETs and there are no webhooks — so this is a property, not a defect. | L2 audit | DEFERRED |
| O-19 | **`PUBLIC_BASE_URL` carrying a path while `BASE_PATH` is unset is now load-bearing and unguarded.** The boot guard (`assertPublicUrlCarriesPrefix`) only compares the two when a prefix is active, so `PUBLIC_BASE_URL=https://host/some/path` with no `BASE_PATH` boots happily and, since H1, makes the OAuth redirect URI `https://host/some/path/api/auth/google/callback` — a path the app does not serve. Not a new class: that same value has always aimed every emailed link at `/some/path/api/jobs/…`, which is equally wrong, so the state was already broken. Cutover rule 6 says set the pair together, which prevents it. One-line mitigation if wanted: warn at boot when `new URL(PUBLIC_BASE_URL).pathname !== '/'` and `BASE_PATH` is unset. | H1 audit | DEFERRED |
| O-20 | **No rate limiting on the machine seam.** Explicitly out of scope for L-3.3a; recorded because the audit wants it on the record. `/api/chief/*` has no per-token request budget, so a looping Chief can poll `/status` or `/leads` as fast as it likes. Bounded in impact — every path is a read except `POST /jobs`, which is idempotent per `external_id` — but `GET /leads` loads all of a job's `job_results` rows per call (see O-21), so a tight poll is the one shape that costs real work. Take it with the first Chief-side scheduler, or when a second machine caller appears. | L-3.3a scope | OPEN — deferred by the order |
| O-21 | **`GET /api/chief/jobs/:id/leads` is O(all rows) per request.** It calls `getResults(jobId)` (every `job_results` row for the job, `idx_job_results_job`-backed) and then filters and slices in memory, exactly as `buildCsv` does. Correct, and fine at today's sizes — a capped job has ≤ 100 leads, and the biggest jobs hold a few thousand rows — but the cost is per page, not per lead, so a hard poll multiplies it. Push the filter and the LIMIT/OFFSET into SQL if the Chief ever polls a large job aggressively. | L-3.3a audit | DEFERRED |
| O-22 | **The admin Activity view is `LIMIT 200 ORDER BY created_at DESC`** (`listAllJobsWithUsers`, unchanged by L-3.3a). Commanded jobs land in the same list, so a busy Chief can push human jobs out of an admin's view. Not a correctness problem — `/api/jobs` per user is unaffected and every job is still readable by id — but the Activity view stops being "everything recent" once machine traffic outnumbers human traffic. Fix when it bites: a source/owner filter, or paging. | L-3.3a audit | OPEN — informational |
| O-23 | **No job cancellation over the machine seam.** Explicitly out of scope for L-3.3a. The Chief cannot stop a job it commanded; only an admin can, from the Activity view (which does work on commanded jobs, and reports `cancelled` back through `GET /api/chief/jobs/:id`). Add `POST /api/chief/jobs/:id/stop` when the Chief needs to abandon a run it no longer wants. | L-3.3a scope | OPEN — deferred by the order |
| O-24 | **The Chief cannot discover valid AppGoblin category slugs.** `appgoblin_category` is validated for shape only (`[a-z0-9_]+`); the real catalog comes from `GET /api/jobs/appgoblin-categories`, which is cookie-authenticated and therefore unreachable with the token. A commanded AppGoblin job with a well-formed but non-existent slug will be created and will find nothing. Either mirror that endpoint onto `/api/chief` or have C-3.3b hardcode the handful of slugs it uses. | L-3.3a audit | OPEN — needs a decision before the Chief commands AppGoblin |
| O-25 | **`spend_today_usd` reports real money, and the order expected 0.** See deviation 1 in the L-3.3a ledger entry: this app calls the Anthropic API and keeps a USD ledger with a $100/day cap. If the Chief aggregates spend across the fleet, Leadfinder now contributes a real number rather than a structural zero — which is correct, but is not what the fleet-level plan assumed. Worth confirming the Chief's spend model expects it. | L-3.3a discovery | OPEN — informational, for the Chief side |
| O-18 | The legacy layer is an **enumerated list, not a catch-all**: a browser tab left open across the cutover still 404s on `/api/me`, `/api/jobs`, `/api/settings`. Deliberate — a catch-all would have to build its `Location` from the raw request path (the open-redirect shape L2 exists to avoid), and those sessions are invalidated by the `als_session`→`lf_session` rename anyway, so the tab is signed out regardless. Reload lands on the app. | L2 audit | OPEN — informational |

---

## External registrations discovered

*Every place this app's URL is registered with an external service. File and line.
Bundle 1 records these; it does not change them. Each becomes a cutover item.*

| Service | What is registered | File | Line | Cutover action |
|---|---|---|---|---|
| **Google Cloud Console — OAuth 2.0 Client** | Authorized redirect URI: `<app address>/api/auth/google/callback` | `artifacts/api-server/src/oauth.ts` | 14 (path const), 78 (`PUBLIC_URL`, authoritative since H1), 90 (header fallback, only when `PUBLIC_BASE_URL` is unset) | **Add** the new gateway URI in the Cloud Console *before* the cutover and **keep the old one** until the old address is retired. **Since H1 the URI is `PUBLIC_BASE_URL` + the callback path whenever `PUBLIC_BASE_URL` is set — it no longer follows the request host.** So the URI to register is exactly the one you can predict from that variable, and the only way to change it is to change that variable. Google rejects any URI not on the allow-list, so sign-in breaks for everyone the moment the two disagree. |
| (same, documented) | `<PUBLIC_BASE_URL>/api/auth/google/callback` | `SETUP_GOOGLE_OAUTH.md` | 36 | Update the doc when the address changes. |

**The exact URI the app now sends, character for character.** Re-derived in the H1 LIT
smoke through the real sink and read from the server's own log in **both** OAuth steps —
not composed by hand:

```
https://tools.mobupps.net/leadfinder/api/auth/google/callback     <- the only one sent, since H1
```

**Keep every existing URI registered** (cutover rule 5), including
`https://mobupps-tools-gateway.replit.app/leadfinder/api/auth/google/callback`, which is
now **unused**: since H1 the app sends the `PUBLIC_BASE_URL` one whatever host the request
arrived through. A consequence worth knowing: **the gateway's `.replit.app` mirror is no
longer a self-contained login surface** — a user who starts sign-in there is returned by
Google to `tools.mobupps.net` and ends up on the canonical domain, which is what the
ROADMAP's canonical-address rule wants anyway.

**H1 removed the gateway dependency this section used to carry.** The earlier warning here
— *"depends on the gateway forwarding `x-forwarded-host`; if it forwards the app's own
hostname instead, the console needs THAT URI too"* — was correct and was never checked
against the running gateway. It is what happened: the gateway forwards to the `.replit.app`
deployment, Replit's edge set `x-forwarded-host` to the deployment host, the app derived
`https://ad-library-finder.replit.app/leadfinder/api/auth/google/callback`, and Google
answered `redirect_uri_mismatch` for everyone. The derivation no longer reads any header,
so the dependency is gone. The one-request confirmation is unchanged and still worth
running after every publish: `GET /leadfinder/api/auth/google/debug` reports both the
derived URI and the real `forwardedHost`.

**No other external registration exists.** Every other outbound service is call-out-only
and holds no address of ours — see the outbound analysis in the Bundle 1 ledger entry.

---

## Ledger

*Append-only. One entry per bundle, with full Standing Bundle Ritual results.*

<!-- ledger entries appended below this line -->

### Leadfinder Bundle 1 — URL centralization ☑ DONE (2026-08-01)

Branch `bundle-1-url-centralization`. Commits `76ab08f`, `e67bd06`, `c50fc24`.

**0. Lineage check (Git safety rule 1) — FAILED FIRST, then corrected**

`main` was at `9cd17f3` (2026-07-23). Two branches shared an identical newer tree
`dc07c90` (2026-07-29): `replit-agent` `18fc536` and `store-first-discovery-longtail`
`d3dfaeb`. `main` was a **strict ancestor** of both — 89 commits / 57 files /
+14,535 −588 behind, including whole subsystems (`storeDiscoveryPipeline`,
`publisherRollup`, `appleSource`, `playSource`, `storeConfirm`, `NewJobForm`,
`Publishers`) and modified versions of every file this bundle touches
(`notifier.ts`, `routes-jobs.ts`, `api/client.ts`, `auth.ts`).

Work was **halted and reported** rather than started on the stale tree. Michael chose
fast-forward. `main` fast-forwarded to `18fc536` — a clean FF, no rewrite, no
force-push; the old tip `9cd17f3` already survives under `snapshot-2026-07-30`.

Also noted: **`snapshot-2026-07-30` has the same tree as the old `main`** — the Phase 0
snapshot for this repo captured the 07-23 tree, not the 07-29 work it is named for.

**1. Blast radius** — 10 files (2 new). Server: `urls.ts` (new), `notifier.ts`,
`oauth.ts`, `routes-auth.ts`, `auth.ts`, `index.ts`. Client: `config.ts` (new),
`api/client.ts`, `App.tsx`. Plus this file. Worst realistic failure: a cookie-helper
bug invalidating every live session mid-job. Rollback: revert the commits; no env var,
DB or deploy dependency. Not touched: `source-code/` mirror (and `sync-source-code.sh`
never run), `vite.config.ts`, `.replit`, DB, scrapers, queue.

**2. Implementation** — one config module per language present. **TypeScript only; there
is no Python side** (the only `.py` files in the tree are inside vscode-server's
`node_modules`). `BASE_PATH` defaults to `/`, `PUBLIC_URL` to
`(process.env.PUBLIC_BASE_URL || '').replace(/\/$/,'')` — the exact inline expression
that was there before. Client prefix comes from Vite's `import.meta.env.BASE_URL`,
which is `/` because `vite.config.ts` sets no `base`.

Routed through it: 3 emailed-link helpers, the OAuth redirect URI (both the
header-derived and the `PUBLIC_URL`-fallback branch), the post-login redirect, the
`Set-Cookie`/clear-cookie `Path` and cookie name, the "Back to login" href, 6 route
mounts, the static mount, all 21 SPA API paths, and 2 sign-in hrefs.

**3. Gates** — all green, and green *before* the bundle too (baseline captured first).

| Gate | Command | Before | After |
|---|---|---|---|
| typecheck + build | `pnpm build` (`tsc -b` + `vite build`; `tsc -p`) | pass | pass |
| tests | `pnpm --filter api-server test` | 29 modules, 715 assertions | 30 modules, **823** assertions, 0 failed |

No pre-existing gate failures; nothing to prove predates the bundle.

**4. Godlike audit — closed on two consecutive clean rounds**

*Round 1 — 2 findings, both security, both confirmed by probing the built module:*
- BASE_PATH accepted `/a'onmouseover=alert(1)`, `/a%00b`, `/a@b`, `/a:b`, `/a;b`. The
  WHATWG-URL oracle percent-encodes `"` and `<>` (already refused) but leaves `'`
  intact, and `basePath('/')` is interpolated into an HTML attribute in `auth.ts` —
  safety rested on that one sink using double quotes. **Fixed:** segment allowlist.
- PUBLIC_BASE_URL accepted userinfo. `https://good.com@evil.com` reads as good.com and
  resolves to origin **evil.com**, which would aim every emailed download link at the
  attacker. **Fixed:** userinfo refused.

*Round 2 — clean.* Re-probed 16 hostile BASE_PATH and 10 hostile PUBLIC_URL shapes: all
dangerous forms refused, all legitimate forms preserved. Equivalence re-verified.
*Round 3 — clean.* No `fetch`/XHR bypasses `api/client.ts`; no rooted `href`/`window.open`
in the SPA; every UI download link goes through `api.csvUrl`/`hqZipUrl`/`publishersCsvUrl`;
no own-address literal remains anywhere in `src`.

Security framing used **`new URL()` as the oracle, never string-shape checks**. Confirmed:
no helper can emit a protocol-relative URL (`//`, `///`, `\\`, `/\` all refused on both
vars); no open redirect is reachable through a hostile `BASE_PATH` or `PUBLIC_URL`
(dot-segment and backslash forms refused; the only two `res.redirect` calls are
`basePath('/')` and Google's own authorize URL, neither operator-influenced); and **no
download token can leak into a redirect target because no download token exists** —
downloads authenticate by session cookie plus `canReadJob`, with no secret in the URL.

**5. Equivalence proof (zero behaviour change)**

Differential harness comparing the new module against the old inline expressions
copied verbatim: **28 checks identical across 4 env permutations** (unset; production-shaped
`PUBLIC_BASE_URL`; trailing-slash variant; explicit `BASE_PATH=/`). The 21 client path
literals diff clean against `HEAD`.

**6. Smoke — pre-bundle vs post-bundle, byte-for-byte**

A `git worktree` at the pre-bundle commit `18fc536` was built and driven through the
**same** 17-probe harness, then diffed against the Bundle-1 run. **The only differing
line was the harness's own port banner (3952 vs 3953). Every probe response was
identical.** Endpoint list and results are recorded below as the Bundle 2 baseline.

Safety held: the app was **not** booted via `dist/index.js` (that calls `startQueue()`,
which dispatches real scrapers). The harness assembles the same Express app from the
same routers minus `startQueue()`, runs from a throwaway cwd so `db.ts`'s
`path.resolve('data')` makes a fresh sqlite file, and binds `127.0.0.1` on ports
3952/3953 — outside `.replit`'s mapped set. **Real database md5 identical before and
after. No scraping. No email dispatched. The running workflow was never touched.**

**7. Auto-fix** — both in-scope findings fixed and re-audited. Eight out-of-scope
findings recorded as O-1..O-8 above and left untouched.

---

### Leadfinder Bundle 2 — base-path switch ☑ DONE (2026-08-01)

Branch `bundle-2-base-path`. Ships **inactive**: with `BASE_PATH` unset nothing below
changes, proved byte-for-byte against the Bundle-1 baseline.

**0. Lineage check (Git safety rule 1) — PASS.** `main` `161b80e` (2026-08-01) is the
newest lineage and is a descendant of every other local branch: `replit-agent`
`18fc536`, `store-first-discovery-longtail` `d3dfaeb`, `snapshot-2026-07-30` `9cd17f3`,
`claude/google-ad-transparency-scraper-tzi7js` `fdd5b27`, `bundle-1-url-centralization`
`161b80e` (identical). `origin/main` is level with `main` — Bundle 1 did reach GitHub.
Branch cut from `main`.

**1. Blast radius (recorded before the first edit)**

*Files to be touched — 5 code + 2 docs:*

| File | Change |
|---|---|
| `artifacts/dashboard/vite.config.ts` | set `base` from `BASE_PATH`, validated through the existing `normalizeBase` in `src/config.ts` so an invalid value fails the build instead of being stamped into asset URLs |
| `artifacts/api-server/src/urls.ts` | per-app cookie name when prefixed; pure `bareBasePathRedirect()` and `spaFallback()` decisions; **fix `buildPublicUrl` composition** (see below); prefix/PUBLIC_URL agreement check; new unit assertions |
| `artifacts/api-server/src/index.ts` | bare-prefix redirect middleware; static mount at the prefix; prefix-scoped SPA catch-all |
| `.env.example` | document `BASE_PATH` and the `PUBLIC_BASE_URL` naming trap |
| `TODO.md` | this entry |

*Not touched:* `db.ts`, every scraper and pipeline, `queue.ts`, `routes-jobs.ts`,
`notifier.ts`, `oauth.ts` (the redirect-URI **derivation** is deliberately unchanged),
`auth.ts` (it already re-exports the cookie name and Path from `urls.ts`), the
`source-code/` mirror, `.replit`, the database, Replit Secrets.

*Behaviours affected:* built asset URLs; the six route mounts + static mount; the SPA
catch-all's scope; the session cookie's **name and Path**; the composition of emailed
links; the path half of the OAuth redirect URI. **All six are inert while `BASE_PATH`
is unset or `/`.**

*Worst realistic failure, in order:*
1. **Emailed-link composition.** Bundle 1 defined `publicUrl(p) = PUBLIC_URL + prefix + p`.
   The cutover sets `PUBLIC_URL=https://tools.mobupps.net/leadfinder`, which **already
   contains the prefix** — so that formula emits `…/leadfinder/leadfinder/api/…` and
   every result link ever emailed after cutover 404s. Must be fixed in this bundle.
   Same defect on the `PUBLIC_URL` fallback branch of the OAuth redirect URI.
2. **Cookie name/Path drift.** If `Set-Cookie` and the clear-cookie disagree on either
   name or Path, logout stops clearing the session and the user cannot sign out.
3. **A self-redirect at the bare prefix.** Registering a route *at* `/leadfinder` makes
   Express's non-strict routing match `/leadfinder/` too, redirecting it to itself and
   taking the main page down. Three sibling apps hit this. Structurally prevented here
   by an exact `req.path === BASE_PATH` compare in plain middleware.
4. **Dark-mode drift** in the SPA catch-all, which today answers *every* path.

*Rollback:* two independent levers. (a) Leave both env vars unset — every change is
inert by construction. (b) `git revert` the bundle commits. No DB migration, no deploy
dependency, no secret change.

*Cutover note (not a defect):* renaming the cookie to `lf_session` **logs every user
out exactly once**, at cutover, inside the announced downtime window. Old `als_session`
cookies are left behind at `Path=/` on the old origin and expire on their own.

**2. Implementation** — the blast radius held exactly: 5 code files, 2 docs, nothing else.

| Surface | Unprefixed (today) | Prefixed |
|---|---|---|
| Built asset URLs | `/assets/…` | `/leadfinder/assets/…` (Vite `base`) |
| API + static mounts | `/api/…`, `/` | `/leadfinder/api/…`, `/leadfinder` |
| SPA fallback | `app.get('*')`, unchanged | `app.use(BASE_PATH, …)`, scoped |
| Bare prefix | n/a — middleware not registered | `302` → `/leadfinder/` |
| Session cookie | `als_session; Path=/` | `lf_session; Path=/leadfinder/` |
| Emailed links | `PUBLIC_URL + path` | `PUBLIC_URL + path` (PUBLIC_URL carries the prefix) |
| OAuth callback | `<host>/api/auth/google/callback` | `<host>/leadfinder/api/auth/google/callback` |

Three decisions worth their own line:

- **The two arms of the SPA fallback are separate branches on purpose.** Unprefixed, this
  app answers `index.html` on *every* path including missing assets, and the darkness rule
  makes that the contract. Only the prefixed arm gets the honest 404. Darkness is therefore
  structural — the new code is not *registered* when `BASE_PATH` is unset — rather than a
  claim that two code paths happen to agree.
- **The bare-prefix redirect is plain middleware doing `req.path === BASE_PATH`.** A route
  registered at the bare prefix would also match the trailing-slash form (Express routing is
  non-strict) and redirect it to itself. `bare(prefix, bare(prefix, x))` is `null` for every
  `x`, so a second hop cannot exist — asserted in the unit suite and over real HTTP.
- **`app.use(BASE_PATH, …)`, never `app.get(BASE_PATH + '/*')`.** This repo runs Express
  **4.22.2**, where both work; Express 5 rejects the wildcard string at registration. Mount
  matching is stable across both. (The unprefixed arm still carries the old `app.get('*')` —
  see O-13.)

**3. Gates** — all green.

| Gate | Command | Before | After |
|---|---|---|---|
| typecheck + build | `pnpm build` | pass | pass |
| tests | `pnpm --filter api-server test` | 30 modules, 921 assertions | 30 modules, **927** assertions, 0 failed |
| `urls` unit suite | (inside the above) | 206 | **212** assertions |

`dist/index.html` is md5-identical (`d004b92d…`, 702 B) to the pre-bundle build with
`BASE_PATH` unset — the frontend change is provably inert.

New unit assertions pin: path joining in both modes; PUBLIC_URL/BASE_PATH composition
(the prefix appears exactly once); the boot refusal matrix; cookie naming and scoping
including an **RFC 6265 §5.1.4 path-match oracle** (the cookie reaches every prefixed
path we serve, and is never sent to the gateway root, a sibling tool, or a
prefix-lookalike); the bare-prefix redirect in **both** modes including the anti-loop and
one-hop properties; and the SPA fallback decision table.

**4. Godlike audit — closed on a clean round (5 rounds)**

*Round 1 — 1 finding, security, confirmed by probe.* `PUBLIC_BASE_URL=https://tools.mobupps.net%40evil.com/leadfinder`
passed validation. It does **not** reach `evil.com` — the WHATWG host parser percent-decodes
`%40` to `@`, a forbidden domain code point, and refuses the URL outright, which is exactly
why it slipped through: `new URL()` threw, so the validator filed it as a harmless *relative*
value. Impact is not origin theft but silence: every emailed link would go out unopenable.
**Fixed:** while prefixed, `PUBLIC_BASE_URL` must be an absolute http(s) URL — behind a
gateway there is no legitimate relative public base. Unprefixed behaviour is untouched, so
today's deploy cannot start failing whatever the secret holds.

*Round 2 — 1 finding, operational.* Nothing detected a **dist built without the prefix being
served with one** — the single most likely cutover mistake, and its symptom is a blank page
for every user with nothing in the logs. **Fixed:** at boot, while prefixed only, the served
`index.html` is scanned for rooted asset refs outside the mount and the mismatch is named in
the log. Proved by a negative test: a LIT server over the DARK dist trips the detector and
404s both assets.

Also tightened in this round: the PUBLIC_URL↔BASE_PATH agreement check moved from `endsWith`
to **exact equality**, because `endsWith` waved through the mirror-image mistake
(`…/leadfinder/leadfinder`) that the check exists to stop.

*Round 3 — clean.* Verified by probe rather than by reading: Express really does strip the
mount before the fallback sees `req.path` (the dotted-API-path discriminator), the API mount
wins over the catch-all, `POST` to a non-route is not swallowed, `HEAD` matches `GET`, and
seven raw-socket traversal attempts (`..`, `%2e%2e`, `..%2f`, `..%5c`) disclose nothing.

*Round 4 — 1 finding, documentation.* The `assertPublicUrlCarriesPrefix` doc still described
`endsWith` after round 2 changed it to equality. Fixed.

*Round 5 — clean.* Full re-run: 927 unit assertions, 317 security assertions, 14/14 boot
cases, 112 client-config assertions, 40/40 DARK checks, 60/60 LIT checks.

**Security framing — `new URL()` as the oracle throughout, never a string-shape check.**
Bundle 2 hands `BASE_PATH` four sinks Bundle 1 did not have (a `Location` header, a
`Set-Cookie` `Path`, an Express mount string, and — through Vite — an `src`/`href` attribute
in every built page), so both Bundle-1 fixes were re-proved with the prefix **active**:

- **No `BASE_PATH` value can break out of an HTML attribute.** 47 hostile shapes refused,
  including RTL-override and zero-width-space homographs. Every value the allowlist *does*
  accept was then pushed through all four sinks and asserted inert: no attribute-breaking
  character, no `CR`/`LF` in a `Location`, no `;`/`,` in a cookie `Path`, no route-pattern
  metacharacter in a mount string. What JS `trim()` silently eats (trailing space, NBSP) is
  now pinned rather than assumed.
- **No `PUBLIC_URL` with userinfo can redirect emailed links to another origin.** Userinfo,
  protocol-relative, backslash, non-http(s), query/fragment and control-character forms all
  refused on the real boot path (`normalizePublicUrl` → `assertPublicUrlCarriesPrefix`), and
  every accepted value oracle-checked to stay on its own origin under every path we emit.
- **The renamed cookie is never scoped wider than `BASE_PATH`.** `Path` is
  `joinBasePath(prefix, '/')` = `/leadfinder/`, asserted `startsWith(prefix)` and `!== '/'`
  for every legal prefix, plus the RFC 6265 path-match oracle above. Flags unchanged:
  `HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`.
- **Boot refuses 8 misconfigurations and accepts 6 legitimate ones**, 14/14 as specified —
  including the cutover pair, and including every unprefixed shape today's production could
  possibly be in.

**5. Smoke — two runs, both required, both green**

Same safety envelope as Bundle 1: the harness assembles the same Express app from the same
routers **without `startQueue()`**, so no scraper is dispatched and no email is sent; it runs
from a throwaway cwd so `db.ts`'s `path.resolve('data')` makes a fresh sqlite file; it binds
`127.0.0.1` on ports 3954/3955/3956, outside `.replit`'s mapped set. **Real database md5
`e689c6fc…` identical before and after every run. The running workflow was never touched
(none was running). No secret was written — the LIT env existed only for the child process.**

*a. DARK (both env vars unset) — 40/40 checks, and the 17-probe endpoint table is
**byte-for-byte identical** to the baseline recorded in the Bundle 1 ledger.* Same md5,
`diff` clean, including `Set-Cookie=als_session=<TOK>; Path=/` and both 702-byte SPA
responses.

*b. LIT (`BASE_PATH=/leadfinder/`, `PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`) —
60/60 checks:*

| Requirement | Result |
|---|---|
| main page at `/leadfinder/` | 200, 724 B |
| deep links hard-load | `/leadfinder/some/deep/link`, `/leadfinder/jobs/deep/link` → 200 html |
| zero asset 404s | every `src`/`href` in the served `index.html` → 200, all under the prefix |
| a missing asset 404s | `/leadfinder/assets/definitely-not-here.js` → **404**, not 200 index.html |
| API under the prefix | all 17 probes 200/401 as specified at `/leadfinder/api/…` |
| bare prefix | `/leadfinder` → **302** `Location: /leadfinder/`; query preserved (`?a=1&b=2`) |
| …and no loop | `/leadfinder/` → **200**, not another 302; chain-followed: **exactly 1 hop** |
| session cookie | `lf_session=…; Path=/leadfinder/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`; clear-cookie matches on name **and** Path |
| download authenticates and serves | `/leadfinder/api/jobs/<id>/csv` + cookie → 200 with the file bytes and `Content-Disposition`; anonymous → 401; **no token in the URL** |
| polling endpoints | job detail and job list under the prefix; counter 7→41, bar 12→63, step log 1→2 rows **across successive polls** |
| OAuth redirect URI | exactly one prefix, for both gateway hosts (recorded above) |
| nothing outside the mount | `/api/health`, `/`, `/some/deep/link`, `/assets/index.js` → 404 |

A **long-running job's progress was simulated by moving the durable row** (`setJobPhase`,
`setJobLeadsFound`, `setJobProgress`, `appendLog`) and re-polling through the prefixed
endpoints — the same columns a real pipeline writes — because the queue is deliberately not
started. What is proved is the transport under the prefix, not the scraper.

*Emailed links* were verified through `publicUrl()` directly rather than by sending: the
three private helpers in `notifier.ts` are one-line wrappers over it. All three resolve to
`https://tools.mobupps.net/leadfinder/…`, one prefix, our origin.

**Two behaviour deltas under the prefix, both deliberate, both recorded:**
1. A missing asset returns 404 instead of 200 `index.html`. That is the requirement.
2. `OPTIONS` on a non-route returns 404 (prefixed) vs 200 `Allow: GET,HEAD` (unprefixed) —
   Express answers `OPTIONS` from its route table, and the two fallback arms register
   differently. Same-origin requests never preflight and nothing in the SPA or the gateway
   sends `OPTIONS`, so this is inert; noted so it is a known property, not a surprise.

**6. Client half, proved on the real module.** `dashboard/src/config.ts` was compiled the way
Vite compiles it (base defined in) and executed for both bases: all **21** SPA paths are the
identity at `/`, all correctly prefixed at `/leadfinder/`, none double-prefixed or
protocol-relative, and five hostile bases throw at module load.

**An invalid `BASE_PATH` fails the build, loudly, before anything is written.** Confirmed
explicitly: `BASE_PATH="/a'onmouseover=alert(1)"` exits 1 with
`BasePathError: base segment … is not alphanumeric with . _ - inside` at config-load, no
output directory is created, and the existing `dist` is md5-unchanged. Same for `//evil.com`
and `/leadfinder/../evil`.

**7. `artifact.toml` — re-confirmed absent.** `find` over the repo (excluding `node_modules`)
returns **0** files. No routing table, health path or build pin to change. `.replit` carries
the deployment config, and this bundle did not touch it (but see O-9).

**8. Auto-fix** — both in-scope findings fixed and re-audited; O-7 (SPA catch-all under the
prefix) is **closed by this bundle** and removed from Open items. Six new out-of-scope items
recorded as O-9…O-14 and left untouched.

---

### Leadfinder Verification order V1 — independent re-verification of Bundle 2 ☑ DONE (2026-08-01)

Branch `bundle-2-verification-v1`. Ordered after the Bundle-2 session was cut off, to
establish what had actually completed and close the ritual. **Nothing was re-implemented.**

**0. What the cut-off session had actually left behind**

The premise of the order was that the Bundle 2 ledger entry was missing. It is **not** —
`9b3dedd` committed it along with the code (`TODO.md +259`), and `main`, `origin/main` and
`bundle-2-base-path` are all level at `9b3dedd`. Bundle 2 was committed, merged and pushed
**with** its ledger entry. Nothing was missing; the entry above is the Bundle-2 session's own.

So V1 became what it should be: verify that entry's claims independently rather than trust
them. Every load-bearing claim was **re-derived from the artefacts, not read**:

| Claim in the Bundle 2 entry | Re-derived independently | Verdict |
|---|---|---|
| blast radius held: 5 code + 2 docs | `git diff --stat 161b80e..9b3dedd` = exactly those 5 files | ✅ |
| `pnpm build` passes | re-run | ✅ |
| 30 modules, 927 assertions | re-run: 30 modules, **927**, 0 failed | ✅ exact |
| `urls` suite 212 assertions | re-run: **212** | ✅ exact |
| `dist/index.html` md5 `d004b92d…`, 702 B | `d004b92db95a913e6dfda70e7d3d9460`, 702 B | ✅ exact |
| real DB md5 `e689c6fc…` untouched | `e689c6fc55e6276acf296f7e9bada157` before and after every V1 run | ✅ exact |
| Express is 4.22.2 (the `app.get(prefix+'/*')` argument) | `4.22.2` | ✅ |
| DARK is byte-identical to the 17-probe baseline | rebuilt the harness from scratch, re-ran, `diff` clean | ✅ md5 `0b9f472c…` both sides |
| LIT main page 724 B | 724 B | ✅ |
| OAuth URIs for both gateway hosts | re-derived through `/api/auth/google/debug` | ✅ character-identical |

One inaccuracy, cosmetic: O-5 cites `scripts/check-lead-mirror.mjs`; the file is at
`artifacts/api-server/scripts/check-lead-mirror.mjs`. The item itself stands.

**1. Scope of the Bundle 2 work order, item by item** — ROADMAP §"per-app migration cycle"
step 4, plus the order's named surfaces. All delivered; evidence is V1's own, not the entry's.

| Work-order item | Delivered | Proof |
|---|---|---|
| config becomes switchable | `IS_PREFIXED` + guarded exports in `urls.ts`; Vite `base` from `BASE_PATH` | boot matrix 14/14; DARK↔LIT both boot to spec |
| per-app session cookie **name** | `als_session` → `lf_session`, only while prefixed | `Set-Cookie` observed over HTTP in both modes |
| cookie **scoping** | `Path=/` → `Path=/leadfinder/`; clear-cookie agrees on name **and** Path | RFC 6265 §5.1.4 oracle + live logout probe |
| SPA catch-all under prefix | `app.use(BASE_PATH, …)`, honest 404 for missing assets; unprefixed arm untouched | missing asset → 404; deep link → 200; DARK still 200 everywhere |
| prefix-aware / bare-prefix redirect | `/leadfinder` → 302 `/leadfinder/`, query preserved, exactly one hop | chain-followed; `bare(p, bare(p, x)) === null`; POST/HEAD too |
| downloads | CSV **and** hq-zip authenticate and serve real bytes under the prefix | 200 + exact bytes + `Content-Disposition`; anonymous → 401 both |
| polling endpoints | job detail **and** job list under the prefix | durable row moved between polls: leads 0→7→41, bar 0→12→63, log 0→1→2 |
| ships inactive | every switch structurally unregistered while unset | DARK table byte-identical to the pre-Bundle-1 baseline |

**2. Gates** — all green. `pnpm build` pass. Tests **994** assertions across 30 modules
(was 927; the V1 fix below adds 67, `urls` 212 → **279**), 0 failed.

**3. Godlike audit — 4 rounds, closed on a fully clean one**

*Round 1 — 1 finding, security/operational, confirmed by probe and then end to end over HTTP.*
`PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder//` (a **doubled trailing slash**) was
**accepted at boot** while prefixed. `normalizePublicUrl` strips exactly one trailing slash, so
the value reached `assertPublicUrlCarriesPrefix` as `…/leadfinder/`; that check compared
`parsed.pathname.replace(/\/+$/, '')`, forgiving a trailing slash the concatenation in
`buildPublicUrl` does **not** forgive. Every emitted absolute URL then read
`https://tools.mobupps.net/leadfinder//api/jobs/<id>/csv`.

Its failure shape is the bad one. Proved over real HTTP:

```
GET /leadfinder//api/jobs/job_abc/csv  -> 200 text/html 724B   <-- the SPA page
GET /leadfinder/api/jobs/job_abc/csv   -> 401 application/json <-- the real endpoint
```

`//api/…` matches no mount, so the prefixed SPA fallback answers it with `200 index.html`:
the user clicks **Download CSV** in their inbox and gets the app page. No 404, nothing in the
logs, and `requireAuth` never runs. The same defect hit the `PUBLIC_URL` fallback branch of
the OAuth redirect URI. This is exactly the class `assertPublicUrlCarriesPrefix` exists to
stop, and its own doc comment already claimed "path is not EXACTLY the prefix" — the code
simply did not match the doc.

**Fixed:** compare `parsed.pathname !== prefix` — the string that will actually be
concatenated, with no tidying. Prefixed-only by construction (the function returns early when
`prefix === ''`), so **DARK cannot change**, and the DARK byte-identity gate was re-run
afterwards to prove it rather than assert it. Legitimate operator input is unaffected: a single
trailing slash is still stripped by `normalizePublicUrl` before the check sees it. Also refused
now: `…/leadfinder/.` and any other path that normalises to the mount but composes past it.

*Round 2 — 0 product findings.* Env/unit framing 233/233. HTTP framing raised one alarm that
did **not** survive inspection: a percent-encoded `%0d%0a` in the bare-prefix redirect's query.
Dumping the raw socket response showed the text appearing only *inside* the `Location` value,
still encoded, with no injected header line — the alarm was the audit's own regex reading its
own `Location` header. Corrected the check, not the product. A raw `CR` in the request target
never reaches Express: the HTTP layer rejects the request.

*Round 3 — clean, on four angles the earlier rounds never touched:*
- **Negative test:** a LIT server over the **DARK** dist — the likeliest cutover mistake. The
  boot detector names both stray assets (`/assets/index-*.js`, `/assets/index-*.css`).
- **Build refusal:** `BASE_PATH="/a'onmouseover=alert(1)"`, `//evil.com`, `/leadfinder/../evil`
  and `/a b` each exit **1** with `BasePathError` at Vite config-load; **no output directory is
  created** and the existing `dist` is md5-unchanged.
- **Client half on the real module:** `dashboard/src/config.ts` compiled and executed with the
  base substituted the way Vite's `define` substitutes it — **22/22** SPA paths are the identity
  at `/`, all correctly prefixed at `/leadfinder/`, none doubled or protocol-relative; five
  hostile bases throw `BasePathError` at module load.
- **Bypass sweep:** no `fetch(` outside `api/client.ts`, no rooted `href`/`window.open` in the
  SPA, no `/api/` literal outside `config.ts`/`client.ts`, no own-address literal anywhere in
  either `src` tree.

*Round 4 — fully clean.* Everything re-run in one pass after the fix: build ✓, 994 assertions ✓,
env/unit audit 233/0, HTTP audit LIT 19/0 and DARK 17/0, DARK smoke 33/0 **byte-identical**,
LIT smoke 90/0.

**Bundle 1's two fixes re-proved under the SWITCHED state** (the order's specific ask), with
`new URL()` as the oracle throughout and boot refusals probed in **real child processes**,
because module-load side effects are the thing under test:

- **Fix 1 — the BASE_PATH segment allowlist holds.** 50 hostile shapes refused at boot with
  the prefix active, including protocol-relative and backslash authorities, dot segments,
  absolute URLs, control characters, quote/angle-bracket/`@`/`:`/`;` forms, and the invisible
  ones — NBSP, zero-width space, RTL override, BOM. (A NUL byte cannot reach a real env at all —
  `execve` refuses it — so that one is asserted against the validator directly and said so.)
  Every value the allowlist *does* accept was then pushed through all **four** sinks Bundle 2
  added and asserted inert: no `CR`/`LF` in a `Location`, no `;`/`,`/whitespace in a cookie
  `Path`, no route metacharacter (`:*?+()[]{}`) in a mount string, no attribute-breaking or
  invisible character in the HTML-attribute sink.
- **Fix 2 — PUBLIC_URL cannot borrow an origin.** 16 hostile values refused on the real boot
  path while prefixed (userinfo, `user:pass@`, protocol-relative, backslash, non-http(s),
  query/fragment, control characters, percent-encoded `@`, dot-escape, and now the doubled
  slash), and the four Bundle-1 shapes re-checked **unprefixed** so the original fix is proved
  not to have regressed. Every accepted pair was oracle-checked: emitted links stay on their own
  origin, carry the prefix exactly once, and contain no doubled slash.

**4. Smokes — both re-run with a harness rebuilt from scratch** (the Bundle-2 session's
scratchpad is gone). Same envelope as Bundle 1: the app is assembled from the **same compiled
routers minus `startQueue()`** — so no scraper is dispatched and no email is sent — plus minus
`prepareStableLibraryClosure()` (a Chromium library snapshot, not a routing concern). Each run
uses **its own throwaway cwd**, so `db.ts`'s module-level `path.resolve('data')` makes a fresh
sqlite file, and binds `127.0.0.1` on **separate ports** (3962 DARK / 3963 LIT; audits on
3965/3966/3968). **Real DB md5 `e689c6fc…` identical before and after every run; real
`dist/index.html` md5 `d004b92d…` unchanged; no secret written — the LIT env existed only for
the child process; no workflow was running and none was touched.**

*a. DARK (`BASE_PATH` and `PUBLIC_BASE_URL` both unset) — 33/33 checks, and the 17-probe table
is **byte-for-byte identical** to the baseline recorded in the Bundle 1 ledger.* `diff` clean,
md5 `0b9f472cd1fcb63fb9c93396cc198b06` on both sides, including
`Set-Cookie=als_session=<TOK>; Path=/` and both 702-byte SPA responses. Re-run **again** after
the round-1 fix landed, still byte-identical. *(One redaction note for whoever diffs this next:
`<TOK>` on the logout line is the redactor rewriting `als_session=[^;]*`; the real cleared value
is empty. The baseline was recorded with the same rule, which is why the two match.)*

*b. LIT (`BASE_PATH=/leadfinder/`, `PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`,
set for the child process only) — 90/90 checks.* `BASE_PATH` was given **with** its trailing
slash on purpose, to exercise the normalisation on the way in. Everything in the Bundle-2
entry's LIT table reproduced, plus: hq-zip download bytes and `Content-Disposition`, anonymous
hq-zip → 401, hostile-query redirects (4 shapes, all staying same-origin at exactly the mount),
prefix-lookalike paths (`/leadfinderX`, `/leadfinder2/`) not swallowed, `POST`/`PUT`/`DELETE`/
`PATCH` to a non-route → 404, and 7 traversal attempts disclosing nothing.

**5. The OAuth redirect URI under LIT, character for character** — re-derived by replaying the
real sink (`getRedirectUriFromReq` via `/leadfinder/api/auth/google/debug`) with the gateway's
forwarded headers, not composed by hand. Identical to what the Bundle 2 entry recorded:

```
https://mobupps-tools-gateway.replit.app/leadfinder/api/auth/google/callback
https://tools.mobupps.net/leadfinder/api/auth/google/callback
```

The `PUBLIC_URL`-fallback branch (no `Host`, no `x-forwarded-host`) independently yields
`https://tools.mobupps.net/leadfinder/api/auth/google/callback` — the same string, which is the
property that matters, since the authorize step and the token exchange must agree.

**6. Auto-fix** — the one in-scope finding fixed and re-audited to a clean round. Its regression
gate lives in the suite, not just in this entry: `urls` gained 67 assertions pinning the doubled
slash, the dot-segment form, the real `normalizePublicUrl → assert → buildPublicUrl` pipeline,
and a **composition property** (every accepted public base composes to a pathname that is
exactly `prefix + path`, oracle-checked). One new out-of-scope item recorded as **O-15**; O-1
and O-9 updated with V1 evidence and left open.

---

### Leadfinder Pre-cutover order L2 — legacy address survival ☑ DONE (2026-08-02)

Branch `cutover-l2-legacy-addresses`. Ships **inactive**: every rule below is registered
only while `BASE_PATH` is set, so an env-unset rollback is byte-for-byte today's app.

**0. Lineage check (Git safety rule 1, directional form) — PASS.** The question is
*does another branch hold content main lacks?*, answered with `git diff <branch> main`
for all 8 local and 8 remote refs. Nothing does: every branch's diff against `main` is
content **main has and they lack**, or empty. `replit-agent` carries 2 commits `main`
lacks but an **identical tree** (`f791d8d7…` on both), so no content. `main` is 2 commits
ahead of `origin/main`; both are platform *"Published your App"* commits and together
they are the `.replit` port-block deletion of **O-9** — the platform has now committed
it, which closes that item's "uncommitted, operator's call" state. Branch cut from `main`.

**1. Blast radius (recorded before the first edit)**

*Files to be touched — 6 code + 2 docs:*

| File | Change |
|---|---|
| `artifacts/api-server/src/urls.ts` | pure `legacyRedirect()` decision + `LEGACY_REDIRECT_STATUS = 307`; new unit assertions |
| `artifacts/api-server/src/app.ts` | **new.** `buildApp()` — the Express assembly moved out of `index.ts` verbatim, so the gate and the smoke boot the **real** app rather than a copy; the legacy layer registered here |
| `artifacts/api-server/src/index.ts` | `main()` calls `buildApp()`; assembly removed |
| `artifacts/dashboard/src/main.tsx` | client-side redirect to the mount, before the router mounts |
| `artifacts/api-server/scripts/check-legacy-redirects.mjs` | **new.** standalone boot gate pinning 307 / method / loop / no-open-redirect |
| `artifacts/api-server/scripts/run-tests.mjs` | run the new gate |
| `TODO.md` | this entry |
| `ROADMAP.md` | Git safety rule 1 → directional form (documentation only) |

*Not touched:* `notifier.ts` (the emailed link shapes do **not** change), `oauth.ts`,
`auth.ts`, `routes-*.ts`, `db.ts`, `queue.ts`, every scraper and pipeline, the
`source-code/` mirror, `.replit`, the database, Replit Secrets.

*Behaviours affected — all prefixed-only except where noted:*
1. `GET /` → **307** `<prefix>/` (was 404 while prefixed).
2. `/api/jobs/:id/csv` and `/api/jobs/:id/hq-zip` → **307** to the same path under the
   prefix, query preserved, method preserved (was 404).
3. `/api/health` and `/version` gain a **first-class legacy mount** — machine callers,
   so a real mount rather than a redirect.
4. The bare-prefix redirect changes **302 → 307**, aligning Bundle 2's one redirect with
   the ROADMAP convention this order enforces. LIT-only; the recorded LIT table changes
   on that one line and the change is called out in the smoke section.
5. The client bundle redirects to the mount if it is ever loaded outside it. Gated on the
   **build-time** base being non-`/`, so a dist built without `BASE_PATH` cannot fire it.

*Worst realistic failure, in order:*
1. **A redirect loop on an emailed link.** An old link 307s to a path that 307s again and
   the browser gives up — the exact failure the order exists to prevent. Structurally
   prevented: every legacy target is a path that no legacy rule matches, asserted as a
   property (`legacy(p, target) === null`) in the unit suite and chain-followed over HTTP.
2. **An open redirect.** The `Location` is derived from the request, so a crafted legacy
   path could aim at another origin and phish on our own domain. Prevented by building
   the target from fixed literals plus one non-slash segment, then oracle-checking
   (`new URL`) that it stays on this origin and under the mount before emitting it.
3. **The `buildApp()` extraction changing DARK behaviour.** Caught by the byte-identity
   gate against the recorded 17-probe baseline, which is now run against the real
   assembly rather than a replica.
4. **The client redirect firing while unprefixed** — an infinite reload for every user.
   The branch cannot be reached when the built base is `/`; pinned by a test.
5. **A legacy download answering `200 index.html`** instead of the file or a 401 — the
   doubled-slash defect V1 found, in a new place. Asserted explicitly for every legacy
   shape and every derived target.

*Rollback:* two independent levers, unchanged from Bundle 2. (a) Leave both env vars
unset — every rule here is unregistered by construction, and the client half is inert in
a dist built without the prefix. (b) `git revert` the bundle commits. No DB migration, no
deploy dependency, no secret change. **307 is deliberate precisely so a rollback works:**
308 and 301 are cacheable, so a cached entry would outlive the rollback and bounce
clients to a path that no longer exists.

**2. Inventory, taken before any code was written**

*a. Every URL shape this app has ever put in an outgoing email.* Three, across the whole
history of `notifier.ts` (`git log --all -p` on that file). No other module builds a link;
the only other sender, `POST /api/settings/test-email`, has no link in its body.

| Shape | Template | Source |
|---|---|---|
| Result CSV | `{PUBLIC_BASE_URL}/api/jobs/{jobId}/csv` | `notifier.ts:33` |
| HQ-split zip | `{PUBLIC_BASE_URL}/api/jobs/{jobId}/hq-zip` | `notifier.ts:37` |
| Job / report link | `{PUBLIC_BASE_URL}/#/jobs/{jobId}` | `notifier.ts:29` |

The third is a **fragment**, so the server only ever sees `GET /` — which is why the old
root is a legacy address in its own right. The CSV link may legitimately carry
`?product=cps|mobile`, so query preservation is not decorative.

*b. How many are live, and do they expire.* **They never expire.** The id is in the path,
there is no token and no TTL, and nothing deletes the CSV/zip files (no retention or
unlink path exists in the tree). Access is re-checked per request by session cookie +
`canReadJob`. The count still cannot be taken here: both workspace databases are dev
copies (`data/ad-library.sqlite` 0 jobs; `artifacts/api-server/data/…` 50 jobs, 33
`notification_status='failed'`, **0 sent**). **O-2 stands** — run
`SELECT COUNT(*) FROM jobs WHERE notification_status='sent';` on the Reserved VM. By the
app's shape it is one email per completed job over months of daily use, i.e. effectively
every completed job, not a handful.

*c. External callers at a fixed URL.* Two, and **no webhooks anywhere** (`grep` for
webhook / callback_url / notify_url over both `src` trees and `.env.example`: zero hits;
every other outbound integration is call-out-only and holds no address of ours):
the Google Cloud Console OAuth redirect URI, and the out-of-repo deploy-detect poller on
`/version` (O-11).

*d. Does Bundle 2 keep any unprefixed mount?* **No** — unlike the sibling app, where an
`/api` mount was deliberately left unprefixed. Every mount here resolves through
`basePath()`, including static and the SPA fallback. Probed rather than read, prefix
active, real DB md5 unchanged:

```
/api/jobs/<id>/csv 404   /api/jobs/<id>/hq-zip 404   /  404   /version 404
/api/health 404   /api/me 404   POST /api/jobs 404   /assets/index-*.js 404
/leadfinder/api/jobs/<id>/csv  200 text/csv (401 anonymous)   <- the prefixed control
/leadfinder//api/jobs/<id>/csv 200 text/html 702B             <- the V1 defect, reproduced
```

*What was NOT repaired, and why.* The **legacy OAuth callback**: a 307 would carry
`code`/`state` correctly, but the token exchange re-derives `redirect_uri` from the new
host+prefix and Google requires it to equal the authorize-step value, so a flow started
before the cutover cannot complete by any means — and the in-memory `state` store is
emptied by the republish regardless. In-flight only; the user retries and it works.
**Stale-tab `/api/*` calls** and **`/assets/*` from a cached shell** are likewise not
adopted: neither is an emailed or registered address, those sessions are already
invalidated by the `als_session`→`lf_session` rename, and asset filenames are
content-hashed per build. The legacy layer is therefore an **enumerated list, not a
catch-all** — a catch-all would give every endpoint a second name and would have to build
its `Location` from the raw request path, which is exactly how an open redirect happens.

**3. Implementation** — the blast radius held with **one deviation, recorded**:
`artifacts/dashboard/src/config.ts` was also touched (+28 lines), because audit round 3
found that the client redirect as first written could only be tested by re-asserting a
copy of its three lines. The decision moved into `config.ts` as `offMountRedirect()` so
the gate executes **the module that ships**. 7 code files, 2 docs.

| Surface | Before the prefix | Prefixed, before L2 | Prefixed, after L2 |
|---|---|---|---|
| `/` (old root, and where `/#/jobs/<id>` lands) | 200 SPA | **404** | **307** → `/leadfinder/` |
| `/api/jobs/<id>/csv` (emailed) | 200 file / 401 | **404** | **307** → prefixed, query intact |
| `/api/jobs/<id>/hq-zip` (emailed) | 200 file / 401 | **404** | **307** → prefixed |
| `/version`, `/api/health` (machine) | 200 | **404** | **200, first-class mount** |
| `/leadfinder` (bare prefix) | n/a | 302 | **307** |
| `/leadfinder//api/…` (empty segment) | n/a | **200 index.html** | **404** |
| everything else unprefixed | 200 SPA | 404 | 404, unchanged |

Four decisions worth their own line:

- **The redirect is registered before `userContextMiddleware` and before every
  `requireAuth` mount.** This is the cookie interaction the order called the centrepiece.
  Bundle 2 scopes the session cookie to `Path=/leadfinder/`, so by RFC 6265 §5.1.4 a
  browser does **not** send it to an unprefixed path: a legacy click is *always* anonymous
  as far as this app can see. A legacy layer sitting behind authentication would answer a
  months-old emailed link with 401 instead of moving it. The redirect needs no identity —
  it names a location, and the browser re-issues the request under the prefix **with** the
  cookie, where the real check runs unchanged. Verified in both directions, not assumed.
- **Machine callers get a real mount, not a redirect** (ROADMAP redirect convention 5).
  `/version` and `/api/health` are public, side-effect-free GETs, so serving them at two
  addresses costs nothing and no poller has to follow a 3xx.
- **The target is built from fixed literals plus one non-slash segment, then oracle-checked
  before it is emitted.** `legacyRedirect()` runs its own result through `new URL()` and
  refuses to emit anything that leaves the origin, leaves the mount, or contains an empty
  segment. That is what makes "no legacy path is an open redirect" a property rather than
  an argument.
- **The assembly moved into `app.ts`.** A gate that pins a status code against a
  hand-maintained copy of the app proves nothing about what ships — the copy is the thing
  that drifts. `buildApp()` has no side effects, so the gate and both smokes now boot the
  real thing; `index.ts` still owns the process (DB init, library closure, `startQueue()`,
  the listener) and is unchanged in behaviour.

**4. Gates** — all green.

| Gate | Command | Before | After |
|---|---|---|---|
| typecheck + build | `pnpm build` | pass | pass |
| tests | `pnpm --filter api-server test` | 30 modules, 994 | 30 modules, **1469**, 0 failed |
| `urls` unit suite | (inside the above) | 279 | **754** |
| standalone gates, run directly | `node scripts/check-*.mjs` | 3 | **4** (new: `check-legacy-redirects`) |
| new boot gate | `check-legacy-redirects.mjs` | — | **21 DARK + 212 LIT**, 0 failed |

The new gate **boots the real assembly in both modes**, in child processes with their own
throwaway cwd, and pins: the 307 (explicitly *not* 308/301/302) on every legacy shape and
every method; the query preserved byte-for-byte including hostile shapes; method
preservation proved by the *difference* at the far end (a GET serves the file, a POST
reaches a path with no POST route and 404s — a 302 would have made it a GET and served the
file); one hop; the anonymous end state; the open-redirect refusals; and the client half,
compiled the way Vite compiles it and executed. A future edit to 302 or 308 fails it.

**5. Godlike audit — 5 rounds, closed on a fully clean one**

*Round 1 — 1 product finding, in the LIT smoke.* `/leadfinder//api/jobs/<id>/csv` still
answered **200 index.html**: the exact V1 failure shape, at the sink rather than at its
source. The generative cause (a doubled slash in `PUBLIC_BASE_URL`) is refused at boot
since V1, and no legacy redirect can emit such a target — but "unreachable by argument" is
not the same as "safe by construction", and the order asked for the latter. **Fixed** in
`spaFallbackServesIndex`. The first attempt did not work, and why is worth recording:
**Express's mount strip consumes the empty segment** — `/leadfinder//api/jobs/x/csv`
arrives at the fallback with `req.path` = `/api/jobs/x/csv`, indistinguishable from an
ordinary unmatched API path. The raw target is the only place the shape survives, so the
fallback now takes it as a third argument. Proved by probe, not by reading.

*Round 2 — 0 product findings.* 4,763 oracle assertions: every accepted prefix × every
legacy input × every hostile query, checked with `new URL()` for origin, mount
containment, doubled slash, CR/LF, attribute-breaking characters and one-hop. One
**audit-own** check was wrong and was corrected, not the product: counting "the prefix
appears once" by substring also matches the `/a` inside `/api`. Replaced with a parser
check (`pathname === prefix + path`).

*Round 3 — 1 finding, testability.* The client redirect could only be verified by
re-asserting a copy of its three lines. Moved into `config.ts` as `offMountRedirect()` and
now executed by the gate on the compiled module. Also covered in this round, by probe:
a **LIT server over a DARK dist** (the likeliest cutover mistake — the boot detector names
both stray assets and stays silent over a matching dist); a **LIT dist over a LIT server**,
which is the real cutover configuration (main page 724 B, both assets 200 under the
prefix, a missing asset 404, the same asset unprefixed 404, and `location.replace` present
in the shipped bundle); and **build refusal** — `BASE_PATH="/a'onmouseover=alert(1)"`,
`//evil.com`, `/leadfinder/../evil` and `/a b` each exit non-zero with `BasePathError` at
Vite config-load, **no output directory is created**, and the real `dist` is md5-unchanged.

*Round 4 — clean.* Everything re-run in one pass: build ✓, 1,469 assertions ✓, gate 21/212
✓, audit 4,763/0 ✓, DARK smoke byte-identical ✓, LIT smoke 80/80 ✓.

*Round 5 — clean.* One interaction proved rather than reasoned: the **forbidden
"unset without republish" state** (ROADMAP cutover rule 3), i.e. a LIT dist served by a
DARK server. It is broken either way — that is why the rule exists — but the question was
whether the new client redirect turns it into a loop. It does not: **exactly one hop**,
settling at `/leadfinder/`, `offMountRedirect` then returning null. Measured, both halves.

**Security framing — `new URL()` as the oracle throughout, boot refusals in real child
processes.** L2 adds exactly one new sink for operator input: the `Location` header of the
legacy redirect. Both Bundle 1 fixes were re-proved against it with the prefix active:

- **Fix 1 — the BASE_PATH segment allowlist holds.** 44 hostile shapes refused (protocol-
  relative and backslash authorities, dot segments, absolute URLs, control characters,
  quote/angle/`@`/`:`/`;`/space forms, and the invisible ones — NBSP, zero-width space,
  RTL override, BOM), and every value the allowlist *does* accept was pushed through the
  new sink and asserted inert: no CR/LF, no attribute-breaking character, no backslash, not
  protocol-relative, same origin, under the mount, no doubled slash, one hop.
- **Fix 2 — PUBLIC_URL cannot borrow an origin.** 11 hostile values refused by the
  validator and 8 misconfigurations refused **at boot in real child processes** — including
  the doubled trailing slash V1 found, userinfo, percent-encoded `@`, missing prefix and
  double prefix — while all 6 legitimate shapes (including a nested prefix) boot. Every
  accepted pair oracle-checked: emitted links stay on our origin, carry the prefix exactly
  once, contain no doubled slash.
- **No legacy path is an open redirect.** Fuzzed across 8 accepted prefixes × 9 hostile
  legacy paths × 7 hostile queries, plus the same shapes over real HTTP. Every emitted
  `Location` resolved to this origin, under the mount; everything else was refused outright
  and fell through to the same 404 it gets today.

**6. Smokes — both modes, separate ports, real DB checksum verified either side**

Same envelope as Bundle 1/2/V1, with one improvement: the app is no longer *replicated* by
the harness, it is **assembled by the shipped `buildApp()`** — `startQueue()` is never
called, so no scraper runs and no email is sent; `prepareStableLibraryClosure()` is not
called either. Each run uses its own throwaway cwd, so `db.ts`'s module-level
`path.resolve('data')` makes a fresh sqlite file, and binds `127.0.0.1` on ports outside
`.replit`'s mapped set (3971–3987; `.replit` maps only 3001). **Real DB md5
`e689c6fc55e6276acf296f7e9bada157` identical before and after every run. No secret was
written — the LIT env existed only for the child process. No workflow was running and none
was touched. No scraping job was started and no email was dispatched.**

*a. DARK (`BASE_PATH` and `PUBLIC_BASE_URL` both unset) — the 17-probe table is
**byte-for-byte identical** to the baseline recorded in the Bundle 1 ledger*, md5
`0b9f472cd1fcb63fb9c93396cc198b06` on both sides, `diff` clean — including
`Set-Cookie=als_session=<TOK>; Path=/` and both 702-byte SPA responses. Run **three times**:
before any edit (which is what validates the rebuilt harness — it reproduced the recorded
md5 exactly, with no product change in the tree), after the code landed, and again in the
final clean round. The gate's own DARK arm additionally asserts that **no legacy path
redirects at all** while unset: the layer is absent, not merely agreeing with today.

*b. LIT (`BASE_PATH=/leadfinder/`, `PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`,
set together for the child process only) — 80/80, and again 80/80 over a LIT-built dist.*
`BASE_PATH` was given **with** its trailing slash on purpose, to exercise normalisation.

| Requirement from the order | Result |
|---|---|
| every legacy link shape reaches its handler | CSV, HQ-zip → 307 → prefixed handler; `/` → 307 → SPA; `/version`, `/api/health` → 200 mounts |
| old-style download, authenticated | one hop, **200 + the real file bytes** + `Content-Disposition: attachment; filename="leads_job_….csv"`, not the SPA page; HQ-zip likewise |
| …with the cookie behaving as a browser's would | hop 1 carries **no** cookie (Path excludes it) and is answered 307 regardless; hop 2 matches `Path=/leadfinder/`, carries it, and authenticates |
| old-style download, anonymous | one hop → **401 `{"error":"authentication required"}`**, the app's auth challenge — **identical to what an anonymous click gets today**, so the repair preserves current behaviour rather than changing it. Not a loop, and never a 200 SPA page |
| old root, anonymous | 307 → **200 SPA**, i.e. the login screen (`/leadfinder/api/me` → 401 is what makes it render sign-in) |
| method preservation | proved from **the server's own access log**: `POST /api/jobs/<id>/csv` then `POST /leadfinder/api/jobs/<id>/csv` — and the far end 404s where a GET serves the file, so a silent downgrade would have been visible |
| query preserved exactly | `?product=cps`, `?a=1&b=2`, `?next=//evil.com`, `?a=%2F%2Fevil.com`, `?e=%C3%A9&f=a+b` all byte-identical in the `Location` |
| no doubled-slash 200 | every legacy shape and every derived target: no `//` in any pathname, and `/leadfinder//api/jobs/<id>/csv` now **404** instead of 200 index.html |
| OAuth redirect URI carries exactly one prefix | re-derived through the real sink for both gateway hosts, and independently through the `PUBLIC_URL` fallback branch — all three identical to what Bundle 2/V1 recorded |
| emailed link composition | all three shapes → `https://tools.mobupps.net/leadfinder/…`, one prefix, our origin, no doubled slash |
| nothing else adopted | `/api/me`, `/api/jobs`, `/api/settings`, `/some/deep/link`, `/assets/…`, `/leadfinderX`, `/leadfinder2/` still 404 |
| bare prefix | **307** → `/leadfinder/`, one hop, main page 200 |

**The exact URIs to register are unchanged by this order** — both remain as recorded above
under "External registrations discovered", re-derived character for character in this
smoke.

**7. Two deliberate behaviour deltas from the recorded LIT table, both LIT-only**
1. The bare-prefix redirect is **307, was 302**. The ROADMAP convention this order enforces
   bans 302 outright (it licenses a POST to be downgraded), and leaving one 302 in the same
   redirect surface would read as an oversight at the next audit. DARK is untouched.
2. A prefixed path with an **empty segment now 404s** instead of returning 200 index.html.
   That is the round-1 fix; the unprefixed arm still answers index.html everywhere, which
   the darkness rule requires.

**8. Auto-fix** — both in-scope findings fixed and re-audited to a clean round. O-9 is
**closed** (the platform has now committed the `.replit` port deletion), O-10, O-11 and
O-12 are updated with what this order changed, and three new out-of-scope items are
recorded as O-16…O-18 and left untouched.

---

### Leadfinder Hotfix H1 — PUBLIC_BASE_URL authoritative for the OAuth redirect URI ☑ DONE (2026-08-02)

Branch `hotfix-h1-oauth-host`. **Production is live and sign-in is broken**, so this is a
hotfix, not a bundle: minimum surface, same ritual.

**0. Lineage check (Git safety rule 1, directional form) — PASS.** *Does another branch
hold content main lacks?* `git diff <branch> main` over all 9 local and 8 remote refs:
nothing does. `replit-agent` carries 4 commits `main` lacks with an **identical tree**.
`main` has taken two further platform *"Published your App"* commits since L2 (`fe8c7c8`,
`dc3a2b4` — the cutover publishes); `git diff c4807f6 main` is **empty**, so they changed
no file. `main` and `origin/main` are level. Branch cut from `main`.

**1. Blast radius (recorded before the first edit)**

*The defect, measured rather than assumed.* `getRedirectUriFromReq()`
(`oauth.ts:51`) is the single sink for the redirect URI: the authorize step
(`getAuthUrl`), the token exchange (`exchangeCodeForTokensAndProfile`) and
`/api/auth/google/debug` all call it. Its precedence today is
**`x-forwarded-host` → `Host` → `PUBLIC_BASE_URL`**, and the third branch is reached only
when a request carries neither header — which HTTP/1.1 makes effectively impossible. So
`PUBLIC_BASE_URL` is **dead code on this path**, even though it is the value the boot
guard validates and the value every emailed link already uses. Only the *host* is
request-derived; the path half already comes from `BASE_PATH` via `basePath()`.

Measured against the live configuration (`BASE_PATH=/leadfinder/`,
`PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`), booted from the real assembly:

| What the app receives | Derived URI, before this fix |
|---|---|
| gateway → `.replit.app`; Replit's edge sets `x-forwarded-host: ad-library-finder.replit.app` | `https://ad-library-finder.replit.app/leadfinder/api/auth/google/callback` ← **the mismatch** |
| direct hit, no `x-forwarded-*` | `http://ad-library-finder.replit.app/leadfinder/api/auth/google/callback` (**http**, which Google rejects outright) |
| a gateway that forwarded the original host | `https://tools.mobupps.net/leadfinder/api/auth/google/callback` (correct — but the gateway does not do this) |
| `PUBLIC_BASE_URL` | never consulted |

Google holds `https://tools.mobupps.net/leadfinder/…` and
`https://mobupps-tools-gateway.replit.app/leadfinder/…`; the app sends the deployment
host, which is on neither list. **This is exactly the risk Bundle 1 recorded under
"External registrations discovered"** — *"Depends on the gateway forwarding
`x-forwarded-host`… check this against the running gateway before cutover"* — the check
was not run, and it landed. Two further consequences, both closed by the same change: the
authorize step and the callback can arrive on **different** hosts (the callback comes back
through whatever Google was given), so a request-derived host is not even self-consistent
across the pair Google compares; and a request without `x-forwarded-proto` yields `http://`.

*Files to be touched — 3 code + 1 doc:*

| File | Change |
|---|---|
| `artifacts/api-server/src/oauth.ts` | `PUBLIC_URL` consulted FIRST when set; header derivation kept verbatim as the fallback |
| `artifacts/api-server/scripts/check-oauth-redirect-uri.mjs` | **new.** boot gate: derives the URI in real child processes across env × header combinations |
| `artifacts/api-server/scripts/run-tests.mjs` | run the new gate |
| `TODO.md` | this entry |

*Not touched:* `urls.ts` (`publicUrl()` already composes exactly this string, and it is
already proved to carry the prefix exactly once), `app.ts`, `index.ts`, `auth.ts`,
`routes-auth.ts` (including the `/api/auth/google/debug` response shape — the DARK
baseline pins it, see O-4), `notifier.ts`, the client, the database, Replit Secrets.

*Behaviours affected:*
1. With `PUBLIC_BASE_URL` **set**, the redirect URI is `PUBLIC_BASE_URL` +
   `/api/auth/google/callback`, on every request, regardless of headers. This is the fix.
2. With `PUBLIC_BASE_URL` **unset**, nothing changes at all — the header derivation is
   byte-identical, including the `http://` case and the "no host at all" throw. That is
   the rollback path and it stays frozen.
3. **Wider than production:** any deploy with `PUBLIC_BASE_URL` set is affected, including
   this workspace, whose env holds `https://leadfindermobupps.replit.app`. Dev sign-in
   will use that address rather than the request host. That is the intended semantic of
   the variable — "this is my public address" — but it is a behaviour change outside
   production and is called out rather than buried.

*Worst realistic failure, in order:*
1. **`PUBLIC_BASE_URL` set to something Google does not have registered.** Sign-in stays
   broken, just with a different URI in the error. Mitigated by the boot guard (the value
   must be absolute http(s) and its path must equal `BASE_PATH` exactly) and by the smoke
   printing the derived string character for character, so it can be compared with the
   Cloud Console before publishing.
2. **The two steps disagreeing.** Only one function derives the URI and it now depends on
   no per-request input, so the authorize step and the token exchange are identical by
   construction. Asserted from the server's own log rather than claimed.
3. **A regression in the unset path**, which would break the rollback. Caught by the DARK
   byte-identity gate, which pins the `oauth debug` line of the 17-probe table.

*Rollback:* `git revert` the commit, or unset `PUBLIC_BASE_URL` (which restores the exact
previous behaviour by construction — the old code path is untouched). No DB migration, no
schema change, no secret change. **No new OAuth registration is required:** the URI this
fix produces, `https://tools.mobupps.net/leadfinder/api/auth/google/callback`, is already
registered.

**2. Implementation** — the blast radius held exactly: 3 code + 1 doc.

`getRedirectUriFromReq()` gains one early return:

```ts
if (PUBLIC_URL) {
  return publicUrl(OAUTH_CALLBACK_PATH);
}
// …the header derivation below is unchanged, byte for byte…
```

The header branch is untouched. The old trailing `return publicUrl(...)` — the third
priority — is now unreachable by construction (the early return took every case that could
have got there), so it was replaced by the throw that already guarded it; leaving it would
read as if `PUBLIC_URL` were still a last resort rather than the first choice. **The
throw's condition is unchanged**: no host *and* no `PUBLIC_BASE_URL`. The one state that
used to reach the old line — no host header but `PUBLIC_BASE_URL` set — now returns the
same string from the top, and that equivalence is asserted (`'no host headers at all'` is
in the gate's header matrix).

**`getRedirectUriFromReq` is the only sink**, confirmed by sweep rather than memory: the
sole other `x-forwarded-*` / `req.get('host')` reads in the tree are in
`routes-auth.ts:58-60`, where the debug endpoint *echoes* the headers for diagnosis
without deriving anything. Its three callers — the debug endpoint, `getAuthUrl` (authorize)
and `exchangeCodeForTokensAndProfile` (token exchange) — all go through it, which is why
the pair Google compares is now identical **by construction**: the string depends on no
per-request input at all.

**3. Gates** — all green.

| Gate | Command | Before | After |
|---|---|---|---|
| typecheck + build | `pnpm build` | pass | pass |
| tests | `pnpm --filter api-server test` | 30 modules, 1469 | 30 modules, **1469**, 0 failed |
| standalone gates, run directly | `node scripts/check-*.mjs` | 4 | **5** (new: `check-oauth-redirect-uri`) |
| new boot gate | `check-oauth-redirect-uri.mjs` | — | **59 LIT + 7 DARK + 4 public-only**, 0 failed |

The unit-assertion total is unchanged because the new gate is a **booted** one: `PUBLIC_URL`
is resolved at module load, so "set" and "unset" are two processes, not two arguments. The
gate boots the real assembly per env combination and reads the URI through the real sink —
both directly and over HTTP through `/api/auth/google/debug`, which is the endpoint an
operator will use to confirm the fix on production.

**4. Godlike audit — 3 rounds, closed on a fully clean one**

*Round 1 — 0 product findings, 619 assertions.* The load-bearing one is a **differential**:
with `PUBLIC_BASE_URL` unset, the new function is run against the **old implementation
copied verbatim** across 16 header shapes (missing headers, multi-value, whitespace-padded,
empty, `evil.com@good.com`, port forms, no headers at all). Identical output on every
shape, and it throws exactly where the old code threw. That is the rollback-path claim,
proved rather than asserted. With `PUBLIC_BASE_URL` set — prefixed, unprefixed, nested,
explicit port, and `http://localhost` — all 16 header shapes derive **one** string, checked
with the URL oracle: declared origin, declared scheme, no userinfo, no doubled slash, path
exactly base + callback, prefix never repeated (checked with the parser, not by counting).
Boot refusals re-proved in real child processes: userinfo, `user:pass@`, protocol-relative,
`javascript:`, query-bearing, doubled trailing slash, missing prefix and double prefix all
still refuse to start; both legitimate states still start.

*Round 2 — 1 finding, in the verification tooling, and a real consequence behind it.* The
L2 LIT smoke failed one check: it expected the derived URI to follow `x-forwarded-host` for
`mobupps-tools-gateway.replit.app`. That expectation encoded the **pre-H1** behaviour —
exactly the behaviour that broke sign-in — so the check was updated, not the product. The
consequence it exposes is worth stating plainly: **the gateway's `.replit.app` mirror is no
longer a self-contained login surface.** A user who starts sign-in there is now sent to
Google with the `tools.mobupps.net` callback and lands on the canonical domain afterwards,
with the session cookie set there. That follows the ROADMAP's own rule that
`https://tools.mobupps.net/<tool>` is canonical and the other addresses are mirrors, and it
is a consequence of the fix rather than a defect — but it means the previously-registered
`https://mobupps-tools-gateway.replit.app/leadfinder/api/auth/google/callback` URI is now
**unused**. Per cutover rule 5 it stays registered; nothing to change in the Cloud Console.
No cross-process problem is introduced: authorize and callback still reach the same single
Reserved-VM process through the gateway, so the in-memory `state` store still validates.

*Round 3 — fully clean.* Everything re-run in one pass: build ✓ (0 tsc errors), 1,469
assertions ✓, five standalone gates ✓, H1 audit 619/0 ✓, **L2 audit 4,763/0 ✓**, DARK smoke
byte-identical ✓, L2 LIT smoke 83/83 ✓, H1 LIT smoke 11/11 ✓.

**Security framing.** H1 *removes* an attacker-influenced input from an outbound URL. Before
it, anyone able to reach the deployment directly with a forged `Host` or `x-forwarded-host`
could make the app send `redirect_uri=https://attacker/...` to Google. Google's allow-list
made it unexploitable for token theft, but the value flowed from request into an outbound
URL, and the URL parser confirms that no longer happens: with `PUBLIC_BASE_URL` set, all 16
header shapes — including `evil.example.com` in both headers — yield the same canonical
string. `PUBLIC_BASE_URL` itself is already validated at boot (absolute http(s), no
userinfo, no query/fragment, path exactly `BASE_PATH` while prefixed) and that validation
was re-proved here in real child processes.

**5. Smokes — both modes, real DB checksum verified either side**

Same envelope as L2: the app is assembled by the shipped `buildApp()`, `startQueue()` is
never called, each run uses its own throwaway cwd and binds `127.0.0.1` on ports 3991-3998,
outside `.replit`'s mapped set. **Real DB md5 `e689c6fc55e6276acf296f7e9bada157` identical
before and after every run. No secret was written. No workflow was running or touched. No
scraping job was started and no email was dispatched.**

*a. DARK (`BASE_PATH` and `PUBLIC_BASE_URL` both unset) — the 17-probe table is
**byte-for-byte identical** to the Bundle 1 baseline*, md5
`0b9f472cd1fcb63fb9c93396cc198b06`, `diff` clean. That table pins the `oauth debug` line
(`redirectUri: http://127.0.0.1:<PORT>/api/auth/google/callback`, `publicBaseUrlEnv: null`),
so the rollback path is verified at the exact surface this hotfix touches.

*b. LIT (`BASE_PATH=/leadfinder/`, `PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`,
set for the child process only) — 11/11, plus the L2 LIT suite at 83/83.* Both steps Google
compares were driven over real HTTP **on deliberately different hops** — the authorize step
with `x-forwarded-host: ad-library-finder.replit.app` (what production sees), the callback
with `x-forwarded-host: tools.mobupps.net` (what Google would return through) — and the URI
read from **the server's own log**, not from an assertion:

```
[INFO] OAuth authorize: using redirect_uri=https://tools.mobupps.net/leadfinder/api/auth/google/callback
[INFO] OAuth callback:  using redirect_uri=https://tools.mobupps.net/leadfinder/api/auth/google/callback
```

Identical strings, from different hops. The `redirect_uri` parameter actually handed to
Google was read out of the authorize redirect's `Location` and is the same string again;
`/leadfinder/api/auth/google/debug` reports it too, while still echoing the real
`forwardedHost`, so the mismatch stays diagnosable from one endpoint.

**Nothing reached Google.** The token exchange was driven with a bogus code and
`HTTPS_PROXY` pointed at a closed local port, so the outbound POST to
`oauth2.googleapis.com/token` failed with `ECONNREFUSED 127.0.0.1:1` — asserted positively,
along with the absence of any Google-issued error (`invalid_grant`), which is what proves
no request left the machine. The log line under test is written *before* that call, so the
evidence is unaffected.

**6. What the operator must check after publishing.** Nothing in the Cloud Console — the
URI this produces is already registered. Confirm from the app itself:
`GET https://tools.mobupps.net/leadfinder/api/auth/google/debug` must report
`"redirectUri":"https://tools.mobupps.net/leadfinder/api/auth/google/callback"`, and
`forwardedHost` will still show the deployment host, which is the point: the URI no longer
follows it.

**7. Auto-fix** — no in-scope product findings after round 1; the round-2 finding was a
verification-tooling expectation and was corrected there. One new out-of-scope item recorded
as **O-19** and left untouched. O-4 remains open and is now more clearly worth taking at the
next opportunity: the debug endpoint still echoes the raw env rather than the resolved
config, and it is the endpoint this failure is diagnosed from.

---

### Leadfinder Order L-3.3a — Chief machine surface ☑ DONE (2026-08-06)

Branch `leadfinder-l33a-chief-surface`. The app side of step 3.3, the discovery seam:
a token-authenticated machine surface the Chief commands discovery jobs through.

**0. Lineage check (Git safety rule 1, directional form) — PASS.** *Does another branch
hold content `main` lacks?* Answered with `git diff <branch> main` plus
`git rev-list --count main..<branch>` over all 9 local and 9 remote refs. Nothing does.
Only `replit-agent` carries commits `main` lacks (5), and its tree is **identical** to
`main`'s (`98490c48103f5e2032549bf2267e4407c228e79b` on both), so it holds no content.
`main` is 1 commit ahead of `origin/main` (`afe1953`, a platform *"Published your App"*)
and the two trees are identical. Branch cut from `main` at `afe1953`.

**1. Blast radius (recorded before the first edit)**

*Files to be touched — 8 code + 1 doc:*

| File | Change |
|---|---|
| `artifacts/api-server/src/chief.ts` | **new.** `CHIEF_TOKEN` loader (trimmed, boot warning on stray whitespace, loaded only if it can authenticate), constant-time Bearer check, the system principal, the supported-country catalog, the closed-body validator, the wire serializers, `runChiefTests()` |
| `artifacts/api-server/src/routes-chief.ts` | **new.** `GET /status`, `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/leads`, a terminal JSON 404, and a body-parser error handler scoped to this mount only |
| `artifacts/api-server/src/db.ts` | one line inside `initDb()` — `ensureChiefSchema()`. No existing table, column, index or query is touched |
| `artifacts/api-server/src/app.ts` | one mount, `app.use(basePath('/api/chief'), chiefRouter)`, plus the scoped error handler after it |
| `artifacts/api-server/src/notifier.ts` | one structural guard: a job owned by the chief principal returns **before** any sender or recipient is resolved. The single choke point all five pipelines pass through |
| `artifacts/api-server/scripts/check-chief-surface.mjs` | **new.** boot gate — the real assembly, both modes, over real HTTP |
| `artifacts/api-server/scripts/check-country-mirror.mjs` | **new.** drift gate: the server's supported-country catalog ↔ `dashboard/src/countries.ts` |
| `artifacts/api-server/scripts/run-tests.mjs` | run the two new gates |
| `TODO.md` | this entry |

*Not touched:* the whole `dashboard` package (no UI change), `urls.ts`, `auth.ts`,
`oauth.ts`, `routes-auth.ts`, `routes-jobs.ts`, `routes-settings.ts`, `queue.ts`,
`jobControl.ts`, `csv.ts`, every scraper and pipeline, `.replit`, Replit Secrets, the
production database.

*Database change — the minimum idempotency and the principal strictly require:*
one new table `chief_jobs(external_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE,
created_at INTEGER NOT NULL)` and one new row in `users` (the non-human principal).
Deliberately **not** a new column on `jobs`: `getJob`/`listJobsForUser`/
`listAllJobsWithUsers` all `SELECT *`, so a column would add a field to the JSON of every
human job response, and "humans notice nothing" is a hard rule of this order. SQLite `TEXT
PRIMARY KEY` compares BINARY, which is what makes the idempotency key byte-exact.

*Behaviours affected:*
1. Four new paths under `/api/chief/*` exist in **both** modes. Unprefixed they were
   previously answered `200 index.html` by the SPA catch-all; prefixed they were 404.
2. `notifier.ts` gains one early return, reachable only by a job whose
   `created_by_user_id` is the chief principal. No human job can reach it.
3. `initDb()` creates one table and upserts one user row at boot. Idempotent.
4. The **admin** Activity view (`/api/jobs/activity`) will list chief jobs, labelled with
   the principal's identity through the existing `LEFT JOIN users`. A regular user's
   `/api/jobs` is unchanged — it filters on their own id and can never see them.
5. Nothing else: no existing route, response body, cookie, redirect or email changes.

*Worst realistic failure, in order:*
1. **The token opens a cookie path, or a cookie opens a chief path.** The whole point of
   the seam. Structurally prevented — the two checks read different inputs and neither
   consults the other — and tested in both directions.
2. **A human's job readable through the token.** Both chief GETs 404 unless the job's
   owner *is* the principal, so a human job is indistinguishable from a missing one.
3. **A commanded job emailing someone.** Guarded at the single notifier choke point,
   before any sender or recipient resolution, and proved by the difference against a human
   job in the same test.
4. **Idempotency bypassed**, giving the Chief two jobs for one `external_id`. Prevented by
   a UNIQUE primary key over the raw bytes, a constraint-catch on the insert race, and by
   never normalising the key (no trim, no case fold).
5. **The new mount disturbing the L2 legacy layer or the SPA fallback.** No legacy rule
   matches `/api/chief/*`; the recorded 17-probe DARK baseline is re-run byte-for-byte and
   the legacy gate is re-run in both modes.
6. **A secret in a log, error or response.** The token is read once at load, never logged,
   never echoed; the 401 body is a fixed literal, identical for all four failure causes.

*Rollback:* `git revert` the branch commits. No env var, no secret, no deploy step and no
data migration. Leaving `CHIEF_TOKEN` unset is itself a complete functional rollback —
with no token loaded nothing can authenticate and every `/api/chief/*` path answers the
same 401 — and the new table and principal row are inert without it.

**The blast radius held**, with one addition recorded during the audit: nothing outside the
9 files above was touched, and the database change is exactly the one table and one row
predicted.

---

## THE CONTRACT AS BUILT — C-3.3b is written from this section alone

**Address.** Every path below is mounted through `basePath()`, exactly like `/api/jobs`.
With `BASE_PATH` unset it serves at `https://ad-library-finder.replit.app/api/chief/…`;
with `BASE_PATH=/leadfinder` it serves at
`https://ad-library-finder.replit.app/leadfinder/api/chief/…` **and nowhere else** — the
unprefixed address answers 404 while prefixed, and no L2 legacy rule adopts it. Both forms
are proved in the smoke. **Use the prefixed form once the cutover is done.**

**Authentication.** `Authorization: Bearer <CHIEF_TOKEN>` on every request.

- The scheme is **case-sensitive** (`Bearer`), separated by **exactly one space**. The
  credential is compared verbatim, byte for byte, in constant time
  (`crypto.timingSafeEqual` after a length check).
- The app's stored secret is trimmed at load; the presented credential is not trimmed by
  this app. Leading/trailing whitespace around the whole header VALUE is removed by the
  HTTP parser itself (RFC 7230 §3.2.4) before the app sees it — interior whitespace
  (`Bearer  tok`) is part of the credential and fails.
- 401 is **one indistinguishable answer** — same status, same body, same headers — for a
  missing header, a malformed header, a wrong token, and an unset `CHIEF_TOKEN`. No
  `WWW-Authenticate`, no timing or length signal about the expected value.
- The token opens **only** `/api/chief/*`. It opens no cookie-authenticated path. A cookie
  session — including an admin one — opens **no** `/api/chief/*` path.
- Every chief response, success or failure, carries `Cache-Control: no-store`.

**Status codes, in the order they are decided:**

| Order | Code | When |
|---|---|---|
| 1 | `400` / `413` | malformed JSON / body over 1 MB — raised by the app-level body parser **before auth**, answered as JSON on this mount only (`{"error":"malformed JSON body"}`, `{"error":"request body too large"}`). The parser's own message, which quotes the body back, is never returned. |
| 2 | `401` | `{"error":"unauthorized"}` — ahead of every routing decision, so **401 precedes 404** and an anonymous caller cannot learn whether a path or a job exists. |
| 3 | `404` | `{"error":"not found"}` — unknown path, unknown method on a known path, unknown job id, **or a job this principal does not own**. |
| 4 | `415` | `{"error":"Content-Type: application/json required"}` |
| 5 | `400` | validation refusal, `{"error":"<the message from the table below>"}` |
| 6 | `503` | `{"error":"status unavailable"}` (status), `{"error":"temporarily unavailable"}` (reads), `{"error":"not accepting jobs"}` (create). A failed read is **never** a fabricated value or an empty list. |
| 7 | `200` / `201` | success. `201` when a command creates a job, `200` when a known `external_id` returns the existing one. |
| — | `500` | `{"error":"could not create job"}` — a genuine bug, distinct from 503 on purpose: 503 means ask again, 500 means stop asking. |

### `GET /api/chief/status`

```json
{ "app": "leadfinder", "ok": true, "accepting_jobs": true,
  "active_jobs": 0, "spend_today_usd": 0, "server_time": "2026-08-06T11:38:56.449Z" }
```

- `accepting_jobs` — **this app's queue cannot refuse a creation.** `createJob` inserts a
  `pending` row and `dispatchRunnable` (queue.ts) only decides *when* it starts; the global
  concurrency ceiling, the per-user serialisation and the LLM daily cap all delay a start,
  none rejects a create. So the honest answer is "yes, whenever this app can reach its own
  database", and the value is produced by a real read, not a literal. `POST /jobs` calls
  the same predicate and 503s when it is false, so the flag cannot promise what the create
  path refuses. **Accepted is not started** — see the queueing note below.
- `active_jobs` — `COUNT(*) FROM jobs WHERE status='running'`, across **every** owner.
  A human's browser-started run consumes the same worker slot as a commanded one.
- `spend_today_usd` — **not the constant 0 the order predicted; see the deviations
  section.** It is this app's own `llm_spend` ledger summed over the current
  Asia/Jerusalem day. It reads 0 on a day with no LLM calls because the ledger says so.
- `server_time` — ISO-8601 UTC, always ending `Z`.

### `POST /api/chief/jobs`

Request — `Content-Type: application/json` required, **closed body**, any unknown field
refused by name:

| Field | Type | Rule |
|---|---|---|
| `source` | string | one of `google_ads`, `meta`, `affplus`, `appgoblin`. Case-sensitive. This is the USER-FACING vocabulary — the four buttons on the human form — not the stored `JobSource`. `store_first` is a storage id and is never accepted as an input; it is reached by naming `google_ads` with `target_type: mobile`, exactly as the human form reaches it. **Corrected by L-3.3c** — the original text here claimed `store_first` "has nothing to return through `/leads`", which is false. |
| `target_type` | string | `mobile` or `cps`. **`appgoblin` accepts `mobile` only; every other source accepts both.** See the corrected matrix in the L-3.3c entry. **Corrected by L-3.3c** — the original text here claimed `google_ads` accepts `cps` only, which refused a combination this app supports and runs every day. |
| `countries` | string[] | non-empty; each an ISO-3166 alpha-2 code from this app's supported catalog (**137 codes**, mirrored from the human form and drift-gated). Accepted in any case and upper-cased; **duplicates are refused**, not merged. |
| `lead_count` | number | `20`, `50` or `100` only. Unlimited does not exist for a commanded job. |
| `external_id` | string | required idempotency key. 1–200 **bytes** of UTF-8, no C0/C1 control characters. Stored and compared **byte for byte** — never trimmed, never case-folded. Over-length is refused, never truncated. |
| `appgoblin_category` | string? | `[a-z0-9_]+`. **Required (with or instead of the next field) when `source` is `appgoblin`** — see the deviations section. Refused on any other source. |
| `appgoblin_ad_network` | string? | a domain such as `appsflyer.com`; lower-cased. Same requirement and same restriction. |

Response `201` (created) or `200` (idempotent replay):

```json
{ "created": true, "job": { …the job object… } }
```

**Idempotency.** `external_id` is the PRIMARY KEY of a side table, so uniqueness is the
database's, not a read-then-write. Five simultaneous identical commands produce exactly
one job (proved). `"chief-1"`, `"CHIEF-1"` and `" chief-1 "` are three different keys and
therefore three different jobs — the bytes are the key.

### The job object — 17 fields, in this order

```json
{ "job_id": "job_qgibKD68qk", "external_id": "chief-smoke-0001",
  "source": "meta", "target_type": "mobile", "countries": ["US","GB"], "lead_count": 20,
  "state": "pending", "phase": "queued", "step": "waiting for worker",
  "progress_pct": 0, "leads_found": 0, "error": null,
  "created_at": "2026-08-06T11:38:56.458Z", "started_at": null, "completed_at": null,
  "run_after": null, "final": false }
```

**`state` is this repo's real vocabulary**, `jobs.status`, untranslated:

| `state` | Meaning | `final` |
|---|---|---|
| `pending` | queued, not started | false |
| `running` | executing now | false |
| `deferred` | hit this app's $100/day LLM cap mid-run; re-runs after `run_after` (next Asia/Jerusalem midnight), partial results kept | false |
| `completed` | finished | **true** |
| `failed` | pipeline error, or the stall watchdog; `error` carries the message | **true** |
| `cancelled` | stopped by a human (an admin can stop any job) | **true** |

`phase` is `jobs.phase`: `queued`, `starting`, `scraping`, `classifying`, `enriching`,
`building_csv`, `hq_splitting`, `done`, `failed`, `deferred`, `cancelled`, or `null` on a
pre-phase legacy row. `step` is `jobs.phase_detail`, the exact free-text line the human UI
renders as live progress (`US / "casino" (3/40)`). `progress_pct` is 0–100 across all of
the pipeline's work, monotonic within a run. `leads_found` is the live lead counter.
`error` is the pipeline's own message, bounded to 500 characters. All timestamps are
ISO-8601 UTC or `null`. Poll until `final` is true.

### `GET /api/chief/jobs/:id`

`{ "job": { …the job object… } }`, or **404 for any job the chief principal does not own**
— byte-identical to the 404 for an id that never existed.

### `GET /api/chief/jobs/:id/leads?offset=&limit=`

```json
{ "job_id": "job_…", "state": "pending", "final": false, "total": 5,
  "offset": 0, "limit": 2, "count": 2, "next_offset": 2, "has_more": true, "leads": [ … ] }
```

- `limit` defaults to **50**, is **capped at 100** (clamped, and the effective value is
  reported back). `offset` defaults to 0. Malformed values are **refused** (400), never
  silently corrected.
- `total` is the number of leads this job will deliver: `selectExportRows` applied to the
  job's own product type and lead cap — i.e. **exactly the rows the CSV and the emailed
  .xlsx carry**, not every advertiser the classifier rejected.
- Ordering is `job_results.id ASC` (insertion order), strictly ascending and stable: rows
  are only ever appended, so an offset stays meaningful across polls of a running job.
  Reading a job before it finishes is allowed; `final` says whether the answer can change.
- **A page may be shorter than `limit`.** A 48 KB budget on the `leads` array binds first
  when the data is fat (a tracking-heavy `landing_url` is length-bounded nowhere in this
  app), which is what keeps every page well under the Chief's 64 KB ceiling — proved with
  100 leads carrying 4 KB URLs each. **Always continue from `next_offset`, never from
  `offset + limit`.**

### The lead object — 10 fields, derived from what this app stores

```json
{ "lead_id": 1, "advertiser_name": "Smoke Advertiser 1", "country": "US",
  "classification": "mobile_google_play",
  "store_url": "https://play.google.com/store/apps/details?id=com.smoke.app1",
  "landing_url": "https://smoke-1.example.com/offer",
  "page_url": "https://facebook.com/smokepage1",
  "app_category": null, "is_game": null, "found_at": "2026-08-06T11:38:56.518Z" }
```

`lead_id` is `job_results.id`, the ordering key. `classification` is one of
`mobile_google_play`, `mobile_app_store` (mobile jobs) or `cps_web` (cps jobs).
`app_category` / `is_game` are the app-store enrichment fields — populated on GATC mobile
leads, `null` everywhere else. `is_game` is a real boolean or null, never 1/0.

**One stored column is deliberately absent: `ad_text`.** It is ad creative copy of
unbounded length; 100 of them would blow the 64 KB ceiling on their own. It remains in the
CSV and the .xlsx bundle.

### Every refusal message

| Message | Cause |
|---|---|
| `body must be a JSON object` | body is null, an array, or a scalar |
| `unknown field: <name>` | anything outside the 7 fields above (including `__proto__`; the name is bounded to 40 characters in the reply) |
| `source is required` / `source must be one of google_ads, meta, affplus, appgoblin` | missing / not on the list |
| `target_type is required` / `target_type must be one of mobile, cps` | missing / not on the list |
| `source appgoblin supports target_type mobile only` | incompatible pair — **the only one left** after L-3.3c. The `google_ads supports target_type cps only` refusal no longer exists: that pair runs the store engine. |
| `countries must be a non-empty array` / `countries must contain only strings` | shape |
| `unsupported country: <code>` | outside the 137-code catalog (bounded to 8 characters in the reply) |
| `duplicate country: <code>` | the same country twice |
| `lead_count must be one of 20, 50, 100` | missing, null, non-integer, or off-menu |
| `external_id is required` / `external_id must not be empty` | missing / empty |
| `external_id must not contain control characters` | C0/C1 byte in the key |
| `external_id must be at most 200 bytes` | over-length — refused, never truncated |
| `appgoblin jobs require appgoblin_category and/or appgoblin_ad_network` | no discovery axis |
| `appgoblin_category and appgoblin_ad_network apply to source appgoblin only` | axis on another source |
| `appgoblin_category must be lowercase letters/digits/underscores` | slug shape |
| `appgoblin_ad_network must be a domain like "appsflyer.com"` | domain shape |
| `limit must be at least 1` / `limit must be a non-negative integer` | paging |
| `offset must be at least 0` / `offset must be a non-negative integer` | paging |
| `<name> must be a single non-negative integer` | a repeated or structured query parameter |

### What the Chief must know about this app's queue

- **Commanded jobs run one at a time.** Every one is owned by the single principal, and
  queue.ts serialises per user (parallel across users, serial within one). A second command
  is accepted immediately and waits for the first. Unchanged by this order, and out of
  scope to change.
- They also share the global ceiling of 3 concurrent jobs with human runs.
- They are **not** exempt from the $100/day LLM cap. At the cap, a commanded
  `meta` / `affplus` / `appgoblin` / `google_ads` job is parked and reported as `deferred`
  with a `run_after`.
- A commanded job **never sends email**, on completion or failure.
- An admin can stop or resume a commanded job from the Activity view. Human oversight is
  retained deliberately; the Chief sees the result as `cancelled`.

### Four captured exchanges, token redacted (LIT, from the smoke)

```http
GET /leadfinder/api/chief/status HTTP/1.1          |  GET /leadfinder/api/chief/status HTTP/1.1
                                                   |  Authorization: Bearer <CHIEF_TOKEN>
HTTP/1.1 401                                       |  HTTP/1.1 200
Cache-Control: no-store                            |  Cache-Control: no-store
{"error":"unauthorized"}                           |  {"app":"leadfinder","ok":true,"accepting_jobs":true,
                                                   |   "active_jobs":0,"spend_today_usd":0,
                                                   |   "server_time":"2026-08-06T11:38:56.449Z"}
```

```http
POST /leadfinder/api/chief/jobs HTTP/1.1
Authorization: Bearer <CHIEF_TOKEN>
Content-Type: application/json

{"source":"meta","target_type":"mobile","countries":["US","GB"],"lead_count":20,"external_id":"chief-smoke-0001"}

HTTP/1.1 201
Cache-Control: no-store
{"created":true,"job":{"job_id":"job_qgibKD68qk","external_id":"chief-smoke-0001","source":"meta",
 "target_type":"mobile","countries":["US","GB"],"lead_count":20,"state":"pending","phase":"queued",
 "step":"waiting for worker","progress_pct":0,"leads_found":0,"error":null,
 "created_at":"2026-08-06T11:38:56.458Z","started_at":null,"completed_at":null,"run_after":null,"final":false}}

--- the same command again ---
HTTP/1.1 200
{"created":false,"job":{"job_id":"job_qgibKD68qk", …identical… }}

--- one field wrong ---
{"source":"meta","target_type":"mobile","countries":["US","XX"],"lead_count":20,"external_id":"chief-smoke-refused"}
HTTP/1.1 400
{"error":"unsupported country: XX"}
```

```http
GET /leadfinder/api/chief/jobs/job_qgibKD68qk HTTP/1.1
Authorization: Bearer <CHIEF_TOKEN>

HTTP/1.1 200
{"job":{"job_id":"job_qgibKD68qk","external_id":"chief-smoke-0001","source":"meta","target_type":"mobile",
 "countries":["US","GB"],"lead_count":20,"state":"pending","phase":"queued","step":"waiting for worker",
 "progress_pct":0,"leads_found":0,"error":null,"created_at":"2026-08-06T11:38:56.458Z","started_at":null,
 "completed_at":null,"run_after":null,"final":false}}

--- a job this principal does not own (a human's), byte-identical to a job that never existed ---
GET /leadfinder/api/chief/jobs/job_HUMANSMOKE
HTTP/1.1 404
{"error":"not found"}
```

```http
GET /leadfinder/api/chief/jobs/job_qgibKD68qk/leads?limit=2 HTTP/1.1
Authorization: Bearer <CHIEF_TOKEN>

HTTP/1.1 200
{"job_id":"job_qgibKD68qk","state":"pending","final":false,"total":5,"offset":0,"limit":2,"count":2,
 "next_offset":2,"has_more":true,
 "leads":[{"lead_id":1,"advertiser_name":"Smoke Advertiser 1","country":"US",
   "classification":"mobile_google_play","store_url":"https://play.google.com/store/apps/details?id=com.smoke.app1",
   "landing_url":"https://smoke-1.example.com/offer","page_url":"https://facebook.com/smokepage1",
   "app_category":null,"is_game":null,"found_at":"2026-08-06T11:38:56.518Z"}, …]}

--- continued at next_offset, and one refusal ---
GET …/leads?offset=2&limit=2   -> 200, offset 2, next_offset 4
GET …/leads?limit=0            -> 400 {"error":"limit must be at least 1"}
```

**2. Decisions worth their own line**

- **The system principal is a real `users` row** — `usr_chief` /
  `chief@orchestrator.internal` / "Chief (orchestrator)" — not a NULL owner and not a
  human. NULL was rejected outright: `canReadJob` (routes-jobs.ts:565) treats a NULL owner
  as readable by *everyone*, so commanded jobs would have been visible to every signed-in
  user. A real row also keeps the admin Activity view's existing `LEFT JOIN users`
  labelling every job with a creator instead of a blank. The identity is outside
  `@mobupps.com`, and `isAllowedEmail` admits that domain only, so no OAuth flow can ever
  produce or claim it.
- **Answer to "do commanded jobs appear anywhere in the human UI?": yes, in exactly one
  place — the ADMIN Activity view — and they are labelled.** A regular user's `/api/jobs`
  filters on their own id and can never see one; a non-admin reading a commanded job's id
  directly gets 404. In Activity they render with `Started by: chief@orchestrator.internal`
  through the existing column, needing no dashboard change. That is deliberate: an admin
  can already see and stop every job in this app, and a machine-issued job that no human
  could see would be a job nobody could stop.
- **No email is structural, not incidental.** The guard sits at the single choke point all
  five pipelines dispatch through (`notifier.ts`), *before* any sender or recipient is
  resolved. Both lookups would fail for the principal anyway — no Gmail tokens — but
  `getDefaultRecipientForUser` falls back to the owner's own email address, which for the
  principal is a real string, so "it fails because a lookup came up empty" was an accident
  waiting for a settings change to undo. The guard also leaves `notification_status` NULL
  rather than writing `'failed'`, so a commanded job does not wear a red mark for an email
  that was never in question. Proved by the difference: in the same test run a human job
  goes down the email path and records `'failed'`, a commanded one records nothing.
- **A side table, not a column on `jobs`.** `getJob`, `listJobsForUser` and
  `listAllJobsWithUsers` all `SELECT *`; a column would have added `"external_id":null` to
  the JSON of every human job response. The recorded DARK baseline pins those bytes.
- **The page has a byte budget, not just a row cap.** `limit ≤ 100` alone cannot hold a
  64 KB ceiling, because no URL in this app is length-bounded. A single lead larger than
  the whole budget is still returned alone rather than silently truncated — this codebase
  does not trim someone's data to make a wire format comfortable.
- **The supported-country catalog is mirrored and gated.** The human POST only checks that
  a code is two letters, so it accepts `XX` and runs a job that can never find anything.
  The machine surface refuses it, against a 137-code catalog mirrored from
  `dashboard/src/countries.ts` — with `scripts/check-country-mirror.mjs` failing the test
  gate on any drift, the pattern `check-lead-mirror.mjs` already established (and what O-5
  asks for elsewhere).

**3. Gates** — all green.

| Gate | Command | Before | After |
|---|---|---|---|
| typecheck + build | `pnpm build` | pass | pass |
| tests | `pnpm --filter api-server test` | 30 modules, 1469 | **31 modules, 1604**, 0 failed |
| `chief` unit suite | (inside the above) | — | **135** |
| standalone gates | `node scripts/check-*.mjs` | 4 | **6** (new: `check-country-mirror`, `check-chief-surface`) |
| new boot gate | `check-chief-surface.mjs` | — | **474 DARK + 478 LIT + 265 unset + 267 padded**, 0 failed |

The new gate boots the **real assembly** in four env modes, each in its own child process
with its own throwaway cwd, and never starts the queue.

**4. Godlike audit — 3 rounds, closed on a clean one**

*Round 1, technical — 4 findings, all fixed.* (a) A `deferred` commanded job had **no ETA
on the wire**: the Chief would have polled blindly for up to a day. `run_after` added as a
17th field. (b) `parsePagination`'s message for a repeated parameter said "must appear at
most once", which is wrong for the structured (`?limit[a]=1`) case — reworded. (c) The gate
asserted idempotency behaviourally but never proved the **database constraint** exists, nor
that its error code is the one `createCommandedJob` catches to answer a race — a rename
would have turned an idempotent answer into a 500. Both codes now pinned. (d) The bare
mount `/api/chief` and `/api/chief/` were not in the 401 sweep; added.

*Round 2, security — 2 findings.* (a) **Unbounded caller input was reflected in refusal
messages**: `unknown field: <10 KB>` and `unsupported country: <5 KB>` echoed whatever
arrived. A 400 that reflects an arbitrary payload is an amplifier and hands whatever
renders it a string of the caller's choosing. Both bounded (40 / 8 characters). (b) The
prototype-pollution test was **mis-constructed** — an object literal's `__proto__:` sets the
prototype instead of putting the key on the wire, so it was testing nothing. Rewritten to
send raw JSON; the real behaviour was already correct (`JSON.parse` makes `__proto__` an own
property, `Object.keys` sees it, the closed body refuses it), and a sanity assertion now
proves `Object.prototype` was not poisoned by the attempt.

*Round 3, end-user + coherence — 1 fix, 1 out-of-scope finding.* A failed read on the two
GET endpoints answered **500** where `/status` answered 503; unified to 503, because to a
machine the two mean opposite things ("ask again" vs "stop asking"). Out of scope and
recorded, not touched: the admin Activity view is `LIMIT 200 ORDER BY created_at DESC`, so a
busy Chief can push human jobs out of an admin's view (**O-22**).

*Round 4 — clean.* No findings.

**Two tests proved able to fail by reintroducing their defect** (order item 6):

| Defect reintroduced | Result |
|---|---|
| ownership check removed from `getChiefJob` | 3 failures per mode: *a human's job -> 404 (got 200)*, *…byte-identical to one that never existed*, *the same for its leads* |
| `suppressedForChief` guard removed from `notifier.ts` | 3 failures per mode: *a commanded job records no notification status at all*, *the suppression is recorded in the job log*, *no sender was ever resolved for it* |

Both were restored and the suite re-run green.

**5. Security framing — the six confirmations the order asked for**

| Requirement | How it is established |
|---|---|
| token/cookie separation in **both** directions | Structural: `requireChiefToken` reads only the `Authorization` header and never `req.user`; `requireAuth` reads only `req.user` and has never read a header. Proved over HTTP on 7 chief paths with a human session *and* an admin session (401, byte-identical to the anonymous 401), and with the token on 8 cookie paths including `/api/jobs/activity` and `/api/jobs/publishers` (401, each keeping its own body). |
| human jobs unreachable through the token | Both chief GETs answer 404 unless the owner **is** the principal, and the 404 body is byte-compared against the 404 for an id that never existed. Hostile ids (`..`, `%2e%2e`, `job_x%00`, `job_' OR 1=1--`) all 404. |
| chief jobs incapable of producing email | One guard at the only choke point, ahead of sender/recipient resolution; proved by the difference against a human job in the same run. |
| idempotency not bypassable by casing or whitespace | SQLite `TEXT PRIMARY KEY` compares BINARY, and the key is never trimmed or case-folded. `"CHIEF-EXT-HAPPY"` and `" chief-ext-happy "` each create their own job; the stored bytes are read back and compared. Five simultaneous identical commands → one job. |
| `countries` and `source` cannot reach an interpreter unvalidated | Both are allowlisted **before** storage — `source` against 4 literals, every country against the 137-code catalog — then written through bound parameters. `countries` reaches the engines as a JSON array of `[A-Z]{2}` strings; there is no path by which an unvalidated value is stored or executed. |
| no secret in any log, error, or response | The token is read once at load and never printed — not its value, not its length. The gate's parent process greps **the child's entire output** (boot lines, every access-log line, every failure message) for the test secret in all four modes and fails if it appears; both smoke servers' logs were grepped too. The 401 body is a fixed literal. |

**6. Smoke — separate ports, job runner disabled, facts from each server's own access log**

Three servers, ports **3971 / 3973 / 3975** (outside `.replit`'s mapped set — it maps only
3001), each bound to `127.0.0.1` in its own throwaway cwd, so `path.resolve('data')` made a
fresh sqlite file. **The real database's md5 is `e689c6fc55e6276acf296f7e9bada157` before
and after — identical to the value L2 recorded.** No workflow was running and none was
touched. `startQueue()` was never called, so every job created sat `pending` and nothing
executed: no scrape, no store call, no email, no external request of any kind.

*a. DARK (`BASE_PATH`, `PUBLIC_BASE_URL` unset).* The 17-probe endpoint table is
**byte-for-byte identical to the baseline recorded in the Bundle 1 ledger**, md5
`0b9f472cd1fcb63fb9c93396cc198b06` on both sides, `diff` clean — including
`Set-Cookie=als_session=<TOK>; Path=/` and both 702-byte SPA responses. The harness was
rebuilt from scratch for this order and reproduced the recorded md5 exactly. **Run twice:
with `CHIEF_TOKEN` unset and with it loaded — identical both times**, which is the
statement that the human surface does not move when the machine surface goes live. Then
every new path proved: bare 401, the authenticated happy path and one refusal per endpoint.

*b. LIT (`BASE_PATH=/leadfinder/`, `PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`).*
The same proofs at the prefixed paths, read back from the server's own log:

```
GET  /leadfinder/api/chief/status              401 then 200
POST /leadfinder/api/chief/jobs                201, then 200 (replay), then 400 (refusal)
GET  /leadfinder/api/chief/jobs/job_…          200
GET  /leadfinder/api/chief/jobs/job_…/leads    200, 200 (next_offset), 400 (limit=0)
GET  /leadfinder/api/chief/jobs/job_HUMANSMOKE 404  <- a human's job
GET  /leadfinder/api/jobs                      401  <- the chief token on the human surface
GET  /leadfinder/api/chief/nope                404 application/json, never the SPA page
GET  /api/jobs/job_HUMANSMOKE/csv              307 -> /leadfinder/api/jobs/job_HUMANSMOKE/csv
GET  /api/chief/status                         404  <- unprefixed, while prefixed
```

The L2 legacy redirect still answers **307** with its `Location` unchanged, and the
`check-legacy-redirects` gate (21 DARK + 212 LIT) passes untouched.

**7. Deviations from the order, stated plainly**

1. **`spend_today_usd` is the real ledger value, not a hardcoded `0`.** The order says it
   "is `0` and truthfully so, because this app has no paid vendors". That premise does not
   hold for this repo: `@anthropic-ai/sdk` is a dependency, `ANTHROPIC_API_KEY` is set in
   this environment, `classifier.ts` / `hqResolver.ts` / `webResolver.ts` call the Anthropic
   API, `llmBudget.recordSpend()` writes every call's exact USD cost to the `llm_spend`
   table, and `DAILY_CAP_USD` defers jobs at $100/day against that same sum. Returning a
   literal `0` on a day this app spent money is precisely the "fabricated value" the same
   paragraph forbids. It therefore reports `SUM(usd)` over the current Asia/Jerusalem day —
   which is `0`, truthfully, on any day with no LLM calls. The field's name, type and
   position are unchanged, so a Chief that only sums it is unaffected. Deliberately **not**
   `llmBudget.spentTodayUsd()`: that helper swallows a failed read and returns 0, correct
   for a budget gate that must fail open, wrong here where a failed read must be a 503.
2. **The closed body has two extra optional fields, `appgoblin_category` and
   `appgoblin_ad_network`.** The order lists `appgoblin` as a commandable source but gives
   the body no discovery axis, and `appgoblinPipeline.ts:116` throws
   `appgoblin: job missing source_params (category or adNetworkDomain required)` the moment
   such a job starts. Without these fields, every commanded AppGoblin job would have been
   created, queued, and failed on contact. The two fields use the human form's own
   validators verbatim, are required (at least one) when the source is `appgoblin`, and are
   refused on every other source. The body remains closed.
3. **The source ↔ target_type compatibility rules are enforced** (`google_ads` is cps-only,
   `appgoblin` is mobile-only). Not mentioned by the order, but they are this app's existing
   rules for humans, and the alternative is accepting a command the engine cannot run.
4. **`run_after` is a 17th field** on the job object, so a `deferred` job carries its own
   ETA rather than looking stuck.

**8. Auto-fix and out-of-scope** — every in-scope finding above was fixed and re-audited to
a clean round. Six items recorded and left untouched: **O-20** … **O-25** below.

---

### Leadfinder Order L-3.3c — the machine surface refuses a combination the app supports ☑ DONE (2026-08-06)

Branch `leadfinder-l33c-source-matrix`, cut from `main` at `8806f04`.

**0. What the defect actually is — the order's premise is half right, and the half it
gets wrong changes the fix.**

The order states that L-3.3a's source-to-target validation "does not share a source of
truth with the real job path". Read directionally, that is not what happened:

- L-3.3a's `TARGETS_BY_SOURCE` (`chief.ts:245-253`) is **not inverted, not stale and not
  invented.** It is an accurate mirror of `routes-jobs.ts:265-278`, which really does
  refuse `google_ads` + `mobile` for a human, with the message *"google_ads source
  supports productType=cps only — use the "Google Ads - Mobile" source for apps"*.
  Both paths agree today. A drift-fix alone would change nothing.
- The mismatch is a **layer** mismatch. This app has two source vocabularies. The
  **stored** one is `JobSource` (`db.ts:10`): `meta | affplus | appgoblin | google_ads |
  store_first`. The **user-facing** one is the four buttons on the New Job form, and
  `NewJobForm.tsx:70` maps them to the stored ids:
  `srcChoice === 'google_ads' ? (mode === 'mobile' ? 'store_first' : 'google_ads') : srcChoice`.
  `App.tsx:228` labels the stored id back: `store_first: 'GOOGLE ADS - MOBILE'`.
  So **Google Ads mobile discovery exists and works exactly as Michael says** — it is the
  `store_first` source wearing its UI name. L-3.3a mirrored the stored layer and then
  published it as the wire vocabulary, so the Chief was made to speak storage ids while
  every human speaks UI labels.
- Compounding it, L-3.3a **excluded `store_first` from the commandable sources on a
  factually wrong premise** — *"its deliverable is the shared Publishers corpus, not
  per-job leads, so it has nothing to return through `/leads`"*. It is wrong on all three
  counts, verified before this edit:

  | L-3.3a's premise | Verified reality |
  |---|---|
  | no per-job leads | `storeLeads.ts:245-257` `persistPublisherLeads` → `insertResult` writes `job_results` rows classified `mobile_google_play`/`mobile_app_store` with `store_url` — exactly the shape `/leads` serialises |
  | (lead cap unconsidered) | honours `maxLeads` — `storeDiscoveryPipeline.ts:407, 878, 944` |
  | (country universe unconsidered) | `ALL_MARKETS` (`storeDiscoveryConfig.ts:39`) and the chief catalog `SUPPORTED_COUNTRIES` (`chief.ts:269`) are **the same 137 codes in the same order** — machine-compared, zero difference either way |

So the fix is not "correct a table". It is: give the two paths one shared truth that
carries the **mapping** as well as the matrix, and let the machine surface reach the
engine the human UI reaches.

**One trap this creates, and the reason `countries` cannot just be passed through.**
`store_first` does not read `job.countries` at all — `resolveStoreParams`
(`storeDiscoveryConfig.ts:495-515`) takes its markets from `source_params.markets` and
falls back to `DEFAULT_ACTIVE_MARKETS` (12 markets) when absent. A commanded Brazil job
would therefore have run the default twelve markets and reported success. The human form
avoids this by sending `markets: countries.map(lowercase)` (`NewJobForm.tsx:220`); the
machine surface must do the same, or accepting the request would replace a loud 400 with
a silent wrong answer. The same file already carries a comment (`storeDiscoveryConfig.ts:501-506`)
about a previous bug of exactly this class.

**1. Blast radius (recorded before the first edit)**

*Files to be touched — 5 code + 1 doc:*

| File | Change |
|---|---|
| `artifacts/api-server/src/sourceMatrix.ts` | **new.** The single shared truth: the user-facing source × target-type matrix, and the mapping from each accepted pair to its stored `JobSource`. Both paths read it; neither keeps a table |
| `artifacts/api-server/src/routes-jobs.ts` | the two inline compatibility `if`s at 265-278 replaced by one call into `sourceMatrix`. Same refusals, same status, same messages for every input a human can send |
| `artifacts/api-server/src/chief.ts` | `TARGETS_BY_SOURCE` deleted; validation reads `sourceMatrix`; the resolved stored source is what `createCommandedJob` writes; `commandedSourceParams` gains a `store_first` branch that sets `markets` from the validated countries; `jobToChiefDto` maps the stored source back to the user-facing name so the wire round-trips |
| `artifacts/api-server/scripts/check-source-matrix.mjs` | **new.** drift gate: `sourceMatrix.ts` ↔ `NewJobForm.tsx:70` ↔ `App.tsx:228`, in the pattern `check-country-mirror.mjs` established |
| `artifacts/api-server/scripts/check-chief-surface.mjs` | the matrix assertions re-driven from the shared truth; the previously refused request added as a proof |
| `artifacts/api-server/scripts/run-tests.mjs` | run the new gate |
| `TODO.md` | this entry |

*Not touched:* every engine and pipeline, `queue.ts`, `jobControl.ts`, `notifier.ts`,
`db.ts` (**no schema change** — the mapping is code, and `store_first` is already a legal
`JobSource` value), `auth.ts`, `oauth.ts`, the whole `dashboard` package (no UI change),
Replit Secrets, the production database. The endpoint paths, auth, status ordering and
response schemas stay exactly as L-3.3a documented them.

*Behaviours affected:*
1. `POST /api/chief/jobs` with `source=google_ads, target_type=mobile` changes from **400
   to 201**, and creates a job whose stored source is `store_first`.
2. That job's `countries` now reach the engine as `source_params.markets`. No other
   source's `source_params` changes by a byte.
3. `GET /api/chief/jobs/:id` reports `source: "google_ads"` for such a job — the
   user-facing name it was commanded with, not the storage id. The 17-field schema is
   unchanged; only this one value's vocabulary is pinned down.
4. Refusal messages for genuinely impossible pairs are reworded to state the real
   supported set for the named source.
5. The human path: **no behaviour change at all.** Same inputs, same outcomes, same
   message strings — it is the same rules read from one place instead of two.

*Worst realistic failure, in order:*
1. **A commanded Google-Ads-mobile job silently runs the wrong markets** — the trap above.
   Prevented by the explicit `countries → markets` mapping and tested by reading the
   stored `source_params` back.
2. **The human path's validation shifts under the refactor**, so a human's job that used
   to be accepted is refused or vice versa. Guarded by driving the tests from the shared
   truth for every source × target pair, and by leaving the message strings byte-identical.
3. **The shared truth widens the vocabulary** — a matrix lookup accepting a source or
   target outside the closed lists. The lookup happens strictly after the two closed-list
   checks, and the security round confirms it specifically.
4. **The wire vocabulary becomes ambiguous** — `store_first` reachable under two names, or
   a job that reads back as something other than what was commanded. One vocabulary only:
   the four user-facing sources, and `store_first` is never accepted as an input.
5. **The L2 legacy layer or the DARK baseline moves.** Nothing here touches routing; the
   17-probe baseline and the legacy gate are re-run in both modes regardless.

*Rollback:* `git revert` the branch commits. No env var, no secret, no deploy step, no
data migration, no schema change. Jobs already created keep working — `store_first` was
always a legal stored source.

**2. Decision taken, with the alternative named.** The wire speaks the **user-facing**
vocabulary in both directions: the Chief commands `google_ads` + `mobile` and reads back
`source: "google_ads"`, exactly as a human picks "Google Ads" + "Mobile" and sees
"GOOGLE ADS - MOBILE". The alternative — exposing `store_first` as a fifth commandable
source — was rejected: it would give one capability two names on the wire, and it would
leave the Chief's own first command still refused, which is the defect this order exists
to close.

**3. THE CORRECTED MATRIX — the Chief's console form is built from this**

Four sources, two target types, **seven runnable pairs**. `source` and `target_type` are
both closed and case-sensitive; the engine column is internal and never appears on the wire.

| `source` | `target_type` | runs | what it is |
|---|---|---|---|
| `google_ads` | `mobile` | `store_first` | **the pair L-3.3c fixed.** Harvests the app stores and runs its own transparency confirmation. The human form calls this "Google Ads" + Mobile and the Activity view labels it `GOOGLE ADS - MOBILE` |
| `google_ads` | `cps` | `google_ads` | Google Ads Transparency advertiser search — matches advertiser names and verified domains |
| `meta` | `mobile` | `meta` | Meta Ad Library |
| `meta` | `cps` | `meta` | ″ |
| `affplus` | `mobile` | `affplus` | AffPlus offer feed |
| `affplus` | `cps` | `affplus` | ″ |
| `appgoblin` | `mobile` | `appgoblin` | AppGoblin app-store intelligence. Requires `appgoblin_category` and/or `appgoblin_ad_network` |
| `appgoblin` | `cps` | — | **the only pair this app cannot run.** AppGoblin has no web/CPS side. Refused 400 `source appgoblin supports target_type mobile only` |

Rules that follow from the table, all tested:

- **`store_first` is never an input.** `{"source":"store_first"}` is refused
  `source must be one of google_ads, meta, affplus, appgoblin`. One capability, one name.
- **The wire round-trips.** A job commanded as `google_ads` + `mobile` reads back
  `"source":"google_ads"` from `GET /api/chief/jobs/:id` forever, even though `jobs.source`
  holds `store_first`. The Chief always sees the vocabulary it spoke.
- **`countries` steer the store engine.** For the `store_first` pair they are written to
  `source_params.markets` lower-cased, exactly as the human form does. Every one of the 137
  supported country codes is a valid store market — the two lists are identical, machine-compared.
- **`lead_count` is honoured** by the store engine (`maxLeads`), like every other source.
- Everything else in L-3.3a's contract — paths, auth, status ordering, the 17-field job
  object, the 10-field lead object, paging — is **unchanged**.

**4. Gates** — all green.

| Gate | Command | Before | After |
|---|---|---|---|
| typecheck + build | `pnpm build` | pass | pass |
| tests | `pnpm --filter api-server test` | 31 modules, 1604 | **32 modules, 1702**, 0 failed |
| `sourceMatrix` unit suite | (inside the above) | — | **70** (new module) |
| `chief` unit suite | ″ | 135 | **163** |
| `check-chief-surface` | boot gate | 474 D / 478 L | **498 D / 502 L** (+265 unset, +267 padded) |
| `check-source-matrix` | boot gate | — | **new** — 7 runnable pairs verified against the dashboard |

**5. Godlike audit — 3 rounds, closed on a clean one**

*Round 1, technical — 3 findings, all fixed.* (a) `everySupportedPair()` was exported and
never called — dead code in the one file whose whole job is being the single truth. Removed.
(b) **The human path's compatibility rules had no test at all.** `runRoutesJobsTests` covers
publishers, not job creation, so the refactor of routes-jobs.ts:265-278 was resting on the
chief suite alone. A `sourceMatrix` suite now pins `targetsForStoredSource` for all five
engines — those five lines ARE the original hand-written rules, so a human-visible change
cannot pass silently. (c) Nothing proved MATRIX covers `JobSource`. A sixth source added to
db.ts and forgotten here would make `targetsForStoredSource` answer `[]`, and the human
route would then refuse *every* product type for it with the degenerate message
`X source supports productType= only`. Now a compile-time exhaustiveness check plus a
runtime assertion that no engine has an empty target set.

*Round 2, security — 1 finding, fixed.* The order asked specifically that the shared truth
cannot widen validation beyond the closed vocabularies. It cannot — both callers allowlist
*before* they look up (chief.ts via `isUiSource`/`isTargetType`, routes-jobs.ts via its
five-literal source check), and the signatures refuse a bare `string`. But writing the
hostile-key test found that **`resolveStoredSource` threw a TypeError on an unknown source
key**: `MATRIX['']` is `undefined` and indexing that dies, while `MATRIX['constructor']`
yields a function that is not an engine. Not reachable today — the guards and the types both
stop it — but a lookup that throws on an unknown key is a landmine for the next caller, and
this file exists precisely to be the one place nobody has to think twice about. Both lookups
now use own-property checks and are total. Tested against `__proto__`, `constructor`,
`prototype`, `toString`, `store_first`, `''` and `GOOGLE_ADS`.

*Round 3, end-user + coherence — 1 finding, fixed.* L-3.3a's "THE CONTRACT AS BUILT" section
is what C-3.3b is written from, and three of its lines had become false (the `source` row's
claim that store_first has nothing to return, the `target_type` row's cps-only rule, and the
`google_ads supports target_type cps only` refusal). All three corrected in place and marked,
rather than left for C-3.3b to trip over.

*Round 4 — clean.* No findings.

**Two defects proven able to fail their tests** (order item 4):

| Defect reintroduced | Result |
|---|---|
| `google_ads: { cps: 'google_ads' }` — the L-3.3a matrix restored | **3 gates red.** `chief` unit suite: 7 named failures. `check-source-matrix`: *"the form submits 'store_first' for google_ads + mobile, but the matrix has no such engine — the server would refuse a job the UI offers"*. `check-chief-surface`: red in both dark and lit |
| `markets: null` in `commandedSourceParams` | `chief` 2 failures, `check-chief-surface` red in both modes: *"a commanded google_ads+mobile job steers the store engine with its own countries (got …markets:null…)"* |

Both restored and the suite re-run green. The first exercise also exposed a **reporting**
defect worth its own line: `runChiefTests`'s `valid()` helper *threw* on a validation
regression, and an exception escaping the suite discards every failure already collected —
the module reported `0 failed` while being broken. It now records a failure and continues,
which is how the 7 named failures above became visible at all.

**6. Smoke — separate ports, job runner disabled, real assembly, throwaway cwd**

Two servers, ports **3971 (dark) / 3973 (lit)**, bound to `127.0.0.1`, each in its own
`mkdtemp` cwd so `path.resolve('data')` made a fresh sqlite file. `startQueue()` was never
called: every job created sat `pending` with `started_at = null`, so nothing executed — no
scrape, no store call, no email, no external request. **The real database's md5 is
`e689c6fc55e6276acf296f7e9bada157` before and after**, identical to the value L2 and L-3.3a
recorded. No workflow was running and none was touched. Both ports released.

*a. DARK (`BASE_PATH`, `PUBLIC_BASE_URL` unset) — 16/16.* The 17-probe endpoint table is
**byte-for-byte identical to the baseline recorded in the Bundle 1 ledger**, md5
`0b9f472cd1fcb63fb9c93396cc198b06` on both sides. The harness was rebuilt from scratch for
this order and reproduced the recorded md5 exactly.

*b. LIT (`BASE_PATH=/leadfinder`, `PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder`) —
18/18.* The same proofs at the prefixed paths:

```
GET  /leadfinder/api/chief/status              401 then 200
POST /leadfinder/api/chief/jobs                201  <- google_ads + mobile, PREVIOUSLY 400
       stored: source=store_first status=pending started_at=null
       params={"verticals":null,"markets":["us"],…,"maxLeads":20}
GET  /leadfinder/api/chief/jobs/job_…          200  <- reads back "source":"google_ads"
POST /leadfinder/api/chief/jobs                400  {"error":"source appgoblin supports target_type mobile only"}
POST /leadfinder/api/chief/jobs                400  {"error":"source must be one of google_ads, meta, affplus, appgoblin"}   <- store_first by name
GET  /leadfinder/api/jobs                      401  <- the chief token on the human surface
GET  /api/chief/status                         404  <- unprefixed, while prefixed
GET  /api/jobs/job_LEGACY/csv                  307 -> /leadfinder/api/jobs/job_LEGACY/csv
```

The L2 legacy redirect still answers **307** with its `Location` unchanged, and
`check-legacy-redirects` (21 dark + 212 lit) passes untouched.

**7. Deviations from the order, stated plainly**

1. **The order's diagnosis was half wrong, and the fix is bigger than it describes.** The
   order says L-3.3a's validation "does not share a source of truth with the real job path".
   The table was in fact an accurate mirror of routes-jobs.ts; both refused `google_ads` +
   `mobile`. Correcting a drift would have changed nothing. The real defect — a layer
   mismatch plus a factually wrong exclusion of `store_first` — is written up in section 0,
   and fixing it required routing the pair to a different engine and mapping `countries` to
   that engine's `markets`, not just editing a table.
2. **`commandedSourceParams` now dispatches on the engine, not the caller's word.**
   Unavoidable once one source name means two engines: `google_ads` + `cps` and `google_ads`
   + `mobile` need different `source_params` shapes.
3. **Three lines of L-3.3a's published contract were corrected in place**, not merely
   superseded here, because C-3.3b is written from that section alone.

**8. Auto-fix and out-of-scope** — every in-scope finding above was fixed and re-audited to a
clean round. **O-24 is now materially more urgent** (see Open items): with `appgoblin` the
only source carrying a required discovery axis, and its category catalog still reachable only
over a cookie-authenticated endpoint, it is the one remaining pair the Chief cannot command
successfully without out-of-band knowledge. No new open items.

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

**8. Endpoint baseline for Bundle 2** — recorded verbatim from the Bundle-1 run.
Volatile values are redacted (`<ID>`, `<T>`, `<TOK>`, `<PORT>`) so a future run can be
diffed directly. Identical output was produced by the pre-bundle build.

```
ENDPOINT PROBE RESULTS
────────────────────────────────────────────────────────────────────────────────────────────────────
health                      GET  /api/health                        200  {"ok":true,"ts":<T>}
version                     GET  /version                           200  {"builtAt":"<T>"}
me (anonymous)              GET  /api/me                            401  {"error":"not signed in"}
me (session)                GET  /api/me                            200  {"id":"usr_<ID>","email":"probe@mobupps.com","name":"Probe","isAdmin":false}
job list (anonymous)        GET  /api/jobs                          401  {"error":"authentication required"}
job list (session)          GET  /api/jobs                          200  {"jobs":[]}
oauth debug                 GET  /api/auth/google/debug             200  {"redirectUri":"http://127.0.0.1:<PORT>/api/auth/google/callback","clientIdPresent":true,"clientSecretPresent":true,"publicBaseUrlEnv":null,"forwardedProto":null,"forwardedHost":null,"hostHeader":"127.0.0.1:<PORT>","allowedDomain":"mobupps.com"}
job create (session)        POST /api/jobs                          200  {"jobs":[{"id":"job_<ID>","product_type":"mobile","countries":"[\"US\"]","status":"pending","csv_path":null,"error":null,"created_at":<T>,"started_at":null,"completed_at":null,"total_ads_scraped":0,"total_advertisers":0,"recipient_email":null,"notification_status":null,"created_by_user_id":"usr_<ID>","source":"meta","source_params":null,"phase":"queued","phase_detail":"waiting for worker","phase_updated_at":<T>,"hq_zip_path":null,"run_after":null,"cancel_requested":0,"leads_found":0,"progress_pct":0}]}
job detail = LIVE PROGRESS  GET  /api/jobs/job_<ID>                 200  {"job":{"id":"job_<ID>","product_type":"mobile","countries":"[\"US\"]","status":"pending","csv_path":null,"error":null,"created_at":<T>,"started_at":null,"completed_at":null,"total_ads_scraped":0,"total_advertisers":0,"recipient_email":null,"notification_status":null,"created_by_user_id":"usr_<ID>","source":"meta","source_params":null,"phase":"queued","phase_detail":"waiting for worker","phase_updated_at":<T>,"hq_zip_path":null,"run_after":null,"cancel_requested":0,"leads_found":0,"progress_pct":0},"logs":[]}
download csv (session)      GET  /api/jobs/job_<ID>/csv             404  {"error":"CSV not yet ready"}
download csv (anonymous)    GET  /api/jobs/job_<ID>/csv             401  {"error":"authentication required"}
download hq-zip (session)   GET  /api/jobs/job_<ID>/hq-zip          404  {"error":"HQ-split zip not yet ready"}
job list after create       GET  /api/jobs                          200  {"jobs":[{"id":"job_<ID>","product_type":"mobile","countries":"[\"US\"]","status":"pending","csv_path":null,"error":null,"created_at":<T>,"started_at":null,"completed_at":null,"total_ads_scraped":0,"total_advertisers":0,"recipient_email":null,"notification_status":null,"created_by_user_id":"usr_<ID>","source":"meta","source_params":null,"phase":"queued","phase_detail":"waiting for worker","phase_updated_at":<T>,"hq_zip_path":null,"run_after":null,"cancel_requested":0,"leads_found":0,"progress_pct":0}]}
logout (clears cookie)      POST /api/auth/logout                   200  {"ok":true}
                                                                    Set-Cookie=als_session=<TOK>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0
SPA root                    GET  /                                  200  text/html 702B
SPA deep link               GET  /some/deep/link                    200  text/html 702B
────────────────────────────────────────────────────────────────────────────────────────────────────
```

---

## PA-1 — Provenance audit (2026-08-05)

**VERDICT: no content has been lost.** The code running in production is the newest code
that has ever existed for this app. Every claim below rests on a hash, a diff, or a
command output; the two things the repo cannot prove are named at the end.

### Phase 1 — evidence inventory

Refs (all local + remote), tip date, ancestry vs main (`afe1953`, 2026-08-02 19:37:57):

| ref | tip | date | ancestor of main? |
|---|---|---|---|
| main / gitsafe-backup/main | afe1953 | 2026-08-02 | — (is main) |
| origin/main | adb2342 | 2026-08-02 | yes, tree IDENTICAL to HEAD (`git diff` empty) |
| replit-agent | 79f2b01 | 2026-08-02 | NO — 5 parallel "Published your App" commits, but tree hash `98490c4…` identical to main's; zero content |
| hotfix-h1-oauth-host | adb2342 | 2026-08-02 | yes, tree identical |
| cutover-l2-legacy-addresses | c4807f6 | 2026-08-02 | yes |
| bundle-2-verification-v1 | 148a2a3 | 2026-08-01 | yes |
| bundle-2-base-path | 9b3dedd | 2026-08-01 | yes |
| bundle-1-url-centralization | 161b80e | 2026-08-01 | yes |
| store-first-discovery-longtail | d3dfaeb | 2026-07-29 | yes |
| snapshot-2026-07-30 | 9cd17f3 | 2026-07-23 | yes |
| claude/google-ad-transparency-scraper-tzi7js | fdd5b27 | 2026-07-20 | yes |

- Remotes: `origin` (github.com/MichaelMobupps/Ad-Library-Finder) and `gitsafe-backup`
  (git://gitsafe:5418/backup.git); both at trees identical to HEAD.
- Tags: none. Stashes: none. `git fsck --lost-found`: **zero dangling/unreachable commits**.
- main: 162 commits, 2026-05-14 → 2026-08-02; 119 are "Published your App" deploy markers.
- Quiet windows on main (May 29–Jun 1, Jun 5–Jun 20, Jun 22–Jul 19): `git log --all` over each
  window is EMPTY — no ref anywhere advanced while main sat still. June work arrived as zip
  bundles applied in-place then committed same day (see Phase 4).

### Phase 2 — maximal content search

Directional `git diff <ref> HEAD` (deletions = lines the ref holds that HEAD lacks — all refs
being ancestors, these are lines later main commits deliberately superseded):
bundle-1 224 / bundle-2-base-path 311 / bundle-2-verification-v1 299 / claude-scraper 967 /
cutover-l2 32 / snapshot-2026-07-30 701 / store-first 183 / hotfix-h1, replit-agent,
origin/main, gitsafe-backup/main: 0 (identical trees).

Path set: 371 paths ever existed on any ref; 210 at HEAD; **161 absent, all five deleting
commits identified, all deliberate**:

| deleting commit | date | paths | nature |
|---|---|---|---|
| b1c124e "Promote nested project to workspace root" | 2026-05-19 | 137 | restructure: `ad-library-finder/*`, `lib/*`, `artifacts/mockup-sandbox/*`, scaffolding |
| 453a47f (publish) | 2026-05-22 | 21 | `source-code/src/**` mirror reorganized (mirror is generated by `scripts/sync-source-code.sh`) |
| 6d3d126 "Update the target configuration file" | 2026-05-19 | 1 | `ad-library-finder-target.replit.txt`, message states the deletion |
| 3b61569 "Store-first discovery…" | 2026-07-25 | 1 | `artifacts/dashboard/src/=355` — junk shell-redirect file |
| 99b8331 (publish) | 2026-07-26 | 1 | `GoogleAdsForm.tsx` → **rename** to `NewJobForm.tsx` (59% similarity, `git show -M`) |

Full 161-path list: see `git log --all --pretty=format: --name-only | sort -u` minus
`git ls-tree -r HEAD --name-only` (verified 2026-08-05; groups above are exhaustive).

Peak-line-count check over every .ts/.tsx at HEAD vs its maximum on any ref — two files
below peak, both proven same-commit extractions, not losses:
- `App.tsx` 1149 (bae484e Jul 25) → 785 at 84fed16, which CREATED `GoogleAdsForm.tsx` (+592)
  and `countries.ts` (+175) in the same diff; now 861.
- `api-server/src/index.ts` 177 (9b3dedd Aug 1) → 50 at c4807f6, which CREATED `app.ts` (+203)
  in the same diff.

Fix/feature commits spot-checked present at HEAD: store-first pipeline
(`storeDiscoveryPipeline.ts`), export cap 20/50/100/all (`csv.ts:260`, `routes-jobs.ts:509`),
Excel (`xlsxWriter.ts`), geo-aware markets (`storeDiscoveryConfig.ts`), LLM daily cap
(`llmBudget.ts`), injection hardening (`promptSafety.ts`), L2 legacy redirects (`app.ts`),
H1 OAuth (`oauth.ts`), per-user job guard (`routes-jobs.ts:446,567` — strengthened with admin
override).

### Phase 3 — what is actually deployed

- Newest deploy marker: **afe1953, 2026-08-02 19:37:57, Replit-Commit-Deployment-Build-Id
  `bd5e206b-3827-4685-a19d-ce178899e37e`** — and its tree is HEAD's tree.
- Live `/version` via both gateway addresses returns `builtAt: 2026-08-02T19:38:08.463Z` —
  the running process booted **11 seconds after** that publish commit and has not restarted.
- **Frontend proven byte-identical to HEAD**: live asset `index-B81CehsM.js` SHA-256
  `9441e749…aac083` == fresh `vite build` of HEAD with `BASE_PATH=/leadfinder` (built to a
  scratch dir 2026-08-05). CSS `index-56p_R0TC.css` filename-hash also matches. The two
  artifacts (dashboard, api-server) are built by one `pnpm build` in one deploy image (one
  Build-Id), and the process serving that byte-identical dist IS the api-server — no
  frontend-newer-than-server split exists.
- No dist/build output is committed to git (only `tsconfig.tsbuildinfo`, a tsc cache).
- **NEW FINDING (operational, not content loss): `https://leadfindermobupps.replit.app` now
  returns Replit's "This app isn't live yet" 404.** O-12's premise ("the .replit.app address
  keeps serving directly after the cutover") no longer holds at the HOST level — every
  legacy emailed link pointing at the old address dies before reaching the app's L2 redirect
  layer. Gateway addresses (`tools.mobupps.net/leadfinder`,
  `mobupps-tools-gateway.replit.app/leadfinder`) are live and healthy.
- Env vars that could mimic a rollback if set in production Secrets (values are NOT readable
  from the repo — check the Reserved VM's Secrets pane): `GOOGLE_ADS_MAX_ADVERTISERS`,
  `GOOGLE_ADS_MAX_LOOKUPS`, `GOOGLE_ADS_DEFAULT_MAX_KEYWORDS`, `GOOGLE_ADS_WEB_MAX_SEARCHES`,
  `MAX_PAGES_PER_QUERY`, `APPGOBLIN_COMPANIES_PER_JOB`, `QUEUE_MAX_CONCURRENT_JOBS`,
  `LLM_DAILY_CAP_USD`, `STORE_*` budget/cap family (~30 vars), `AFFPLUS_*` page/search caps,
  `AFFPLUS_WEB_SEARCH_MODEL`, `STORE_EXPORT_CONFIRMED_ONLY`, `GOOGLE_ADS_MOBILE_CREATIVE_FORMAT`.

### Phase 4 — time-capsule reconstruction (bundle inventory + diffs)

| bundle | date | contents |
|---|---|---|
| attached_assets/ad-library-finder_1779210451890.zip | May 19 | original nested scaffold |
| attached_assets/ad-library-finder_1779214975292.zip / ad-library-finder.zip | May 19 | same, later same day |
| attached_assets/affplus-cps-web-batch_1780002444875.zip | May 28 | 6 src files + CHANGES |
| .ship-backup/{20260528-210810,20260528-221851,dashboard-20260528-213140} | May 28 | pre-apply backups |
| attached_assets/email-recipient-audit-fixes_1780006716220.zip | May 28 | settings/notifier |
| injection-hardening.zip + _ih_patch/ + _ih_backup-20260604-190438/ | Jun 4 | 4 src files + apply.sh |
| llm-daily-cap-bundle.zip + payload.zip + .llmcap-backup/20260621-130207/ | Jun 21 | 9 src files |

**There are NO July bundle archives in this repo** — the July work (GATC engine Jul 20,
store-first rebuild Jul 25–29) lives only in git, on branches all merged into main.

Newest pre-migration bundle, payload.zip (Jun 21), diffed against HEAD: HEAD is a strict
superset for 7 of 9 files; `hqSplit.ts` and `llmBudget.ts` are **byte-identical** at HEAD.
Residual bundle-only lines are renamed imports/superseded logic (e.g. `getNextPendingJob` →
cap-aware dispatch, `queue.ts:134` still gates on `spentTodayUsd() >= DAILY_CAP_USD`).
Jun 4 bundle: `promptSafety.ts` byte-identical; classifier/csv/hqResolver superseded by the
July rebuild. May 28 bundle: `webPolicy.ts` byte-identical; ownership guard survives
strengthened. No function, constant, route or guard from any bundle is absent or reverted
at HEAD.

### Phase 5 — symptom anchors (Leadfinder)

Every value the controlling constants have ever held, all refs (`git log --all -p -S`):

| constant | file:line | history | today = newest? |
|---|---|---|---|
| GOOGLE_ADS_MAX_ADVERTISERS | googleAdsPipeline.ts:86 | 1000 since 797addd (Jul 20), never changed | yes — never changed ⇒ rollback disproved for this symptom |
| GOOGLE_ADS_MAX_LOOKUPS | googleAdsPipeline.ts:83 | 60 (Jul 20) → **100** (dcb24d5 Jul 23) | yes — current is the raised value |
| GOOGLE_ADS_DEFAULT_MAX_KEYWORDS | googleAdsPipeline.ts:88 | 40 since Jul 20, never changed | yes |
| APPGOBLIN_COMPANIES_PER_JOB | appgoblinScraper.ts:50 | 10 since May 25, never changed | yes |
| MAX_PAGES_PER_QUERY | scraper.ts:15 | 5 since May 19, never changed | yes |

- Discovery limits / keyword sets / country lists / enrichment budgets: single constants file
  `storeDiscoveryConfig.ts` (spec CONSTRAINT #3), last changed c3f5c2b **Jul 26** — its
  newest-ever state; `googleAdsKeywords.ts` last changed 3b61569 **Jul 25** — newest-ever.
  `ALL_MARKETS` (130+ geos) + `DEFAULT_ACTIVE_MARKETS` (12-market core) present as designed.
- July Google Ads engine rebuild present at HEAD: 3b61569 (“replacing GATC as the discovery
  engine”), ad48557, f8cff4d, 5c85422, bae484e are all ancestors of HEAD.
- `git diff d3dfaeb HEAD` (last July commit → HEAD) touches ONLY URL/OAuth/BASE_PATH plumbing
  (app.ts, urls.ts, oauth.ts, auth.ts, notifier.ts links, routes-auth.ts, config.ts, main.tsx,
  api/client.ts, index.ts, App.tsx 4 lines). Zero pipeline, discovery, keyword, country,
  enrichment or queue files changed after Jul 29 ⇒ pipeline stages at HEAD are the newest.

### What the repo cannot prove, and what would settle it

1. `/version` carries no commit hash (only process start time). Stamping `GIT_SHA` at build
   into `/version` would make future audits one curl. Settled today instead by the frontend
   SHA-256 byte-match + the 11-second publish→boot chain.
2. Production Secrets values (the cap/limit env vars above) are unreadable from the repo. If
   behaviour still looks "old", the Reserved VM's Secrets pane is the next place to look —
   a low `GOOGLE_ADS_MAX_ADVERTISERS` there would mimic a rollback exactly.

---

## P-D3 — Were these bugs ever fixed before? (2026-08-05)

Blast radius: read-only over the git object database (all refs, reflog, fsck) and
app source; wrote exactly two files — `diagnostic.md` (full report, repo root) and
this entry. No DB rows, secrets, deploys, workflows, email or scraping touched.

Verdict: **no confirmed rollback** — of the 3 bug fixes since 2026-07-28,
2 × (a) never existed before (c50fc24 SEGMENT/userinfo validation, 148a2a3
exact-pathname prefix check), 1 × (c) existed and evolved (adb2342 H1: env-first
redirect URI existed in 1399d18, deliberately demoted by 4cbfba0 May 22, restored
Aug 2 — continuous authored lineage, not a rollback). Apollo/contact-cap concepts:
never existed on any ref. Full evidence tables: `diagnostic.md`.
