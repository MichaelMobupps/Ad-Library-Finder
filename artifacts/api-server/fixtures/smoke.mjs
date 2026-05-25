// End-to-end smoke test: scrape AppGoblin via the live API, print first 10 rows.
import { scrapeAppgoblin, fetchAppgoblinCategoryList } from '../dist/appgoblinScraper.js';

const log = (level, msg) => console.log(`  [${level}] ${msg}`);

console.log('\n=== category list (real slugs from appgoblin.info) ===');
const cats = await fetchAppgoblinCategoryList(log);
console.log(`Got ${cats.length} categories:`);
const printed = cats.slice(0, 20);
for (const c of printed) {
  console.log(`  ${c.id.padEnd(28)}  ${c.name.padEnd(28)}  total_apps=${c.total_apps.toLocaleString()}`);
}
if (cats.length > 20) console.log(`  ...and ${cats.length - 20} more`);

console.log('\n=== ad-network mode (appsflyer.com) — should return ~20 apps ===');
const r1 = await scrapeAppgoblin({
  adNetworkDomain: 'appsflyer.com',
  onLog: log,
});
console.log(`Got ${r1.apps.length} apps from ${r1.companiesFetched} company-fetches.`);
console.log('First 10 rows:');
for (const a of r1.apps.slice(0, 10)) {
  console.log(`  - ${a.name.padEnd(40)}  store=${a.store.padEnd(18)}  dev=${(a.developer_name || '').padEnd(28)}  link=${a.store_link}`);
}

console.log('\n=== category mode (game_casino, top 5 companies) ===');
const r2 = await scrapeAppgoblin({
  category: 'game_casino',
  companiesLimit: 5,
  onLog: log,
});
console.log(`Got ${r2.apps.length} unique apps from ${r2.companiesFetched} companies.`);
console.log('First 10 rows:');
for (const a of r2.apps.slice(0, 10)) {
  console.log(`  - ${a.name.padEnd(40)}  store=${a.store.padEnd(18)}  dev=${(a.developer_name || '').padEnd(28)}  link=${a.store_link}`);
}

// Validate the assertions:
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
console.log('\n=== assertions ===');
check('category list ≥ 40', cats.length >= 40);
check('game_casino present', cats.some((c) => c.id === 'game_casino'));
check('appsflyer mode returned ≥ 10 apps', r1.apps.length >= 10);
check('every appsflyer app has store_link with apps.apple.com or play.google.com',
  r1.apps.every((a) => /apps\.apple\.com|play\.google\.com/.test(a.store_link)));
check('category mode returned ≥ 10 apps', r2.apps.length >= 10);
check('every category app has store_link with apps.apple.com or play.google.com',
  r2.apps.every((a) => /apps\.apple\.com|play\.google\.com/.test(a.store_link)));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);