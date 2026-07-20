# Google Ads Transparency Center — lead source

A fourth lead source (`google_ads`) alongside Meta, Affplus, and AppGoblin. It
turns a **humongous multilingual keyword bank** into leads by searching the
Google Ads Transparency Center, then splits every lead by **product type**
(Mobile vs CPS) **and HQ country**.

## Why it works the way it does

The Transparency Center (`adstransparency.google.com`) has **no browseable feed
and no official API**. The only way in is the same internal RPC the site's own
frontend calls: you type a query and Google matches it against advertiser
**names** and verified **domains**. So the breadth of the pull is a direct
function of the breadth of the keyword set — which is why the keyword bank is the
centerpiece.

A keyword does **not** guarantee a Mobile-app or a Web-CPS advertiser (the
operator's own observation). We accept that: the destination of the advertiser's
actual ad decides the classification, and we cast a very wide multilingual net to
find a lot of leads.

## The pieces

| File | Role |
|------|------|
| `artifacts/api-server/src/googleAdsKeywords.ts` | **The exemplar bank.** ~2,650 deduped keywords across **37 languages / 8 scripts** and **21 verticals** (iGaming, betting, loans, credit, insurance, crypto, forex, e-commerce, dating, travel, health, beauty, SaaS/VPN, real-estate, auto, education/jobs, streaming, telecom, legal, food + CTAs). Deterministic, well-spread sampler `keywordsForJob({verticals, languages, limit})`. |
| `artifacts/api-server/src/googleAdsScraper.ts` | Reverse-engineered RPC client (`SearchSuggestions` → advertisers, `SearchCreatives` → creatives, `GetCreativeById` → destination). No browser. Strips the `)]}'` anti-hijack prefix, parses positional payloads defensively (documented key first, then recursive scan), unwraps `googleadservices` click wrappers, and **degrades gracefully** on 403/429/challenge (empty + `blocked` flag, never throws). |
| `artifacts/api-server/src/googleAdsPipeline.ts` | Orchestrator: keywords → discover advertisers → resolve each destination → classify (**regex only, no LLM**) → CSV → HQ split → notify. |
| `artifacts/api-server/src/hqSplitWeb.ts` | HQ bucketing for **web/CPS** leads: ccTLD → script → LLM (cheapest first, budgeted, cached). One `.xlsx` per HQ country in a `.zip`, mirroring the mobile split. |

Wired into: `db.ts` (JobSource), `queue.ts` (dispatch), `routes-jobs.ts`
(validation + `GET /api/jobs/google-ads-verticals`), and the dashboard
(`api/client.ts`, `App.tsx`, `styles.css`).

## Cost & safety profile

- **Classifier uses no LLM.** A store URL ⇒ Mobile; any other real destination ⇒
  Web CPS. The only LLM spend is HQ resolution.
- **Web HQ resolution is ccTLD/script-short-circuited** — a `.com.br` domain or a
  CJK/Hebrew/Thai advertiser name resolves for free; only Latin-name `.com`
  domains reach the (cached, budgeted) LLM.
- All LLM spend flows through the existing shared daily cap → a hit **defers** the
  job to the next Jerusalem midnight, never fails it.
- Requests are polite (bounded delay), the discovery loop aborts after 5
  consecutive blocks, `GetCreativeById` lookups are capped per job, and once that
  budget is spent no further `SearchCreatives` round-trips are made.

## Blast radius (what changed outside the 4 new files)

- `db.ts` — `JobSource` gains `'google_ads'` (comment-only elsewhere). **Schema
  migrations unchanged; all additive; old rows untouched.**
- `queue.ts` — one dispatch branch.
- `routes-jobs.ts` — accept `google_ads`, build its `source_params`, add the
  verticals metadata route (declared before `/:id`).
- `hqResolver.ts` — `detectCountryFromScript` gains **Hebrew→Israel** and
  **Thai→Thailand** (unambiguous single-country scripts; additive, improves the
  mobile path too). Arabic/Devanagari deliberately not mapped (multi-country).
- Dashboard — new source radio + options panel; the HQ-zip button now shows
  whenever a zip exists (fixes a latent 404 for mobile jobs with no zip);
  `deferred` status/phase now rendered.
- `notifier.ts` — comment-only (it already gated attachments on `hq_zip_path`).

Meta / Affplus / AppGoblin behavior is unchanged.

## Configuration (all optional — sensible defaults baked in)

See `.env.example` for the full list (`GOOGLE_ADS_*`). Nothing is required to run.

## Testing

Every module ships offline self-tests (no network, no LLM key):

```bash
cd artifacts/api-server
pnpm build
node dist/googleAdsKeywords.js     # 28 tests — bank size, multi-script, sampler
node dist/googleAdsScraper.js      # 44 tests — parsers, unwrapping, budgets, current+legacy shapes
node dist/googleAdsPipeline.js     #  5 tests — classifier mapping
node dist/hqSplitWeb.js            #  4 tests — ccTLD/script HQ short-circuits
node fixtures/google-ads-smoke.mjs # 18 checks — full DB→CSV→HQ-split chain + a
                                   #             best-effort live discovery probe
```

The live probe is expected to report `blocked` inside a locked-down sandbox and
to return real advertisers from an open network (Replit).

## Using it

1. **New Job → Source: Google Ads Transparency.**
2. Optionally pick **verticals** and/or **languages** (empty = everything),
   set **max keywords / job** (default 40), or paste **custom keywords**.
3. Tick **Mobile**, **CPS**, or both (each product type is a separate job/CSV).
4. Start. Watch the log stream discovery → classification → HQ split. On
   completion, download the **CSV** and the **HQ-split ZIP** (one `.xlsx` per HQ
   country).
