/**
 * HQ resolver — determines the corporate headquarters country behind an app.
 *
 * Ported faithfully from the Email Prospector s3_enrich.py resolve_company()
 * pipeline. Three layers, applied in order:
 *
 *   LAYER 1: LLM identifies company_name (direct publisher, NOT parent
 *            conglomerate; in Latin script; NEVER a TLD'd domain string),
 *            parent_company, corporate_domain, primary_market. Low temp.
 *            Cross-industry parent rule: when app industry ≠ parent industry,
 *            pick the operating brand (Momo ← Fubon Financial, LINE Pay ←
 *            LY/Z Holdings, Disney+ ← Walt Disney Co).
 *
 *   LAYER 2: ccTLD override — extract the TLD from corporate/developer
 *            domain; if mapped, OVERRIDE primary_market regardless of what
 *            the LLM said. Two-part suffix (".com.br") is checked before
 *            the last label. The LLM over-defaults to "United States";
 *            ccTLD is ground truth.
 *
 *   LAYER 3: script-detection fallback — ONLY when ccTLD did not fire AND
 *            primary_market is empty or "United States". Scan combined text
 *            (publisher + app name + legal name) for Japanese kana, Chinese
 *            CJK without kana, Korean Hangul, Cyrillic, or Spanish markers
 *            in priority order. First match wins.
 *
 * Output is one ResolvedHq record per store URL. Result is cached by
 * store_url upstream of this module so repeat resolves cost zero LLM tokens.
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from './logger.js';
import { StorePageInfo } from './storePageFetcher.js';

export interface ResolvedHq {
  company_name: string;
  parent_company: string;
  corporate_domain: string;
  primary_market: string; // HQ country — this is the field we split on
  reasoning: string;
  llm_market_raw: string; // what the LLM said before overrides
  override_source: 'llm' | 'cctld' | 'script'; // diagnostic
}

// ─────────────────────────────────────────────────────────────
// LAYER 2: ccTLD → country map. Two-part suffixes are tried first
// via sort-by-length-desc in resolveTld(), so "co.jp" beats "jp",
// "com.br" beats "br", etc. The "co" entry maps to Colombia per
// the EP source; two-part match runs first so "co.jp"/"co.uk"
// resolve correctly before the single "co" rule could fire.
// ─────────────────────────────────────────────────────────────
const CCTLD_TO_COUNTRY: Record<string, string> = {
  jp: 'Japan', 'co.jp': 'Japan',
  cn: 'China', 'com.cn': 'China',
  es: 'Spain', 'com.es': 'Spain',
  ru: 'Russia', 'com.ru': 'Russia',
  kr: 'South Korea', 'co.kr': 'South Korea',
  de: 'Germany', 'com.de': 'Germany',
  fr: 'France', 'com.fr': 'France',
  it: 'Italy', 'com.it': 'Italy',
  br: 'Brazil', 'com.br': 'Brazil',
  mx: 'Mexico', 'com.mx': 'Mexico',
  in: 'India', 'co.in': 'India',
  id: 'Indonesia', 'co.id': 'Indonesia',
  vn: 'Vietnam', 'com.vn': 'Vietnam',
  th: 'Thailand', 'co.th': 'Thailand',
  tr: 'Turkey', 'com.tr': 'Turkey',
  il: 'Israel', 'co.il': 'Israel',
  sg: 'Singapore', 'com.sg': 'Singapore',
  my: 'Malaysia', 'com.my': 'Malaysia',
  ph: 'Philippines', 'com.ph': 'Philippines',
  ng: 'Nigeria', 'com.ng': 'Nigeria',
  ae: 'United Arab Emirates',
  sa: 'Saudi Arabia', 'com.sa': 'Saudi Arabia',
  eg: 'Egypt', 'com.eg': 'Egypt',
  ar: 'Argentina', 'com.ar': 'Argentina',
  co: 'Colombia', 'com.co': 'Colombia',
  cl: 'Chile',
  pl: 'Poland', 'com.pl': 'Poland',
  nl: 'Netherlands',
  se: 'Sweden',
  no: 'Norway',
  fi: 'Finland',
  dk: 'Denmark',
  at: 'Austria',
  ch: 'Switzerland',
  be: 'Belgium',
  pt: 'Portugal',
  ua: 'Ukraine', 'com.ua': 'Ukraine',
  za: 'South Africa', 'co.za': 'South Africa',
  ke: 'Kenya', 'co.ke': 'Kenya',
  au: 'Australia', 'com.au': 'Australia',
  nz: 'New Zealand', 'co.nz': 'New Zealand',
  hk: 'Hong Kong', 'com.hk': 'Hong Kong',
  tw: 'Taiwan', 'com.tw': 'Taiwan',
};

/**
 * Extract just the registrable domain from a URL/email/bare host.
 * Returns lowercased host without protocol, port, path, or "www.".
 */
