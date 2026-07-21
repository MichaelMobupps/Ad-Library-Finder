# RTASKS — running task record

## 2026-07-21 (round 2) — post-key audit + placeholder-proxy guard

Trigger: first production job scraped 0 ads. Root cause was NOT the monitor — the
`GOOGLE_ADS_PROXY_URL` secret still contained the literal `HOST:PORT` placeholder, the
scraper silently fell back to direct egress, and Google penalty-boxed the deploy IP.
`PROXY_SELLER_API_KEY` was then added to Secrets; full rebuild + re-audit + auto-fix ran.

| # | Task | Status | Outcome |
|---|------|--------|---------|
| 1 | Rebuild (`tsc`) + unit tests | ✅ done | Clean; 25/25 (was 21 — see fixes) |
| 2 | Permanent smoke script | ✅ done | `scripts/smoke-proxy-traffic.mjs` — 21 mocked checks + `--live` mode |
| 3 | Godlike audit — correctness (subagent) | ✅ done | 2 MED, 1 LOW — all fixed |
| 4 | Godlike audit — blast radius (subagent) | ✅ done | 1 HIGH, 2 LOW — all fixed |
| 5 | Auto-fix + re-verify | ✅ done | 25 unit + 21 smoke + typecheck green; mutation re-test now CATCHES the filter deletion (2 fails); mirrors re-synced (incl. `googleAdsScraper.ts`) |

### Round-2 findings → resolutions

**Fixed:**
- HIGH (blast): set-but-unusable `GOOGLE_ADS_PROXY_URL` silently degraded to direct egress
  (warn logged once per process, then cached-null forever) → new `assertProxyUrlUsable()`
  in `googleAdsScraper.ts`, called first in the job try-block: placeholder tokens
  (HOST/PORT/USER/PASS as whole words) or unparsable URL ⇒ job fails at start with a
  <200-char config error. Unset remains valid (deliberate direct egress).
- MED (correctness): status-string inactive filter had ZERO effective test coverage —
  mutation testing showed it could be deleted with the suite staying green (dead fixtures
  gave the inactive entry 0 remaining, so the most-remaining sort masked the filter) →
  fixtures restructured so the dead entry is the richest; +1 test for
  `active:false`/`deleted`/`archived` variants. Mutant now fails 2 tests.
- MED (correctness): invalid key / IP-not-allowed / rate-limit were indistinguishable in
  logs (live API returns 200 + `{status:'error',errors:[{message:'Error api key'},…]}`;
  from some vantage points an invalid key instead 301-chains to the HTML homepage) →
  (a) content-type guard before `res.json()` names a non-JSON response "API key likely
  invalid/revoked"; (b) new `extractApiErrors()` surfaces the envelope messages at warn
  level ("Error api key; IP not allowed x.x.x.x"). Both only reroute already-failing
  paths — cannot gate a job. +3 unit tests.
- LOW (correctness): burn report had survivorship bias — only successful jobs logged
  traffic cost → `trafficBefore` hoisted above the try; `logProxyTrafficAfterJob` now
  also runs on the failure AND defer paths (no-op when the monitor is off; the
  exhausted-gate throw leaves `trafficBefore` null so no double fetch).
- LOW (blast): orphan `dist/probe.js` (source deleted in May, tsc never cleans) → deleted.
- LOW (blast): `.env.example` lacked `PROXY_SELLER_API_KEY` / `PROXY_TRAFFIC_WARN_GB` /
  `PROXY_TRAFFIC_ABORT_GB` though the docs said "see .env.example" → documented.
- Docs: `GOOGLE_ADS_INTEGRATION.md` — fail-fast proxy-URL behavior, key-diagnostics,
  IP-allowlist warning, smoke-script usage.

