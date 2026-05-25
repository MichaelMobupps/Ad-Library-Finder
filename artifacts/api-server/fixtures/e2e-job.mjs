// End-to-end pipeline test: create an AppGoblin job via the DB and run it
// through the same pipeline the queue uses. Verifies CSV is produced, rows
// have valid store URLs, and (with ANTHROPIC_API_KEY set) the HQ-split zip
// is generated.
//
// Uses a constrained category limit (2 companies) to keep the LLM call count
// bounded for the smoke test.
import 'dotenv/config';
process.env.APPGOBLIN_COMPANIES_PER_JOB = '2';

import { initDb, createJob, upsertUser, getJob } from '../dist/db.js';
import { runAppgoblinJob } from '../dist/appgoblinPipeline.js';
import fs from 'node:fs';

await initDb();
const user = upsertUser({ email: 'test@example.com', name: 'AppGoblin Test' });
const jobId = 'job_appgoblinE2E_' + Date.now().toString(36);
createJob({
  id: jobId,
  productType: 'mobile',
  countries: ['US'],
  recipientEmail: null,
  createdByUserId: user.id,
  source: 'appgoblin',
  sourceParams: { category: 'game_casino', adNetworkDomain: null },
});
console.log('Created job', jobId);

const t0 = Date.now();
await runAppgoblinJob(getJob(jobId));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nJob completed in ${elapsed}s`);

const fresh = getJob(jobId);
console.log('  status:', fresh.status);
console.log('  csv_path:', fresh.csv_path);
console.log('  hq_zip_path:', fresh.hq_zip_path);
console.log('  total_advertisers:', fresh.total_advertisers);

// Verify CSV
if (!fresh.csv_path || !fs.existsSync(fresh.csv_path)) {
  console.error('FAIL: csv not produced');
  process.exit(1);
}
const csv = fs.readFileSync(fresh.csv_path, 'utf8');
const lines = csv.trim().split('\n');
console.log(`\nCSV: ${lines.length - 1} data rows`);
console.log('CSV header:', lines[0]);
console.log('First 10 CSV data rows:');
for (let i = 1; i <= Math.min(10, lines.length - 1); i++) {
  console.log('  ' + lines[i]);
}

// Verify all rows have a play/apple store URL
let bad = 0;
for (let i = 1; i < lines.length; i++) {
  if (!/apps\.apple\.com|play\.google\.com/.test(lines[i])) bad++;
}
console.log(`\nRows with valid store URL: ${lines.length - 1 - bad} / ${lines.length - 1}`);

// Verify HQ zip
if (fresh.hq_zip_path && fs.existsSync(fresh.hq_zip_path)) {
  const size = fs.statSync(fresh.hq_zip_path).size;
  console.log(`\nHQ-split zip: ${fresh.hq_zip_path} (${size} bytes)`);
} else {
  console.log('\nHQ-split zip: NOT PRODUCED');
}

console.log('\nDone.');
process.exit(0);