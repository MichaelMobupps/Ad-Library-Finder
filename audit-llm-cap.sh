#!/usr/bin/env bash
# ===========================================================================
# audit-llm-cap.sh
#
# One script, three phases, run one after the other:
#   1. AUDIT       — assert the LLM-daily-cap correctness invariants over the
#                    deployed code in artifacts/api-server/src. PASS/FAIL.
#   2. BLAST RADIUS — report what the change touches and surface ripple risks.
#                    INFO/WARN only; never fails the run.
#   3. SMOKE TEST  — run the REAL llmBudget + db modules against a throwaway
#                    SQLite DB in an isolated temp dir. No Anthropic calls, no
#                    production data. PASS/FAIL.
#
# Run from the REPO ROOT (the folder that contains artifacts/ and source-code/):
#   bash audit-llm-cap.sh
#
# Exit 0 only when AUDIT and SMOKE fully pass. Blast-radius warnings do not
# change the exit code; they are printed for the operator.
# ===========================================================================
set -uo pipefail

API_SRC="artifacts/api-server/src"
API_DIR="artifacts/api-server"
MIRROR_SRC="source-code/src"
CHANGED=(llmBudget.ts db.ts classifier.ts hqResolver.ts webResolver.ts hqSplit.ts queue.ts appgoblinPipeline.ts affplusPipeline.ts)

AUDIT_PASS=0; AUDIT_FAIL=0
SMOKE_PASS=0; SMOKE_FAIL=0
WARN=0

c_pass(){ printf '  [PASS] %s\n' "$1"; AUDIT_PASS=$((AUDIT_PASS+1)); }
c_fail(){ printf '  [FAIL] %s\n' "$1"; AUDIT_FAIL=$((AUDIT_FAIL+1)); }
c_warn(){ printf '  [WARN] %s\n' "$1"; WARN=$((WARN+1)); }
c_info(){ printf '  [INFO] %s\n' "$1"; }
hr(){ printf '\n=================================================================\n%s\n=================================================================\n' "$1"; }

# grep helper: PASS if pattern found in file, FAIL otherwise.
need(){ # need <file> <pattern(extended-regex)> <description>
  if [ -f "$1" ] && grep -qE "$2" "$1"; then c_pass "$3"; else c_fail "$3"; fi
}
# negative: PASS if pattern NOT found.
forbid(){ if [ -f "$1" ] && grep -qE "$2" "$1"; then c_fail "$3"; else c_pass "$3"; fi; }

# --- preconditions ---------------------------------------------------------
if [ ! -d "$API_SRC" ]; then
  echo "[FATAL] $API_SRC not found. Run from the repo root (folder with artifacts/ and source-code/)." >&2
  exit 2
fi

# ===========================================================================
hr "PHASE 1 / 3  —  GODLIKE AUDIT  (invariants over $API_SRC)"
# ===========================================================================

echo "-- budget module ($API_SRC/llmBudget.ts) --"
if [ -f "$API_SRC/llmBudget.ts" ]; then c_pass "llmBudget.ts present"; else c_fail "llmBudget.ts present"; fi
need "$API_SRC/llmBudget.ts" "export function assertBudget"        "exports assertBudget()"
need "$API_SRC/llmBudget.ts" "export function recordSpend"         "exports recordSpend()"
need "$API_SRC/llmBudget.ts" "export class BudgetExceededError"    "exports BudgetExceededError"
need "$API_SRC/llmBudget.ts" "export const DAILY_CAP_USD"          "exports DAILY_CAP_USD"
need "$API_SRC/llmBudget.ts" "export function spentTodayUsd"       "exports spentTodayUsd()"
need "$API_SRC/llmBudget.ts" "export function nextJerusalemMidnightMs" "exports nextJerusalemMidnightMs()"
need "$API_SRC/llmBudget.ts" "LLM_DAILY_CAP_USD"                   "cap reads env LLM_DAILY_CAP_USD"
need "$API_SRC/llmBudget.ts" "Asia/Jerusalem"                      "day computed in Asia/Jerusalem"
need "$API_SRC/llmBudget.ts" "web_search_requests"                 "web_search billed in cost math"

