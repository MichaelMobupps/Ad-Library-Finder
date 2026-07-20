# Ad Library Finder

Internal SDR tool that scrapes the Meta Ad Library for active advertisers, classifies them as **Mobile** (Google Play / iTunes preview URLs) or **CPS** (web product URLs), produces a CSV per category, and emails the result to the configured recipient via Gmail OAuth.

## Inputs
- **Countries** — one or more ISO 2-letter codes (e.g. `US`, `BR`, `IN`)
- **Product type** — `mobile`, `cps`, or both (produces two CSVs, one per type)
- **Recipient email** (optional per-job override of the global default)

## Output
- `mobile` CSV: `advertiser_name, country, preview_url, store, ad_text`
- `cps` CSV: `advertiser_name, country, website_url, ad_text`

## Architecture
```
artifacts/
├── api-server/    Express + Playwright + SQLite + Anthropic classifier + Gmail send
└── dashboard/     Vite + React UI — jobs list, new-job form, job detail, settings
```
Single-process deploy: api-server serves `/api/*` and the built dashboard. Port 3001 forwarded to external 80 via `.replit`.

## Bring-up (after unzipping into a fresh Replit)
```bash
pnpm install
pnpm install:playwright
pnpm build
pnpm start
```

Then add **secrets** in the Replit Secrets panel:
- `ANTHROPIC_API_KEY` — required (LLM classifier)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL` — optional, only if you want Gmail email notifications. See `SETUP_GOOGLE_OAUTH.md`.

## First run
1. Open the Replit webview → top nav → **Settings**
2. (Optional) Click **Connect Gmail Account** → authorize the sender Gmail
3. (Optional) Enter a default recipient email → Save
4. Top nav → **+ New Job** → enter countries (`US, BR, IN`) → tick product type(s) → **Start Job**
5. Watch logs stream in Job Detail view. When `completed`, download CSV from the UI or wait for the email.

## Lead sources
Besides Meta, the app also pulls from **Affplus**, **AppGoblin**, and the
**Google Ads Transparency Center**. The Google Ads source searches a huge
multilingual keyword bank against the Transparency Center and splits leads by
Mobile vs CPS **and** HQ country — see `GOOGLE_ADS_INTEGRATION.md`.

## Editable config
- `artifacts/api-server/src/keywords.ts` — curated Meta keyword lists per product type
- `artifacts/api-server/src/googleAdsKeywords.ts` — the multilingual Google Ads keyword exemplar bank (~2,200 keywords, 37 languages, 21 verticals)
- `artifacts/api-server/src/classifier.ts` — known MMP tracker domains (AppsFlyer, Branch, Adjust, Singular, etc.)

## Pacing
Default config runs at human-SDR pace: ~2.5s randomized delay between actions, one concurrent Playwright context. Don't crank this — Meta's volume detection is what blocks scrapers. Build trust first.
