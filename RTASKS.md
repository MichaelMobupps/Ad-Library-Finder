# RTASKS — running task record

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
