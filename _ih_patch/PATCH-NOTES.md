# Prompt-injection hardening — patch notes

Target: Ad Library Finder pipeline (api-server). Active code lives in the
api-server artifact `src/`; this bundle mirrors that `src/` layout.

## Files in this bundle

1. `src/promptSafety.ts`  — NEW. Shared injection defenses (fence + system rule).
2. `src/classifier.ts`    — PATCHED. Fences ad text / landing URL; validates store_url.
3. `src/hqResolver.ts`    — PATCHED. Fences scraped store fields; scrubs LLM output.
4. `src/csv.ts`           — PATCHED. CSV formula-injection guard on free-text columns.

## What changed and why

### 1. promptSafety.ts (new module, zero project deps)
- `fenceUntrusted(label, content, maxLen)` wraps attacker-influenced text in a
  per-call RANDOM sentinel fence. Content cannot forge the closing marker
  because it does not know the sentinel, and the body is stripped of the
  sentinel and marker forms before insertion.
- `fenceFields([...])` fences several labeled fields, skipping empties.
- `INJECTION_SYSTEM_RULE` is the standing system-prompt clause that tells the
  model fenced content is data, never instructions.
- `clampContent` strips control characters and caps length.
- Ships `runPromptSafetyTests()` (18 checks). Run: `node dist/promptSafety.js`.

### 2. classifier.ts
- `llmClassify` now fences LANDING URL and AD TEXT, and passes
  `INJECTION_SYSTEM_RULE` as the system prompt.
- New exported `sanitizeStoreUrl()` validates the model's returned store_url:
  it keeps only a canonical play.google.com / apps.apple.com URL or an
  allowlisted MMP-tracker URL, and returns null for anything else. The model's
  raw URL is no longer trusted into the CSV or the fetcher.
- Existing classification-enum validation is unchanged.

### 3. hqResolver.ts
- `callLlmForCompany` now fences APP NAME, PUBLISHER/DEVELOPER NAME, DEVELOPER
  WEBSITE, STORE CATEGORY, and DESCRIPTION via `fenceFields`.
- `INJECTION_SYSTEM_RULE` is appended to `SYSTEM_PROMPT`.
- LLM output is scrubbed with `clampContent` (control-char strip + length cap)
  before it flows into the deliverable.
- Layer-2 (ccTLD) and Layer-3 (script) override logic is unchanged.

### 4. csv.ts
- New exported `neutralizeFormula()` prefixes a single quote to any cell that
  begins with `= + - @` or a leading tab/CR (CWE-1236).
- Applied to the human-facing free-text columns only (advertiser_name,
  ad_text). The store_url / website_url / country columns are left verbatim so
  the Email Prospector ingest reads exact values.
- `db` import changed to `import type` (the symbols are used only as types).
- Ships `runCsvUnitTests()` (15 checks). Run: `node dist/csv.js`.

## Not changed (verified already safe)
- `webResolver.nameSearchDestination` already fences input with `<offer_data>`.
- `webResolver.safeFollow` already blocks SSRF (metadata IP, private/loopback/
  link-local/reserved ranges) at every redirect hop.
- `storePageFetcher` rebuilds fetch URLs against a hardcoded host from an
  extracted numeric/package id, so a poisoned store_url cannot redirect fetches.
- `xlsxWriter` writes every value as a string cell (`t="s"`), never a formula
  cell (`<f>`), so the HQ-split workbooks are not formula-injectable.
- `db.ts` queries are fully parameterized (no string-built SQL).

## Verification gates (run in the active api-server artifact)
1. Typecheck must remain at or below the repo baseline.
2. Test suite must remain at or above the repo baseline.
3. New module self-tests: `node dist/promptSafety.js` and `node dist/csv.js`
   each print `0 failed`.
4. Build must succeed before any restart.