export function extractDomain(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (!s) return '';
  // Strip protocol
  s = s.replace(/^https?:\/\//, '');
  // If it's an email, take the part after @
  if (s.includes('@')) s = s.split('@')[1] || '';
  // Strip path/query/port
  s = s.split('/')[0].split('?')[0].split(':')[0];
  // Strip leading www.
  s = s.replace(/^www\./, '');
  return s;
}

/**
 * Layer-2 lookup: given a domain, return the mapped country or "" if no match.
 * Two-part suffixes ("com.br") are matched before single labels ("br") so
 * "foo.com.br" → Brazil (not Colombia via "co").
 */
export function resolveTld(domain: string): string {
  const d = (domain || '').toLowerCase().trim();
  if (!d) return '';
  const parts = d.split('.');
  if (parts.length >= 3) {
    const twoPart = parts.slice(-2).join('.');
    if (CCTLD_TO_COUNTRY[twoPart]) return CCTLD_TO_COUNTRY[twoPart];
  }
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (CCTLD_TO_COUNTRY[last]) return CCTLD_TO_COUNTRY[last];
  }
  return '';
}

/**
 * Layer-3 fallback: detect a country from script/language markers in combined text.
 * Priority: Japanese kana → Chinese (no kana) → Korean Hangul → Cyrillic →
 * Spanish markers. First match wins. Empty string if nothing matches.
 */
export function detectCountryFromScript(text: string): string {
  if (!text) return '';
  const hasJapaneseKana = /[\u30A0-\u30FF\u3040-\u309F]/.test(text);
  if (hasJapaneseKana) return 'Japan';
  const hasCjk = /[\u4E00-\u9FFF]/.test(text);
  if (hasCjk && !hasJapaneseKana) return 'China';
  const hasHangul = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(text);
  if (hasHangul) return 'South Korea';
  const hasCyrillic = /[\u0400-\u04FF]/.test(text);
  if (hasCyrillic) return 'Russia';
  const lower = text.toLowerCase();
  const spanishMarkers = ['españa', 'espana', 'grupo', 'alimentación', 'alimentacion'];
  for (const m of spanishMarkers) {
    if (lower.includes(m)) return 'Spain';
  }
  return '';
}

// ─────────────────────────────────────────────────────────────
// LAYER 1: LLM call
// ─────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

interface LlmResolveOutput {
  company_name: string;
  parent_company: string;
  corporate_domain: string;
  primary_market: string;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are a business intelligence analyst. Given a mobile app's details,
determine the ACTUAL parent company that owns/publishes this app, AND its corporate
headquarters country.

IMPORTANT: The developer website domain often does NOT match the company name in business
databases. Examples:
- Cash App → developer site is cash.app, but the company is "Block, Inc."
- Tinder → listed under match.com, but the company is "Match Group"
- Instagram → company is "Meta Platforms"

CRITICAL: company_name is the DIRECT publisher/developer studio that publishes this app,
in Latin script. NOT the ultimate parent conglomerate.
Examples:
- A game by Astrum Entertainment (owned by VK): company_name="Astrum Entertainment",
  parent_company="VK"
- An app by SMBC Consumer Finance (part of SMBC Group): company_name="SMBC Consumer Finance",
  parent_company="SMBC Group"
- Use the parent only if the app is directly published by the parent (e.g. "Tencent" for
  PUBG Mobile where Tencent is the direct publisher).

CROSS-INDUSTRY PARENT RULE (very important): when the app's industry differs from the
parent's industry, ALWAYS pick the operating brand as company_name, NEVER the cross-industry
parent — even if the parent is more famous/larger or has a Latin name while the brand has
a native-script name. Cross-industry examples:
- "Momo" (Taiwanese ECOMMERCE platform at momo.com.tw, brand "momo購物") ← Fubon Financial
  Holding (FINANCIAL HOLDING). Use company_name="Momo", parent_company="Fubon Financial
  Holding". primary_market="Taiwan" because that's where the operating brand HQ is.
- "7-Eleven Japan" (RETAIL/CONVENIENCE) ← Seven & i Holdings (general conglomerate).
  Use company_name="7-Eleven Japan".
- "LINE Pay" (FINTECH/PAYMENTS) ← LY Corporation / Z Holdings (MESSAGING+general). Use
  company_name="LINE Pay".
- "Disney+" (STREAMING/MEDIA) ← The Walt Disney Company. Use company_name="Disney+" when
  the target is the streaming product team.
Industry-mismatch signal: if the app's vertical (gaming, ecommerce, fintech, streaming,
etc.) does NOT match the parent's primary business, you are dealing with a
CONGLOMERATE-OWNED OPERATING BRAND. The operating brand has the team relevant to outreach.

