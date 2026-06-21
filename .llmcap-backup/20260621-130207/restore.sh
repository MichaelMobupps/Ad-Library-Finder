#!/usr/bin/env bash
# Restore the active files to their pre-ship state.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
for f in llmBudget.ts db.ts classifier.ts hqResolver.ts webResolver.ts hqSplit.ts queue.ts appgoblinPipeline.ts affplusPipeline.ts; do
  if [ -f "/home/runner/workspace/.llmcap-backup/20260621-130207/${f}" ]; then cp "/home/runner/workspace/.llmcap-backup/20260621-130207/${f}" "artifacts/api-server/src/${f}";
  else rm -f "artifacts/api-server/src/${f}"; fi
done
echo "restored active files from /home/runner/workspace/.llmcap-backup/20260621-130207"
