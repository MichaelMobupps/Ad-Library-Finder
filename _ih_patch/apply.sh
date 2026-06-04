#!/usr/bin/env bash
# ============================================================================
# Prompt-injection hardening installer (plug-and-play).
#
# You do NOT need to know any folder names. This script finds the active
# api-server tree itself, applies the four patched files, runs the typecheck
# and test gates (comparing against the current state so a non-zero baseline
# does not cause a false halt), builds, mirrors to source-code/, and stops on
# any failure with a one-line restore command.
#
# RUN IT WITH ONE COMMAND (paste into the Replit shell at the workspace root):
#
#   python3 -c "import zipfile;zipfile.ZipFile('injection-hardening.zip').extractall('_ih_patch')" && bash _ih_patch/apply.sh
#
# Then click Republish when it says to.
# ============================================================================

set -uo pipefail

# --- where the patched files live (next to this script) --------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_SRC="$SCRIPT_DIR/src"

# --- where to search for the app (the workspace root you ran this from) ----
REPO_ROOT="${IH_REPO_ROOT:-$(pwd)}"

# --- toggles for testing only (leave unset in normal use) ------------------
SKIP_GATES="${IH_SKIP_GATES:-0}"

FILES=(promptSafety.ts classifier.ts hqResolver.ts csv.ts)

say()  { printf '%s\n' "$*"; }
rule() { printf '%s\n' "------------------------------------------------------------"; }
die()  { printf '\nHALT: %s\n' "$*" >&2; exit 1; }

rule
say "Prompt-injection hardening installer"
rule

# 1. Sanity: the patched files must be present next to the script.
for f in "${FILES[@]}"; do
  [ -f "$PATCH_SRC/$f" ] || die "patched file missing from bundle: src/$f"
done

# 2. Locate the ACTIVE api-server tree.
#    A candidate is any directory D where D/src has classifier.ts + hqResolver.ts
#    + csv.ts AND D has a package.json. The active tree is the candidate whose
#    path does NOT contain a "source-code" segment (that path is the read-only
#    mirror). node_modules, backups, and this patch dir are excluded.
mapfile -t CANDIDATES < <(
  find "$REPO_ROOT" \
    -type d -name node_modules -prune -o \
    -type d -path '*/_ih_patch*' -prune -o \
    -type d -path '*/_ih_backup*' -prune -o \
    -type f -name classifier.ts -print 2>/dev/null \
  | while read -r hit; do
      d="$(dirname "$(dirname "$hit")")"   # .../src/classifier.ts -> ...
      if [ -f "$d/src/hqResolver.ts" ] && [ -f "$d/src/csv.ts" ] && [ -f "$d/package.json" ]; then
        printf '%s\n' "$d"
      fi
    done | sort -u
)

ACTIVE=""
for d in "${CANDIDATES[@]}"; do
  case "$d" in
    */source-code/*|*/source-code) : ;;   # mirror, skip
    *) ACTIVE="$d"; break ;;
  esac
done

if [ -z "$ACTIVE" ]; then
  say "Could not auto-pick the active tree. Candidates found:"
  for d in "${CANDIDATES[@]}"; do say "  - $d"; done
  die "set IH_REPO_ROOT or tell me the api-server folder and I will adjust."
fi

# Mirror tree (optional): a source-code/src that holds the same three files.
# The mirror is review-only and has no package.json, so search for it
# separately from the active (buildable) candidates.
MIRROR=""
while read -r hit; do
  d="$(dirname "$(dirname "$hit")")"   # .../src/classifier.ts -> ...
  if [ -f "$d/src/hqResolver.ts" ] && [ -f "$d/src/csv.ts" ]; then
    case "$d" in
      */source-code/*|*/source-code) MIRROR="$d"; break ;;
    esac
  fi
done < <(
  find "$REPO_ROOT" \
    -type d -name node_modules -prune -o \
    -type d -path '*/_ih_patch*' -prune -o \
    -type d -path '*/_ih_backup*' -prune -o \
    -type f -name classifier.ts -print 2>/dev/null
)
[ "$MIRROR" = "$ACTIVE" ] && MIRROR=""   # never mirror onto the active tree

say "Active tree : $ACTIVE"
say "Mirror tree : ${MIRROR:-<none found, mirror step skipped>}"
rule

# 3. Detect package manager and the typecheck/test/build commands.
PM="npm"
if [ -f "$REPO_ROOT/pnpm-lock.yaml" ] || [ -f "$ACTIVE/pnpm-lock.yaml" ]; then PM="pnpm";
elif [ -f "$REPO_ROOT/yarn.lock" ] || [ -f "$ACTIVE/yarn.lock" ]; then PM="yarn"; fi