NEVER include a TLD suffix (.com, .com.tw, .co.uk, .co.jp, .de, .io, etc.) in company_name
UNLESS the company's official brand IS the domain. Legitimate brand-is-domain examples:
"Booking.com", "Match.com", "Hotels.com", "Stamps.com". For the Taiwanese e-commerce brand
at momo.com.tw, return "Momo" (the bare brand), NOT "momo.com" and NOT "momo.com.tw".

primary_market = the country where this company's HEADQUARTERS is located. This determines
the deliverable group the app falls into. Examples:
- "China" for Tencent (HQ in Shenzhen)
- "Spain" for Grupo Dia (HQ in Madrid)
- "Japan" for SMBC (HQ in Tokyo)
- "United States" for Meta (HQ in Menlo Park)
- "Taiwan" for Momo (HQ in Taipei)
ALWAYS the HQ country, NOT where the app is popular or where the users are.

Return ONLY valid JSON, no preamble, no markdown fences:
{
  "company_name": "Direct publisher brand in Latin script (NOT parent unless parent is direct publisher; NEVER a TLD'd domain unless brand IS the domain)",
  "parent_company": "Ultimate parent if different from company_name; empty string otherwise",
  "corporate_domain": "Primary corporate email domain (e.g. block.xyz for Cash App)",
  "primary_market": "HQ country name in English (e.g. 'Japan', 'Brazil', 'United States')",
  "reasoning": "One sentence explaining the resolution"
}`;

async function callLlmForCompany(input: {
  appName: string;
  publisherName: string;
  developerWebsite: string;
  storeCategory: string;
  description: string;
}): Promise<LlmResolveOutput | null> {
  const userContent = `App name: ${input.appName}