**Verified clean (no action):** mirrors byte-identical pre-fix; dist fresh; Replit deploy
rebuilds from src (`.replit` build runs `pnpm build`, so committed-dist staleness is moot);
git tree clean (Replit auto-commit 14:11 picked up round 1); redirect chain, 10s timeout
across the chain+body, 400 KB HTML body, key-redaction in all error paths — all proven
against the real dist build. `isTrafficMonitorConfigured` has no prod callers (used by the
smoke script's live mode).

### User follow-ups (round 2)
- **BLOCKER for real scraping:** `GOOGLE_ADS_PROXY_URL` secret still has the literal
  `HOST:PORT` placeholder — replace with the real gateway host:port from the
  Proxy-Seller dashboard. Until then every google_ads job now fails FAST with an explicit
  config error (by design, instead of silently scraping 0 ads).
- Proxy-Seller Custom API has an IP allowlist — ensure it's open (deploy IPs rotate),
  else the monitor logs "IP not allowed x.x.x.x" and fails open.
- After fixing the secret + republish: run one job; expect `proxy-traffic: ~10 GB of
  10 GB remaining` at start and a `this job used …` line at the end.
- Google's penalty box on the deploy IP needs its cooldown to lapse before direct-egress
  requests recover (irrelevant once the proxy URL is fixed).

## 2026-07-21 — Proxy GB monitoring (Proxy-Seller residential)

Goal: before each Google Ads job, check remaining residential proxy traffic via the
Proxy-Seller API; warn when low, refuse to start when exhausted; after each job, log
the job's actual traffic cost. Fail-open everywhere; off unless `PROXY_SELLER_API_KEY` is set.

| # | Task | Status | Outcome |
|---|------|--------|---------|
| 1 | `proxyTraffic.ts` — API client, gate, burn report, unit tests | ✅ done | New module in `artifacts/api-server/src/`; 21 offline unit tests pass |
| 2 | Pipeline hook (`googleAdsPipeline.ts`) | ✅ done | Gate is the FIRST statement in the job try-block; burn report before `markJobCompleted()` |
| 3 | Docs (`GOOGLE_ADS_INTEGRATION.md`) | ✅ done | New "Proxy traffic monitor" section with all 3 env vars |
| 4 | Typecheck + mirror to `source-code/src` | ✅ done | `tsc --noEmit` clean; both mirrors diff-clean (re-synced after audit fixes) |
| 5 | Smoke test (mocked network, full fetch path) | ✅ done | 19/19 checks: healthy/low/exhausted/HTTP-500/net-error/garbage/non-JSON/burn-report/renewal/no-key no-op; key redaction verified |
| 6 | Godlike audit — correctness reviewer (subagent) | ✅ done | 1 HIGH, 2 MED, 5 LOW — all fixed or resolved (below) |
| 7 | Godlike audit — blast-radius reviewer (subagent) | ✅ done | 2 HIGH, 2 MED, cosmetic LOWs — all fixed or accepted (below) |
| 8 | Auto-fix confirmed findings + re-verify | ✅ done | 21 unit + 19 smoke + typecheck all green post-fix |
| 9 | Production build (`dist/`) | ✅ done | `npm run build`; `dist/proxyTraffic.js` present, pipeline import compiled in |

### Audit findings → resolutions

**Fixed:**
- HIGH (correctness): multi-package accounts — parser could gate on an expired package entry
  and wrongly abort all jobs. Now collects ALL package candidates, drops entries flagged
  inactive/expired, gates on the most-remaining one (wrongly-running is benign; wrongly-aborting is not).
- HIGH (blast): `source-code/` mirror had a pre-hardening revision of proxyTraffic.ts → re-synced.
- HIGH (blast): `dist/` was stale — `npm start` would silently run without the feature → rebuilt.
- MED (correctness): KB/MB-denominated units could produce a wrongful abort → plausibility
  window (256 MB–100 TiB) on the normalized limit; implausible ⇒ fail-open null.
- MED (blast): gate ran after `clearJobResults()` — a deferred job resuming into an empty
  package wiped its partial results, then hard-failed → gate moved above the wipe.
- LOW ×5 (correctness): blank-string env no longer zeroes thresholds; catch-path redaction is
  throw-proof for non-Error rejections; redact-then-slice (was slice-then-redact, partial key
  leak); `res.body.cancel()` on non-OK responses; self-tests hermetic via injectable thresholds.
- LOW (blast): exhaustion message shortened under 200 chars so the dashboard `phase_detail` shows it whole.

**Accepted as-is (deliberate):**
- Queue churn on exhaustion: N pending google_ads jobs each fail fast (~2s apiece) with the
  same clear message + email. Correct behavior — each would otherwise burn a full retry ladder
  against a dead proxy. Revisit (queue-level pre-gate or defer) only if the noise bothers in practice.
- Worst-case +20s/job latency when the Proxy-Seller API hangs (2 × 10s timeout). Nothing
  consumes phase timing; single-worker queue; harmless.
- API key frozen at module load (same pattern as `GOOGLE_ADS_PROXY_URL`) — key rotation needs a restart.

### Env (new)
- `PROXY_SELLER_API_KEY` — dashboard → Custom API; absent = feature fully off
- `PROXY_TRAFFIC_WARN_GB` (default 1) — warn below
- `PROXY_TRAFFIC_ABORT_GB` (default 0.05) — refuse to start below

### User follow-ups
- Create the API key: Proxy-Seller dashboard → Custom API → add `PROXY_SELLER_API_KEY` to Replit Secrets → republish
- First job with the key set: verify the `proxy-traffic: X of Y remaining` line reads ~10 GB (validates byte-units against the live API; parser tolerates GB-units and fails open on anything else)
- Earlier setup (same day): rotation = "For each request" (account-level), Worldwide list, `GOOGLE_ADS_PROXY_URL` secret set; smoke-test job + first burn-rate reading on Replit still pending
