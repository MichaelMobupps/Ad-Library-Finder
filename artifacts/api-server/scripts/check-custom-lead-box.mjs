#!/usr/bin/env node
/**
 * Browser probe for the New Job form's custom lead-count box.
 *
 * NOT part of the default gate — it needs a real browser and a built dashboard,
 * so it sits alongside the network suites as a manual/pre-publish check:
 *
 *     pnpm --filter dashboard build
 *     node artifacts/api-server/scripts/check-custom-lead-box.mjs
 *
 * Why it exists: the box shipped unusable ("can't type here anything") because a
 * broad CSS selector squashed it to 18x18. Nothing threw, tsc passed, and all
 * 709 server assertions passed — the defect was only visible to a human looking
 * at the page. check-form-css.mjs pins the specific CSS shape statically; this
 * probe verifies the thing the user actually cares about: that you can click it,
 * type into it, and have that number reach the API.
 *
 * It serves the real production bundle behind a stub API whose payloads are
 * built from the compiled server's OWN config constants, so the form renders
 * with real verticals/markets/lead limits rather than invented ones.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIST = path.resolve(HERE, '../dist');
const WEB_DIST = path.resolve(HERE, '../../dashboard/dist');
const PORT = 4787;

const skip = (why) => {
  console.log(`custom-lead-box probe SKIPPED — ${why}`);
  process.exit(0);
};
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) skip('dashboard not built (pnpm --filter dashboard build)');
if (!fs.existsSync(path.join(API_DIST, 'csv.js'))) skip('api-server not built (pnpm --filter api-server build)');

// `playwright` is the declared dependency (see scraper.ts); playwright-core is
// only a transitive, so try the real one first.
let chromium;
for (const mod of ['playwright', 'playwright-core']) {
  try {
    ({ chromium } = await import(mod));
    break;
  } catch {
    /* try the next */
  }
}
if (!chromium) skip('playwright not resolvable from here');

const cfg = await import(path.join(API_DIST, 'storeDiscoveryConfig.js'));
const csv = await import(path.join(API_DIST, 'csv.js'));

// Mirrors the real routes' response shapes; only what the New Job form reads.
const STUBS = {
  '/api/me': { id: 'u1', email: 'probe@mobupps.com', name: 'Probe', isAdmin: true },
  '/api/jobs': [],
  '/api/jobs/activity': [],
  '/api/jobs/google-ads-verticals': [],
  '/api/jobs/appgoblin-categories': [],
  '/api/settings': { recipient: 'probe@mobupps.com', gmailConnected: false },
  '/api/jobs/store-first-config': {
    verticals: cfg.VERTICALS.map((v) => ({ id: v.id, label: v.label })),
    markets: cfg.ALL_MARKETS,
    defaults: { verticals: cfg.DEFAULT_ACTIVE_VERTICALS, markets: cfg.DEFAULT_ACTIVE_MARKETS },
    charts: { play: cfg.PLAY_CHARTS, apple: cfg.APPLE_CHARTS },
    leadLimits: csv.LEAD_LIMIT_CHOICES,
    installBand: { min: cfg.TAIL_MIN_INSTALLS, max: cfg.TAIL_MAX_INSTALLS },
  },
};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    const body = STUBS[url];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not stubbed' }));
    return;
  }
  const abs = path.join(WEB_DIST, url === '/' ? '/index.html' : url);
  if (!abs.startsWith(WEB_DIST) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(path.join(WEB_DIST, 'index.html')));
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(abs));
});
await new Promise((r) => server.listen(PORT, r));

const failures = [];
const passes = [];
const check = (name, cond, detail) => (cond ? passes : failures).push(`${name}${detail ? ` — ${detail}` : ''}`);

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
} catch (err) {
  server.close();
  skip(`could not launch chromium (${err.message.split('\n')[0]}); set PW_CHROMIUM`);
}

const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

const box = page.getByLabel('Custom number of leads');
await box.waitFor({ state: 'visible', timeout: 15_000 });
await box.scrollIntoViewIfNeeded();

// 1. Geometry — the actual defect. 18px wide leaves nowhere for text to render.
const rect = await box.boundingBox();
check('width is usable', rect.width >= 80, `${Math.round(rect.width)}px`);
check('height is usable', rect.height >= 24, `${Math.round(rect.height)}px`);

// 2. Click then type, exactly as a user does. If the label steals focus to the
//    radio, or the click lands on the spinner, this catches it.
await box.click();
const focused = await page.evaluate(
  () => `${document.activeElement?.tagName}[${document.activeElement?.getAttribute('type')}]`,
);
check('click focuses the number box, not the radio', focused === 'INPUT[number]', focused);
await page.keyboard.type('250', { delay: 30 });
const typed = await box.inputValue();
check('keystrokes land in the box', typed === '250', `value="${typed}"`);

// 3. Typing must select Custom, else the number is silently ignored on submit.
const customChecked = () =>
  page.evaluate(() => {
    const r = [...document.querySelectorAll('input[name="maxLeads"]')];
    return r[r.length - 1]?.checked;
  });
check('typing selects the Custom radio', (await customChecked()) === true);

const hintVisible = () => page.getByText(/Enter a whole number between/).isVisible().catch(() => false);
const startEnabled = () => page.getByRole('button', { name: /Start search/i }).isEnabled();
check('validation hint clears on a valid number', !(await hintVisible()));
check('Start is enabled with a valid custom number', await startEnabled());

// 4. Emptying must re-block, never silently fall back to "as many as found".
await box.fill('');
check('empty custom box re-blocks with a hint', await hintVisible());
check('Start is disabled with an empty custom box', !(await startEnabled()));

// 5. Presets still work and clear Custom.
await page.getByText('As many as found').click();
check('picking a preset clears Custom', (await customChecked()) === false);
check('preset restores an enabled Start', await startEnabled());

// 6. Sibling controls must be unharmed by the CSS rescope.
const sizeOf = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.width), Math.round(b.height)];
  }, sel);
const radio = await sizeOf('input[name="maxLeads"]');
check('radio dots still 18x18', radio?.[0] === 18 && radio?.[1] === 18, radio?.join('x'));
const cb = await sizeOf('.checkbox input[type="checkbox"]');
check('country checkboxes still 18x18', !cb || (cb[0] === 18 && cb[1] === 18), cb ? cb.join('x') : 'none rendered');

const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check('no horizontal overflow', overflow <= 0, `${overflow}px`);

// 7. Out-of-range / junk must be rejected, not clamped or floored.
for (const [bad, why] of [['999999', 'above max'], ['0', 'zero'], ['2.5', 'decimal'], ['-5', 'negative']]) {
  await box.fill(bad);
  check(`rejects ${why} (${bad})`, await hintVisible());
}

// 8. THE PAYLOAD. A box you can type into that submits the wrong cap is the same
//    bug wearing a disguise.
await box.fill('250');
let posted = null;
await page.route('**/api/jobs', async (route) => {
  if (route.request().method() === 'POST') {
    posted = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'job_probe' }) });
  } else await route.continue();
});
await page.getByRole('button', { name: /Start search/i }).click();
await page.waitForTimeout(1500);
check('typed number reaches the API payload', posted?.maxLeads === 250, `maxLeads=${JSON.stringify(posted?.maxLeads)}`);

if (failures.length) {
  const shot = path.join(os.tmpdir(), 'custom-lead-box-FAIL.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.error(`custom-lead-box probe FAILED (${failures.length}/${passes.length + failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`  screenshot: ${shot}`);
} else {
  console.log(`custom-lead-box probe ok (${passes.length} assertions)`);
}

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