echo "-- db layer ($API_SRC/db.ts) --"
need "$API_SRC/db.ts" "CREATE TABLE IF NOT EXISTS llm_spend"       "llm_spend ledger table created"
need "$API_SRC/db.ts" "ADD COLUMN run_after"                       "run_after column migration (idempotent)"
need "$API_SRC/db.ts" "JobStatus =.*'deferred'"                    "JobStatus union includes 'deferred'"
need "$API_SRC/db.ts" "export function deferJob"                   "deferJob() defined"
need "$API_SRC/db.ts" "export function clearJobResults"            "clearJobResults() defined"
need "$API_SRC/db.ts" "status = 'deferred' AND"                    "getNextPendingJob picks deferred-and-due"

echo "-- call-site gates (assert before, record after, re-throw budget) --"
for trip in "classifier.ts:classifier" "hqResolver.ts:hq-resolver" "webResolver.ts:web-resolver"; do
  f="${trip%%:*}"; tag="${trip##*:}"
  need "$API_SRC/$f" "assertBudget\\('$tag'\\)"                    "$f: assertBudget('$tag') gate"
  need "$API_SRC/$f" "recordSpend\\('$tag'"                        "$f: recordSpend('$tag') after call"
  need "$API_SRC/$f" "instanceof BudgetExceededError\\) throw err" "$f: re-throws BudgetExceededError (no swallow)"
done
need "$API_SRC/hqSplit.ts" "instanceof BudgetExceededError\\) throw err" "hqSplit.ts: HQ resolve catch re-throws budget"

echo "-- pipeline defer wiring (HQ catch re-throws, outer catch defers) --"
for p in queue.ts appgoblinPipeline.ts affplusPipeline.ts; do
  need "$API_SRC/$p" "deferJob\\(job.id"                          "$p: defers job on budget signal"
  need "$API_SRC/$p" "instanceof BudgetExceededError\\) throw err" "$p: HQ-split catch re-throws budget"
done

echo "-- anti-duplication on resume --"
need "$API_SRC/appgoblinPipeline.ts" "clearJobResults\\(job.id\\)" "appgoblin clears prior results on resume"
need "$API_SRC/affplusPipeline.ts"   "clearJobResults\\(job.id\\)" "affplus clears prior results on resume"
need "$API_SRC/queue.ts"             "alreadyDone.has\\(ad.landing_url\\)" "meta skip-guard (landing_url) present"
forbid "$API_SRC/queue.ts"           "clearJobResults"             "meta does NOT clear (keeps skip-guard)"
need "$API_SRC/queue.ts"             "spentTodayUsd\\(\\) >= DAILY_CAP_USD" "queue holds dispatch while over cap"

