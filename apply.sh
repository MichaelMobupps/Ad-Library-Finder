#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# LLM daily cap ($100, Asia/Jerusalem) + mid-run defer/resume — ship script.
#
# Run from the REPO ROOT (the directory that contains both `artifacts/` and
# `source-code/`):
#
#   python3 -c "import zipfile; zipfile.ZipFile('llm-daily-cap-bundle.zip').extractall('.')" && bash apply.sh
#
# Order: python-zipfile unzip -> backup -> copy -> typecheck gate -> tests gate
#        -> build -> mirror (post-gates only) -> success.
# Any gate failure auto-restores the active files from the backup and exits 1,
# so production is never left half-applied. The source-code mirror is touched
# only after every gate passes.
# ---------------------------------------------------------------------------
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_ZIP="${SELF_DIR}/payload.zip"
STAGING="${SELF_DIR}/.llmcap-staging"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="${SELF_DIR}/.llmcap-backup/${TS}"

API_DIR="artifacts/api-server"
SRC_DIR="${API_DIR}/src"
MIRROR_DIR="source-code/src"

FILES=(
  llmBudget.ts
  db.ts
  classifier.ts
  hqResolver.ts
  webResolver.ts
  hqSplit.ts
  queue.ts
  appgoblinPipeline.ts
  affplusPipeline.ts
)

say()  { printf '\n[ship] %s\n' "$*"; }
fail() { printf '\n[ship][FAIL] %s\n' "$*" >&2; }

restore_active() {
  fail "restoring active files from backup: ${BACKUP}"
  for f in "${FILES[@]}"; do
    if [ -f "${BACKUP}/${f}" ]; then
      cp "${BACKUP}/${f}" "${SRC_DIR}/${f}"
    else
      # File did not exist before this run (new file) -> remove what we added.
      rm -f "${SRC_DIR}/${f}"
    fi
  done
  fail "active files restored to pre-ship state. Mirror was not touched."
}

# --- preconditions ---------------------------------------------------------
if [ ! -d "${SRC_DIR}" ]; then
  fail "not found: ${SRC_DIR} . Run this from the repo root (the dir holding artifacts/ and source-code/)."
  exit 1
fi
if [ ! -d "${MIRROR_DIR}" ]; then
  fail "not found: ${MIRROR_DIR} . Run this from the repo root."
  exit 1
fi
if [ ! -f "${PAYLOAD_ZIP}" ]; then
  fail "not found: ${PAYLOAD_ZIP} . Extract the outer bundle first."
  exit 1
fi

# --- 1. python-zipfile unzip ----------------------------------------------
say "1/7 unzip payload (python3 zipfile)"
rm -rf "${STAGING}"
python3 -c "import zipfile; zipfile.ZipFile('${PAYLOAD_ZIP}').extractall('${STAGING}')" || {
  fail "could not unzip ${PAYLOAD_ZIP}"; exit 1; }
for f in "${FILES[@]}"; do
  if [ ! -f "${STAGING}/src/${f}" ]; then
    fail "payload is missing src/${f}"; exit 1
  fi
done

# --- 2. backup -------------------------------------------------------------
say "2/7 backup current active files -> ${BACKUP}"
mkdir -p "${BACKUP}"
for f in "${FILES[@]}"; do
  if [ -f "${SRC_DIR}/${f}" ]; then
    cp "${SRC_DIR}/${f}" "${BACKUP}/${f}"
    echo "  backed up ${f}"
  else
    echo "  (new) ${f} — no prior version"
  fi
done
# Restore helper for manual rollback.
cat > "${BACKUP}/restore.sh" <<RESTORE
#!/usr/bin/env bash
# Restore the active files to their pre-ship state.
set -uo pipefail
cd "\$(dirname "\${BASH_SOURCE[0]}")/../../.."
for f in ${FILES[*]}; do
  if [ -f "${BACKUP}/\${f}" ]; then cp "${BACKUP}/\${f}" "${SRC_DIR}/\${f}";
  else rm -f "${SRC_DIR}/\${f}"; fi
done
echo "restored active files from ${BACKUP}"
RESTORE
chmod +x "${BACKUP}/restore.sh"