has_script() { grep -q "\"$1\"[[:space:]]*:" "$ACTIVE/package.json" 2>/dev/null; }

# typecheck: count tsc errors (works with a non-zero baseline)
run_typecheck_count() {
  local out
  if has_script typecheck; then
    out="$(cd "$ACTIVE" && $PM run typecheck 2>&1)"
  else
    out="$(cd "$ACTIVE" && npx tsc --noEmit 2>&1)"
  fi
  # tsc prints "Found N errors"; default to 0 if it printed none.
  printf '%s\n' "$out" | grep -oE 'Found [0-9]+ error' | grep -oE '[0-9]+' | tail -1 | sed 's/^$/0/' || echo 0
}

# tests: count passing (vitest "N passed")
run_test_count() {
  local out
  out="$(cd "$ACTIVE" && $PM run test 2>&1)"
  printf '%s\n' "$out" | tail -20 >&2          # his rule: show last 20 lines
  printf '%s\n' "$out" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | tail -1 || echo 0
}

# 4. BASELINE (before any change) so a non-zero baseline never false-halts.
TC_BEFORE=0; TEST_BEFORE=0
if [ "$SKIP_GATES" != "1" ]; then
  say "Measuring current baseline (typecheck + tests)..."
  TC_BEFORE="$(run_typecheck_count)"; TC_BEFORE="${TC_BEFORE:-0}"
  TEST_BEFORE="$(run_test_count)";    TEST_BEFORE="${TEST_BEFORE:-0}"
  say "Baseline: typecheck errors=$TC_BEFORE, tests passing=$TEST_BEFORE"
  rule
fi

# 5. BACKUP the target files.
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$REPO_ROOT/_ih_backup-$STAMP"
mkdir -p "$BACKUP"
for f in "${FILES[@]}"; do
  [ -f "$ACTIVE/src/$f" ] && cp "$ACTIVE/src/$f" "$BACKUP/$f.bak"
done
say "Backup written: $BACKUP"

# 6. COPY patched files into the active tree.
for f in "${FILES[@]}"; do
  cp "$PATCH_SRC/$f" "$ACTIVE/src/$f"
done
say "Applied ${#FILES[@]} files to $ACTIVE/src"
rule

restore_hint() { say "To undo: cp $BACKUP/*.bak back into $ACTIVE/src (drop the .bak suffix)."; }

if [ "$SKIP_GATES" = "1" ]; then
  say "IH_SKIP_GATES=1 set: skipping typecheck/test/build/mirror (test mode)."
  exit 0
fi

# 7. TYPECHECK GATE: must not regress past baseline.
say "Typecheck gate..."
TC_AFTER="$(run_typecheck_count)"; TC_AFTER="${TC_AFTER:-0}"
say "Typecheck errors: before=$TC_BEFORE after=$TC_AFTER"
if [ "$TC_AFTER" -gt "$TC_BEFORE" ]; then
  restore_hint; die "typecheck regressed ($TC_BEFORE -> $TC_AFTER)."
fi

# 8. TEST GATE: must not drop below baseline.
say "Test gate..."
TEST_AFTER="$(run_test_count)"; TEST_AFTER="${TEST_AFTER:-0}"
say "Tests passing: before=$TEST_BEFORE after=$TEST_AFTER"
if [ "$TEST_AFTER" -lt "$TEST_BEFORE" ]; then
  restore_hint; die "tests dropped ($TEST_BEFORE -> $TEST_AFTER)."
fi

# 9. BUILD (mandatory before restart).
say "Build..."
if has_script build; then
  ( cd "$ACTIVE" && $PM run build ) || { restore_hint; die "build failed."; }
else
  say "no build script found; skipping (confirm your repo builds elsewhere)."
fi

# 10. NEW-MODULE SELF-TESTS (only if a dist/ was produced).
for m in promptSafety csv; do
  if [ -f "$ACTIVE/dist/$m.js" ]; then
    say "Self-test: $m"
    ( cd "$ACTIVE" && node "dist/$m.js" ) || { restore_hint; die "$m self-test failed."; }
  fi
done

# 11. MIRROR (post-gates only).
if [ -n "$MIRROR" ]; then
  for f in "${FILES[@]}"; do cp "$ACTIVE/src/$f" "$MIRROR/src/$f"; done
  say "Mirrored ${#FILES[@]} files to $MIRROR/src"
fi

rule
say "PASS"
say "  typecheck: $TC_BEFORE -> $TC_AFTER (no regression)"
say "  tests:     $TEST_BEFORE -> $TEST_AFTER (no regression)"
say "  backup:    $BACKUP"
say ""
say "Republish after restart."
rule