echo "-- scoped typecheck gate (errors only in changed files = FAIL) --"
if command -v pnpm >/dev/null 2>&1; then EXEC="pnpm exec"; else EXEC="npx"; fi
TSC_LOG="$(mktemp)"
( cd "$API_DIR" && ${EXEC} tsc --noEmit ) > "$TSC_LOG" 2>&1
NAMES="llmBudget|db|classifier|hqResolver|webResolver|hqSplit|queue|appgoblinPipeline|affplusPipeline"
MINE="$(grep -E "(^|[/])(${NAMES})\.ts\(" "$TSC_LOG" || true)"
if [ -n "$MINE" ]; then
  c_fail "typecheck: errors in changed files:"; echo "$MINE" | sed 's/^/        /'
else
  if [ -s "$TSC_LOG" ] && grep -qE "error TS" "$TSC_LOG"; then
    c_pass "typecheck: no errors in changed files (pre-existing baseline in untouched files ignored)"
  else
    c_pass "typecheck: clean"
  fi
fi
rm -f "$TSC_LOG"

# ===========================================================================
hr "PHASE 2 / 3  —  BLAST RADIUS"
# ===========================================================================

echo "-- surface area --"
c_info "Files changed (${#CHANGED[@]}): ${CHANGED[*]}"
c_info "DB objects added: table llm_spend; jobs.run_after column; status/phase value 'deferred'"
c_info "Cap is one GLOBAL pool across all users/jobs; one heavy job can defer others until Jerusalem midnight (by design)."
c_info "Correctness assumes the existing single-worker model; horizontal scaling would weaken the cap (and already breaks the queue)."
c_info "llm_spend has no TTL; it grows one row per LLM call. Queries stay fast via the spend_day index. Prune later if desired."

echo "-- mirror drift (active vs source-code review copy) --"
if [ -d "$MIRROR_SRC" ]; then
  drift=0
  for f in "${CHANGED[@]}"; do
    if [ -f "$API_SRC/$f" ] && [ -f "$MIRROR_SRC/$f" ]; then
      if ! diff -q "$API_SRC/$f" "$MIRROR_SRC/$f" >/dev/null 2>&1; then c_warn "drift: $f differs between active and source-code mirror"; drift=$((drift+1)); fi
    elif [ ! -f "$MIRROR_SRC/$f" ]; then
      c_warn "drift: $f missing from $MIRROR_SRC (not yet mirrored)"; drift=$((drift+1))
    fi
  done
  [ "$drift" -eq 0 ] && c_info "active source and source-code mirror are in sync for all changed files."
else
  c_info "$MIRROR_SRC not present; skipping mirror-drift check."
fi

echo "-- downstream consumers of the new state --"
DASH="artifacts/dashboard"
if [ -d "$DASH" ]; then
  if grep -rqiE "deferred" "$DASH/src" 2>/dev/null || grep -rqiE "deferred" "$DASH" 2>/dev/null; then
    c_info "dashboard references 'deferred' — it likely renders the new state."
  else
    c_warn "dashboard ($DASH) has no reference to 'deferred'. A deferred job may render with no label/badge until the UI adds one."
  fi
else
  c_info "no $DASH dir found; cannot check dashboard rendering of 'deferred'."
fi
sc="$(grep -rlE "\.status|\.phase" "$API_SRC" 2>/dev/null | grep -vE "routes-health|storePageFetcher|appgoblinScraper|scraper.ts" | tr '\n' ' ')"
c_info "reads job status/phase (verify none assume exactly 4 statuses): ${sc:-none}"
rc="$(grep -rlE "getResults\(" "$API_SRC" 2>/dev/null | tr '\n' ' ')"
c_info "builds deliverables from job_results (covered by clearJobResults / skip-guard): ${rc:-none}"

# ===========================================================================
hr "PHASE 3 / 3  —  SMOKE TEST  (real modules, throwaway DB, no LLM)"
# ===========================================================================

# resolve a tsx runner
TSX=""
if command -v tsx >/dev/null 2>&1; then TSX="tsx"
elif [ -x "$API_DIR/node_modules/.bin/tsx" ]; then TSX="$(cd "$API_DIR" && pwd)/node_modules/.bin/tsx"
elif [ -x "node_modules/.bin/tsx" ]; then TSX="$(pwd)/node_modules/.bin/tsx"
elif command -v pnpm >/dev/null 2>&1 && pnpm exec tsx --version >/dev/null 2>&1; then TSX="pnpm exec tsx"
elif command -v npx >/dev/null 2>&1; then TSX="npx -y tsx"
fi

if [ -z "$TSX" ]; then
  printf '  [FAIL] could not locate a tsx runner. Install with: npm i -D tsx  (then re-run)\n'
  SMOKE_FAIL=1
else
  BUDGET_MOD="$(cd "$API_SRC" && pwd)/llmBudget.ts"
  DB_MOD="$(cd "$API_SRC" && pwd)/db.ts"
  SMOKE_TMP="$(mktemp -d /tmp/llmcap-smoke.XXXXXX)"
  echo '{"type":"module"}' > "$SMOKE_TMP/package.json"

  cat > "$SMOKE_TMP/smoke.ts" <<'SMOKE_EOF'
import { pathToFileURL } from 'node:url';

(async () => {
  let pass = 0, fail = 0;
  const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log((c ? '  [PASS] ' : '  [FAIL] ') + m); };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  const budget: any = await import(pathToFileURL(process.env.SMOKE_BUDGET_MOD as string).href);
  const db: any = await import(pathToFileURL(process.env.SMOKE_DB_MOD as string).href);

  // 0. schema bootstrap in the isolated temp dir (DB lands in ./data here)
  await db.initDb();
  ok(true, 'initDb() built schema in isolated temp DB (' + process.cwd() + ')');

  // 1. cost math (exact, per verified pricing)
  ok(near(budget.costUsd('claude-sonnet-4-5', { input_tokens: 1_000_000 }), 3),  'cost: 1M input  = $3.00');
  ok(near(budget.costUsd('claude-sonnet-4-5', { output_tokens: 1_000_000 }), 15), 'cost: 1M output = $15.00');
  ok(near(budget.costUsd('claude-sonnet-4-5', { cache_creation_input_tokens: 1_000_000 }), 3.75), 'cost: 1M cache-write = $3.75');
  ok(near(budget.costUsd('claude-sonnet-4-5', { cache_read_input_tokens: 1_000_000 }), 0.30), 'cost: 1M cache-read = $0.30');
  ok(near(budget.costUsd('claude-sonnet-4-5', { server_tool_use: { web_search_requests: 1 } }), 0.01), 'cost: 1 web_search = $0.01');
  ok(near(budget.costUsd('unknown-model', { input_tokens: 1_000_000 }), 3), 'cost: unknown model falls back to sonnet rate (not free)');

  // 2. Jerusalem day + next-midnight
  ok(/^\d{4}-\d{2}-\d{2}$/.test(budget.jerusalemDay()), 'jerusalemDay() is YYYY-MM-DD');
  const now = Date.now();
  const nm = budget.nextJerusalemMidnightMs();
  ok(nm > now && nm <= now + 26 * 3600 * 1000, 'nextJerusalemMidnightMs() is in (now, now+26h]');
  ok(budget.jerusalemDay(new Date(nm)) !== budget.jerusalemDay(new Date(now)), 'next-midnight is a new Jerusalem day');

  // 3. cap is the test value (set via env to 5 for determinism)
  ok(budget.DAILY_CAP_USD === 5, 'DAILY_CAP_USD honours env (=5 for smoke)');

  // 4. ledger + gate threshold
  ok(near(budget.spentTodayUsd(), 0), 'spentTodayUsd() starts at 0');
  let threw = false; try { budget.assertBudget('smoke'); } catch { threw = true; }
  ok(!threw, 'assertBudget passes at $0');
  const c1 = budget.recordSpend('smoke', 'claude-sonnet-4-5', { input_tokens: 1_000_000 }); // +$3
  ok(near(c1, 3) && near(budget.spentTodayUsd(), 3), 'recordSpend +$3 -> today=$3');
  threw = false; try { budget.assertBudget('smoke'); } catch { threw = true; }
  ok(!threw, 'assertBudget still passes at $3 (< $5)');
  budget.recordSpend('smoke', 'claude-sonnet-4-5', { input_tokens: 1_000_000 }); // +$3 -> $6 >= cap
  ok(near(budget.spentTodayUsd(), 6), 'today=$6 after second record');
  threw = false; let cap = -1; try { budget.assertBudget('smoke'); } catch (e: any) { threw = e instanceof budget.BudgetExceededError; cap = e.capUsd; }
  ok(threw && cap === 5, 'assertBudget THROWS BudgetExceededError at/over cap (capUsd=5)');

  // 5. spend on a different Jerusalem day is ignored by today's sum
  db.getDb().prepare(
    'INSERT INTO llm_spend (ts,spend_day,source,model,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,web_searches,usd) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(Date.now(), '1999-01-01', 'smoke', 'm', 0, 0, 0, 0, 0, 999);
  ok(near(budget.spentTodayUsd(), 6), 'spend tagged to another day does not count toward today');

  // 6. defer / resume state machine
  const jid = 'smoke-' + Date.now();
  db.createJob({ id: jid, productType: 'mobile', countries: ['US'], createdByUserId: 'smoke-user' });
  ok(db.getJob(jid)?.status === 'pending', 'createJob -> pending');
  ok(db.getNextPendingJob()?.id === jid, 'pending job is runnable');
  db.deferJob(jid, Date.now() + 3_600_000, 'smoke defer future');
  ok(db.getJob(jid)?.status === 'deferred', 'deferJob -> status deferred');
  ok(db.getNextPendingJob() === null, 'deferred + future run_after is NOT runnable');
  db.deferJob(jid, Date.now() - 1000, 'smoke defer due');
  ok(db.getNextPendingJob()?.id === jid, 'deferred + past run_after IS runnable (resumes)');
  db.markJobRunning(jid);
  ok(db.getJob(jid)?.status === 'running', 'markJobRunning -> running');
  ok(db.getNextPendingJob() === null, 'running job is not re-dispatched');

  // 7. clearJobResults wipes partial rows (anti-duplication on resume)
  const row = { job_id: jid, advertiser_name: 'A', page_url: null, landing_url: 'https://x', classification: 'cps_web', store_url: null, ad_text: 't', country: 'US' };
  db.insertResult(row); db.insertResult({ ...row, landing_url: 'https://y' });
  ok(db.getResults(jid).length === 2, 'insertResult x2 -> 2 rows');
  db.clearJobResults(jid);
  ok(db.getResults(jid).length === 0, 'clearJobResults -> 0 rows');

  console.log('\n  smoke summary: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  [FAIL] smoke harness crashed:', e?.message || e); process.exit(1); });
SMOKE_EOF

  echo "  runner: $TSX   (cap forced to \$5, DB isolated to $SMOKE_TMP/data)"
  if ( cd "$SMOKE_TMP" && LLM_DAILY_CAP_USD=5 SMOKE_BUDGET_MOD="$BUDGET_MOD" SMOKE_DB_MOD="$DB_MOD" $TSX "$SMOKE_TMP/smoke.ts" ); then
    SMOKE_PASS=1
  else
    SMOKE_FAIL=1
  fi
  rm -rf "$SMOKE_TMP"
fi

# ===========================================================================
hr "VERDICT"
# ===========================================================================
printf '  AUDIT:       %d passed, %d failed\n' "$AUDIT_PASS" "$AUDIT_FAIL"
printf '  BLAST RADIUS: %d warning(s) to review\n' "$WARN"
if [ "${SMOKE_PASS:-0}" -eq 1 ]; then printf '  SMOKE:       passed\n'; elif [ "${SMOKE_FAIL:-0}" -eq 1 ]; then printf '  SMOKE:       FAILED\n'; else printf '  SMOKE:       not run\n'; fi

if [ "$AUDIT_FAIL" -eq 0 ] && [ "${SMOKE_FAIL:-0}" -eq 0 ] && [ "${SMOKE_PASS:-0}" -eq 1 ]; then
  printf '\n  RESULT: PASS — cap, defer/resume, anti-duplication, and accounting verified.\n'
  exit 0
else
  printf '\n  RESULT: FAIL — see [FAIL] lines above.\n'
  exit 1
fi