Publisher / developer name: ${input.publisherName}
Developer website: ${input.developerWebsite}
Store category: ${input.storeCategory}
Description: ${input.description.slice(0, 400)}`;

  try {
    const res = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
    const textBlock = res.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;
    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as LlmResolveOutput;
    return {
      company_name: parsed.company_name || '',
      parent_company: parsed.parent_company || '',
      corporate_domain: parsed.corporate_domain || '',
      primary_market: parsed.primary_market || '',
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    log.warn(`HQ resolver LLM call failed: ${(err as Error).message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Public: resolveHq(storePage) — combines all three layers.
// Caller is expected to handle caching (see hqSplit.ts).
// ─────────────────────────────────────────────────────────────

export async function resolveHq(page: StorePageInfo): Promise<ResolvedHq> {
  // LAYER 1: ask the LLM.
  const llmOut = await callLlmForCompany({
    appName: page.appName || '',
    publisherName: page.publisherName || '',
    developerWebsite: page.developerWebsite || '',
    storeCategory: page.category || '',
    description: page.description || '',
  });

  let companyName = llmOut?.company_name || page.publisherName || page.appName || '';
  const parentCompany = llmOut?.parent_company || '';
  const corporateDomain = llmOut?.corporate_domain || '';
  const llmMarketRaw = llmOut?.primary_market || '';
  const reasoning = llmOut?.reasoning || (llmOut ? '' : 'LLM call failed; fallback to ccTLD/script only');

  let primaryMarket = llmMarketRaw;
  let overrideSource: ResolvedHq['override_source'] = 'llm';

  // LAYER 2: ccTLD override. Check corporate_domain first (LLM's pick), then
  // fall back to the developer website domain.
  const corpDomainParsed = extractDomain(corporateDomain);
  const devDomainParsed = extractDomain(page.developerWebsite);
  const domainForCctld = corpDomainParsed || devDomainParsed;
  if (domainForCctld) {
    const cctldCountry = resolveTld(domainForCctld);
    if (cctldCountry && cctldCountry.toLowerCase() !== primaryMarket.toLowerCase()) {
      log.info(
        `HQ resolver: ccTLD override on "${page.appName}" — LLM said "${primaryMarket}", domain ${domainForCctld} says "${cctldCountry}"`
      );
      primaryMarket = cctldCountry;
      overrideSource = 'cctld';
    } else if (cctldCountry && !primaryMarket) {
      primaryMarket = cctldCountry;
      overrideSource = 'cctld';
    }
  }

  // LAYER 3: script-detection fallback. Only when ccTLD did not fire AND
  // primary_market is empty or US-ish.
  if (overrideSource !== 'cctld') {
    const isUsishOrEmpty =
      !primaryMarket ||
      ['united states', 'us', 'usa'].includes(primaryMarket.toLowerCase().trim());
    if (isUsishOrEmpty) {
      const combined = `${page.publisherName || ''} ${page.appName || ''} ${page.legalName || ''}`;
      const scriptCountry = detectCountryFromScript(combined);
      if (scriptCountry && scriptCountry.toLowerCase() !== primaryMarket.toLowerCase()) {
        log.info(
          `HQ resolver: script fallback on "${page.appName}" → "${scriptCountry}" (was "${primaryMarket}")`
        );
        primaryMarket = scriptCountry;
        overrideSource = 'script';
      }
    }
  }

  return {
    company_name: companyName,
    parent_company: parentCompany,
    corporate_domain: corporateDomain,
    primary_market: primaryMarket || '',
    reasoning,
    llm_market_raw: llmMarketRaw,
    override_source: overrideSource,
  };
}

// ─────────────────────────────────────────────────────────────
// Unit tests — port-fidelity checks against the EP rules. Run via
// `node dist/hqResolver.js`. These DO NOT call the LLM (LLM is
// stubbed via the input). They exercise Layers 2 and 3 only.
// ─────────────────────────────────────────────────────────────

interface LayerTestCase {
  name: string;
  domain: string;
  expectedCountry: string;
}

const LAYER2_TESTS: LayerTestCase[] = [
  { name: 'com.br', domain: 'foo.com.br', expectedCountry: 'Brazil' },
  { name: 'co.jp', domain: 'smbc.co.jp', expectedCountry: 'Japan' },
  { name: 'com.tw', domain: 'momo.com.tw', expectedCountry: 'Taiwan' },
  { name: 'co.uk-falls-through-to-script', domain: 'foo.co.uk', expectedCountry: '' }, // co.uk not in EP map → no Layer-2 hit (LLM/Layer-3 handles)
  { name: 'jp single-label', domain: 'rakuten.jp', expectedCountry: 'Japan' },
  { name: 'de', domain: 'gmbh.de', expectedCountry: 'Germany' },
  { name: 'com (no override)', domain: 'block.xyz', expectedCountry: '' }, // .xyz not mapped → empty
  { name: 'co.kr', domain: 'kakao.co.kr', expectedCountry: 'South Korea' },
  { name: 'com.mx', domain: 'foo.com.mx', expectedCountry: 'Mexico' },
  { name: 'co.id', domain: 'gojek.co.id', expectedCountry: 'Indonesia' },
  { name: 'tw single-label', domain: 'foo.tw', expectedCountry: 'Taiwan' },
];

interface ScriptTestCase {
  name: string;
  text: string;
  expectedCountry: string;
}

const LAYER3_TESTS: ScriptTestCase[] = [
  { name: 'Japanese kana', text: 'マネーフォワード', expectedCountry: 'Japan' },
  { name: 'Mixed Japanese (kanji+kana)', text: '株式会社マネー', expectedCountry: 'Japan' },
  { name: 'Chinese-only CJK', text: '腾讯', expectedCountry: 'China' },
  { name: 'Korean Hangul', text: '카카오톡', expectedCountry: 'South Korea' },
  { name: 'Cyrillic', text: 'Яндекс', expectedCountry: 'Russia' },
  { name: 'Spanish marker', text: 'Grupo Dia España', expectedCountry: 'Spain' },
  { name: 'Pure ASCII (no match)', text: 'Random ASCII name', expectedCountry: '' },
];

interface ExtractDomainTestCase {
  name: string;
  input: string;
  expected: string;
}

const EXTRACT_DOMAIN_TESTS: ExtractDomainTestCase[] = [
  { name: 'simple', input: 'https://www.foo.com/about', expected: 'foo.com' },
  { name: 'email', input: 'press@momo.com.tw', expected: 'momo.com.tw' },
  { name: 'bare host', input: 'block.xyz', expected: 'block.xyz' },
  { name: 'with port', input: 'http://api.example.co.jp:8080/x', expected: 'api.example.co.jp' },
];

export function runHqResolverUnitTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  for (const tc of LAYER2_TESTS) {
    const got = resolveTld(tc.domain);
    if (got === tc.expectedCountry) passed++;
    else failures.push(`Layer2 ${tc.name}: resolveTld(${JSON.stringify(tc.domain)}) = ${JSON.stringify(got)} (expected ${JSON.stringify(tc.expectedCountry)})`);
  }
  for (const tc of LAYER3_TESTS) {
    const got = detectCountryFromScript(tc.text);
    if (got === tc.expectedCountry) passed++;
    else failures.push(`Layer3 ${tc.name}: detectCountryFromScript(${JSON.stringify(tc.text)}) = ${JSON.stringify(got)} (expected ${JSON.stringify(tc.expectedCountry)})`);
  }
  for (const tc of EXTRACT_DOMAIN_TESTS) {
    const got = extractDomain(tc.input);
    if (got === tc.expected) passed++;
    else failures.push(`extractDomain ${tc.name}: ${JSON.stringify(tc.input)} → ${JSON.stringify(got)} (expected ${JSON.stringify(tc.expected)})`);
  }

  // Combined cross-industry simulation: simulate the LLM returning a wrong
  // primary_market for Momo Taiwan and verify Layer-2 corrects it to Taiwan
  // because the corporate_domain is momo.com.tw. We can't call the LLM in
  // unit tests so we exercise just the override path by computing it directly.
  const momoSim = (() => {
    const llmMarketRaw = 'United States'; // pretend LLM got it wrong
    const corpDomain = 'momo.com.tw';
    const cctld = resolveTld(corpDomain);
    return cctld || llmMarketRaw;
  })();
  if (momoSim === 'Taiwan') {
    passed++;
  } else {
    failures.push(`Cross-industry sim (Momo Taiwan): final market = ${JSON.stringify(momoSim)} (expected "Taiwan")`);
  }

  // .com.br beats LLM-says-USA
  const brSim = (() => {
    const llmMarketRaw = 'United States';
    const corpDomain = 'pagseguro.com.br';
    const cctld = resolveTld(corpDomain);
    return cctld || llmMarketRaw;
  })();
  if (brSim === 'Brazil') passed++;
  else failures.push(`.com.br sim: final = ${JSON.stringify(brSim)} (expected Brazil)`);

  // Japanese-kana publisher on a .com (no ccTLD hit): Layer 3 must fire.
  const jpScriptSim = (() => {
    const llmMarketRaw = 'United States';
    const cctld = resolveTld('foo.com');
    if (cctld) return cctld;
    const script = detectCountryFromScript('マネーフォワード Money Forward');
    return script || llmMarketRaw;
  })();
  if (jpScriptSim === 'Japan') passed++;
  else failures.push(`Japanese-kana-on-.com sim: final = ${JSON.stringify(jpScriptSim)} (expected Japan)`);

  return { passed, failed: failures.length, failures };
}

// Script entry: `node dist/hqResolver.js` runs the unit tests.
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('hqResolver.js') || process.argv[1].endsWith('hqResolver.ts'));
if (isMain) {
  const { passed, failed, failures } = runHqResolverUnitTests();
  console.log(`hqResolver unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}