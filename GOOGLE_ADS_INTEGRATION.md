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

## Mobile (YouTube/CTV) resolution

Mobile jobs sell into app-install / Connected-TV, so they focus on **video
creatives** and resolve their **app-store** destination:

- **Format focus.** The Transparency Center's internal `SearchCreatives` RPC
  exposes **no** platform (Search/YouTube/Maps) filter — the only working lever
  is creative **format** (payload field `"4"`: 1=text, 2=image, 3=video). YouTube
  and CTV app-install ads are video, so mobile jobs filter to video by default
  (`GOOGLE_ADS_MOBILE_CREATIVE_FORMAT=3`, `0`=all formats). This concentrates the
  capped creative-lookup budget on exactly the surface we sell into.
- **Preview hop (the fix for empty mobile CSVs).** The store URL is **not** in the
  `GetCreativeById` payload — that only carries a
  `displayads-formats.googleusercontent.com/ads/preview/content.js` render URL.
  The real Play/App-Store link is inside that preview document's `adurl=` param.
  When a creative detail yields no direct destination, the resolver fetches the
  preview once (through the proxy) and extracts the store/click URL
  (`GOOGLE_ADS_PREVIEW_FETCH=1`). Verified live: video creatives resolve to
  `play.google.com/store/apps/details?id=…` and `apps.apple.com` / `itunes` links.
- **CPS/web is untouched** — those jobs never fetch creatives; both the format
  filter and the preview hop are gated behind mobile-only `mobileFocus`.

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

**If discovery returns 0 advertisers with `429` on every request (warm-up GET included),
the host IP is hard-blocked by Google** — a datacenter/deploy IP in Google's penalty box.
No pacing/backoff/browser defeats this (a real browser from the same IP is blocked too).
Set **`GOOGLE_ADS_PROXY_URL`** to a residential/mobile proxy gateway to egress the scraper
(only) from an un-flagged IP; the rest of the server keeps direct egress. Credentials in the
URL are redacted in logs. For rotating pools, point it at the provider's gateway endpoint.

**Exit rotation on penalty box.** When a proxy is configured and the warm-up GET answers
429/403, the scraper no longer gives up on the first burned exit IP: it rotates to a fresh
exit — tearing down the proxy connection pool and, if the URL carries a literal
`{session}` placeholder, minting a new session token — re-warms, and only latches the
cooldown after **`GOOGLE_ADS_EXIT_ROTATIONS`** (default 2) fresh exits are all blocked.
Each attempt logs the actual **exit IP** (fetched through the proxy from a neutral IP echo,
`GOOGLE_ADS_IP_ECHO_URL`, default api.ipify.org) so the logs prove whether the pool really
rotated or handed back the same burned IP. Block responses are also fingerprinted
("block forensics": server header + body signature) to distinguish a genuine Google
penalty page from a 429 the proxy provider generated itself.

A **set-but-unusable** `GOOGLE_ADS_PROXY_URL` (an unfilled `HOST:PORT`/`USER:PASS`
placeholder, or a string that doesn't parse as a URL) **fails the job at start** with an
explicit config error — it does NOT silently fall back to direct egress, which would
penalty-box the deploy IP and "complete" jobs with 0 ads. Unset the variable entirely if
direct egress is what you want.

### Proxy traffic monitor (Proxy-Seller residential)

The residential package is billed per GB; when it runs dry, jobs would otherwise burn the
whole retry ladder against a dead proxy. Set **`PROXY_SELLER_API_KEY`** (dashboard →
Custom API) and every Google Ads job will, at start, log the package's remaining GB, warn
below **`PROXY_TRAFFIC_WARN_GB`** (default 1), and refuse to start below
**`PROXY_TRAFFIC_ABORT_GB`** (default 0.05) with a clear "add GB or unset the key" error.
On completion the job logs its own traffic cost (`proxy-traffic: this job used …`) — also
on failure/defer, so a job that dies mid-scrape still has its burn on record.
All checks are fail-open: an unreachable Proxy-Seller API logs a warning and never blocks
a job. Key problems are diagnosed explicitly: the API's own error envelope ("Error api
key", "IP not allowed x.x.x.x", "Request limit reached") is surfaced in the warn line, and
an HTML response (invalid key redirected to the homepage) is called out as a likely
invalid/revoked key. Note the Proxy-Seller Custom API supports an **IP allowlist** — leave
it open or it will reject calls from rotating deploy IPs. Unset the key to disable
entirely (`proxyTraffic.ts`).

Smoke-test the monitor (hermetic, mocked network — plus a `--live` mode that reads the
real balance when `PROXY_SELLER_API_KEY` is in the shell):

```bash
node scripts/smoke-proxy-traffic.mjs          # 21 checks, no key needed
node scripts/smoke-proxy-traffic.mjs --live   # one real API call, prints the balance
```

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
