# P-D3 — Were these bugs ever fixed before? (2026-08-05)

Read-only diagnostic. No code, database rows or secrets were changed; nothing was
committed, deployed or published. The only files written by this order are this
report and a blast-radius entry in TODO.md.

## Headline (order item 8)

**No confirmed rollback. Zero fixes land in category (b).**

One fix — H1 (`adb2342`) — satisfies the *letter* of category (b): the behaviour it
restores (PUBLIC_BASE_URL decides the OAuth redirect URI) existed in the very first
OAuth commit `1399d18` (2026-05-19) and was removed by `4cbfba0` (2026-05-22). It is
still not a rollback, on evidence: `4cbfba0` is an authored, in-ancestry commit whose
diff documents its reason ("guarantees the URI matches the origin the user is on,
even if PUBLIC_BASE_URL is …"), every intermediate version is reachable on main with
no reset anywhere (`git fsck`: zero unreachable commits), and the bug H1 fixed —
`redirect_uri_mismatch` behind the gateway — could not occur before the gateway
topology existed (cutover 2026-08-02). A fix for *this* bug never existed earlier and
never disappeared. Classified (c) EXISTED AND EVOLVED, with both hashes named above
so the reader can apply the (b) test themselves.

## 1. Blast radius

- Read: git object database across all refs (`git log --all`, `-S`, `fsck`), files
  under `artifacts/api-server/src/`, `artifacts/dashboard/src/`, TODO.md.
- Written: `diagnostic.md` (this file), one entry in TODO.md. Nothing else.
- Not touched: database (`data/ad-library.sqlite`), secrets, the running deployment,
  any workflow, any email or scraping path.

## 2. Every non-platform commit since 2026-07-28 (all refs)

There are 12 platform commits ("Published your App", author Replit Agent) in the
window; the 8 human commits, all by hwholestorm, all on 2026-08-01/02:

| hash | date | subject | class |
|---|---|---|---|
| 76ab08f | Aug 1 07:02 | Bundle 1 setup: ROADMAP.md, TODO.md sections | reporting/docs |
| e67bd06 | Aug 1 07:14 | Bundle 1: centralize URL and rooted paths into one config module | migration |
| c50fc24 | Aug 1 07:22 | Bundle 1 audit round 1: tighten BASE_PATH and PUBLIC_URL validation | **bug fix** (hardening of same-morning code) |
| 161b80e | Aug 1 07:24 | Bundle 1 ledger | reporting/docs |
| 9b3dedd | Aug 1 08:30 | Bundle 2: serve the app under BASE_PATH, inert while unset | migration |
| 148a2a3 | Aug 1 16:44 | Verification order V1 … fix a doubled-slash public base | **bug fix** (plus ritual docs) |
| c4807f6 | Aug 2 18:29 | L2: keep legacy addresses alive once the prefix is on | migration (pre-emptive compat) |
| adb2342 | Aug 2 19:07 | H1: make PUBLIC_BASE_URL authoritative for the OAuth redirect URI | **bug fix** (live sign-in outage) |

## 3. What each fix actually changed

**c50fc24** — in `artifacts/api-server/src/urls.ts`: added
`const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/` and a per-segment
allowlist throw inside `normalizeBasePath`; added a userinfo guard
(`if (parsed.username || parsed.password) throw new UrlConfigError(...)`) inside
`normalizePublicUrl`. Mirrored `SEGMENT`/`BasePathError` in
`artifacts/dashboard/src/config.ts`.

**148a2a3** — in `urls.ts`, `assertPublicUrlCarriesPrefix`: comparison changed from
`parsed.pathname.replace(/\/+$/, '') !== prefix` to exact `parsed.pathname !== prefix`
(the trailing-slash forgiveness was the hole: `.../leadfinder//` passed the check but
`buildPublicUrl` concatenation then emitted links no mount matches).

**adb2342 (H1)** — in `oauth.ts`: redirect-URI derivation reordered. New first branch
`if (PUBLIC_URL) return publicUrl(OAUTH_CALLBACK_PATH);` before any header
derivation; the old header-first path (`x-forwarded-proto`/`x-forwarded-host` → host
header → PUBLIC_URL fallback) preserved verbatim for the PUBLIC_BASE_URL-unset case.

## 4. Full-history symbol traces (`git log --all -S`, every ref; tags: none exist; unreachable commits: none exist per `git fsck --lost-found`)

| symbol | every commit that ever added/removed it | first entered |
|---|---|---|
| `SEGMENT` regex | c50fc24 only | 2026-08-01 |
| `parsed.username` guard | c50fc24; earlier hit d6a3bce (Jul 20) is `redactProxy()` in `googleAdsScraper.ts` — proxy-credential log redaction, different behaviour, still at HEAD | 2026-08-01 (as a validation guard) |
| `normalizeBasePath` | e67bd06, c50fc24 | 2026-08-01 |
| `normalizePublicUrl` | e67bd06, c50fc24, 9b3dedd, 148a2a3 | 2026-08-01 |
| `UrlConfigError` | e67bd06, c50fc24, 9b3dedd | 2026-08-01 |
| `assertPublicUrlCarriesPrefix` | 9b3dedd, 148a2a3, adb2342 | 2026-08-01 |
| `publicUrl()` (builder) | e67bd06 | 2026-08-01 |
| trailing-slash strip `replace(/\/$/,'')` | continuous: 1de22a6 (May 14), 1399d18 (May 19) … still present inside `normalizePublicUrl` | 2026-05-14 |
| `OAUTH_CALLBACK_PATH` | e67bd06, adb2342 | 2026-08-01 |
| `getRedirectUriFromReq` (header-first) | 4cbfba0/227d19d/453a47f (May 22), 148a2a3, adb2342 | 2026-05-22 |
| env-only `getRedirectUri()` | 1399d18 (May 19); removed by 4cbfba0 (May 22) | 2026-05-19 |
| `x-forwarded-host` | 4cbfba0-era (May 22) → present ever since | 2026-05-22 |
| `legacyRedirect` | c4807f6 only | 2026-08-02 |
| `BASE_PATH` (app mechanism) | e67bd06/c50fc24/9b3dedd/…; the May 14 `1de22a6` hit is the deleted `artifacts/mockup-sandbox` scaffold's unrelated `BASE_PATH="/__mockup"` — name collision, not prior behaviour | 2026-08-01 |

## 5–7. Classification of every fix

| fix | classification | evidence |
|---|---|---|
| c50fc24 — SEGMENT allowlist + userinfo guard | **(a) NEVER EXISTED BEFORE** | Host module `urls.ts` born e67bd06 the same morning; `-S` over all refs finds no earlier commit containing the regex, the guard, or any equivalent BASE_PATH/PUBLIC_URL validation under any name. No commit anywhere ever contained this behaviour. |
| 148a2a3 — exact-pathname prefix check | **(a) NEVER EXISTED BEFORE** | `assertPublicUrlCarriesPrefix` born 9b3dedd seven hours earlier; fixed the same day. No earlier commit on any ref contains the check or an equivalent. (The trailing-slash *strip* is a separate, continuous lineage since 1399d18 and never vanished.) |
| adb2342 — H1, PUBLIC_BASE_URL-first redirect URI | **(c) EXISTED AND EVOLVED** (letter-of-(b) near-miss, see Headline) | Lineage, fully continuous, no gap, no reset: 1399d18 (May 19, env-ONLY `requireEnv('PUBLIC_BASE_URL')`) → 4cbfba0 (May 22, deliberate demotion to fallback, rationale in diff) → bad0381 (May 22, "Priority (PRESERVED from prior fix)") → e67bd06 (Aug 1, routed through urls.ts, order kept) → adb2342 (Aug 2, env promoted to first, header path retained for env-unset). Every version reachable from main; nothing lost. |

**Counts: (a) never existed before = 2, (b) existed and vanished = 0, (c) existed and evolved = 1.**

Migration commits' new symbols (`legacyRedirect`, BASE_PATH serving, `publicUrl`)
each have single-origin lineages in the same window — none existed before, none
replaced a vanished predecessor.

## 6. The three named behaviours

**Maximum contacts fetched per company.** No commit anywhere on any ref ever
contained `apollo`, `Apollo` or `APOLLO` (`git log --all -S` for each: empty), and no
per-company contact cap has ever existed in this app — this is a Prospector concept;
this repo is Leadfinder. The only `contacts` hits (3b61569, Jul 25) are publisher
contact-email fields in the store-first pipeline. Nearest real analog:
`LEAD_LIMIT_CHOICES` (export cap 20/50/100/all), born bae484e (Jul 25), evolved
3917979 → e67bd06, present at HEAD (`csv.ts:260`). No larger earlier value ever
existed or vanished.

**Number of Apollo pages or tiers searched.** Same absence: no Apollo code ever, on
any ref. Nearest analogs, every value each has ever held:
`MAX_PAGES_PER_QUERY` default 5 — one value since b1c124e (May 19), never changed.
`AFFPLUS_PAGES_PER_PLATFORM` default 3 — one value since May 22, never changed;
`AFFPLUS_WEB_PAGES_PER_COUNTRY` defaults to it since 605d894 (May 28).
`GOOGLE_ADS_MAX_ADVERTISERS` 1000 since 797addd (Jul 20), never changed.
`GOOGLE_ADS_MAX_LOOKUPS` 60 (Jul 20) → 100 (dcb24d5, Jul 23) — raised, current is the
newest. Nothing was ever lowered or reverted.

**What the progress percentage counts.** `progress_pct` + `setJobProgress` were born
in 9ccb691 (Jul 26) and have never been altered since (the only later `-S` hits,
9b3dedd and 161b80e, are TODO.md prose). Semantics at HEAD (`db.ts:67-73`): 0–100
across EVERY weighted pipeline phase (charts, crawls, enrichment, confirmation, CSV,
HQ split), monotonic (takes MAX), reset to 0 by `markJobRunning`, pinned to 100 by
`markJobCompleted`. Writers: `queue.ts:216` (scrape phase = 0–50% by queries done),
`queue.ts:281` (classification = 50–90% by `classified/collected`), `queue.ts:289`
(90% before CSV/HQ close-out), `storeDiscoveryPipeline.ts:183` (weighted spans).
Before Jul 26 no stored percentage existed anywhere on any ref — only done/total log
lines (7486029, May 25) and a log-only `onProgress(done, total, found)` callback
(797addd, Jul 20). The current semantics is the first and only progress percentage
this app has ever had; no earlier semantics vanished.

## Standard-of-proof notes

- "All refs" = every local and remote branch (11), the reflog, stashes (none) and
  tags (none); `git fsck --lost-found` reports zero dangling/unreachable commits, so
  no search could have missed an orphaned fix.
- Author attribution: platform commits are `Replit Agent <agent@replit.com>`; the
  May-era working commits are `michael2502`; the Aug 1–2 fixes are `hwholestorm`.