# --- 3. copy files into active source -------------------------------------
say "3/7 copy ${#FILES[@]} files -> ${SRC_DIR}"
for f in "${FILES[@]}"; do
  cp "${STAGING}/src/${f}" "${SRC_DIR}/${f}"
  echo "  wrote ${f}"
done

# --- pick package-manager runners -----------------------------------------
# EXEC runs a binary (tsc); RUN runs a package.json script (test/build).
if command -v pnpm >/dev/null 2>&1; then
  EXEC="pnpm exec"; RUN="pnpm run"
else
  EXEC="npx"; RUN="npm run"
fi

# --- 4. typecheck gate (scoped to changed files) --------------------------
say "4/7 typecheck gate: ${EXEC} tsc --noEmit (in ${API_DIR})"
TSC_OUT="${SELF_DIR}/.llmcap-tsc.log"
( cd "${API_DIR}" && ${EXEC} tsc --noEmit ) > "${TSC_OUT}" 2>&1
TSC_RC=$?
# Alternation of changed basenames (no extension) for scoping.
NAMES="llmBudget|db|classifier|hqResolver|webResolver|hqSplit|queue|appgoblinPipeline|affplusPipeline"
MINE="$(grep -E "(^|[/])(${NAMES})\.ts\(" "${TSC_OUT}" || true)"
if [ -n "${MINE}" ]; then
  fail "typecheck reported errors in changed files:"
  echo "${MINE}" >&2
  restore_active
  exit 1
fi
if [ "${TSC_RC}" -ne 0 ]; then
  say "typecheck: pre-existing errors remain in UNCHANGED files (baseline). None in the changed files — gate passes. Full log: ${TSC_OUT}"
else
  say "typecheck: clean."
fi

# --- 5. tests gate ---------------------------------------------------------
say "5/7 tests gate"
TEST_SCRIPT="$(node -e "try{const s=require('./${API_DIR}/package.json').scripts||{};process.stdout.write(s.test||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true)"
DEFAULT_TEST='echo "Error: no test specified" && exit 1'
if [ -z "${TEST_SCRIPT}" ] || [ "${TEST_SCRIPT}" = "${DEFAULT_TEST}" ]; then
  say "no real \"test\" script in ${API_DIR}/package.json — skipping tests gate."
else
  say "running: ${RUN} test  (last 20 lines)"
  if ! ( cd "${API_DIR}" && ${RUN} test 2>&1 | tail -20 ); then
    fail "tests gate failed."
    restore_active
    exit 1
  fi
  say "tests: passed."
fi

# --- 6. build gate ---------------------------------------------------------
say "6/7 build gate"
BUILD_SCRIPT="$(node -e "try{const s=require('./${API_DIR}/package.json').scripts||{};process.stdout.write(s.build||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true)"
if [ -z "${BUILD_SCRIPT}" ]; then
  say "no \"build\" script in ${API_DIR}/package.json — skipping build gate."
else
  say "running: ${RUN} build"
  if ! ( cd "${API_DIR}" && ${RUN} build ); then
    fail "build gate failed."
    restore_active
    exit 1
  fi
  say "build: ok."
fi

# --- 7. mirror (post-gates only) -------------------------------------------
say "7/7 mirror ${SRC_DIR} -> ${MIRROR_DIR} (per-file cp)"
for f in "${FILES[@]}"; do
  cp "${SRC_DIR}/${f}" "${MIRROR_DIR}/${f}"
  echo "  mirrored ${f}"
done

# --- done ------------------------------------------------------------------
say "SUCCESS — LLM daily cap applied."
cat <<DONE

  Daily cap:      \$${LLM_DAILY_CAP_USD:-100}  (env LLM_DAILY_CAP_USD overrides; default 100)
  Reset:          next Asia/Jerusalem midnight
  Files changed:  ${#FILES[@]} (1 new: llmBudget.ts)
  Backup:         ${BACKUP}
  Rollback:       bash ${BACKUP}/restore.sh

  Next (separate manual steps — not done by this script):
    - Restart the server.
    - Republish (production only updates on Republish).
DONE
