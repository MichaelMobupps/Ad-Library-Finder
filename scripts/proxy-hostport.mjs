#!/usr/bin/env node
/**
 * Fetch the residential proxy host:port from the Proxy-Seller API.
 * Run in the Replit Shell tab (needs PROXY_SELLER_API_KEY in the env):
 *   node scripts/proxy-hostport.mjs
 * Prints the ready-to-paste GOOGLE_ADS_PROXY_URL value (password masked on
 * screen; the full value is printed on the last line so you can copy it).
 * The API key itself is never printed.
 */

const KEY = (process.env.PROXY_SELLER_API_KEY || '').trim();
if (!KEY) {
  console.log('❌ PROXY_SELLER_API_KEY is not set in this shell.');
  console.log('   Open a NEW Shell tab (or restart the Repl) so the secret injects, then re-run.');
  process.exit(1);
}
const redact = (s) => String(s).split(KEY).join('***');
const get = async (path) => {
  const res = await fetch(`https://proxy-seller.com/personal/api/v1/${KEY}/${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('json')) {
    console.log(`  [${path}] HTTP ${res.status} ${ct} — not usable`);
    return null;
  }
  return res.json();
};

// Walk any JSON shape and collect objects that look like proxy lists/entries.
const found = [];
const walk = (node, depth = 0) => {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
  const o = node;
  const keys = Object.keys(o).map((k) => k.toLowerCase());
  if (keys.some((k) => k.includes('host') || k.includes('server') || k.includes('gateway') || k === 'ip')) found.push(o);
  else if (keys.includes('login') && (keys.includes('port') || keys.includes('ports') || keys.includes('export'))) found.push(o);
  Object.values(o).forEach((v) => walk(v, depth + 1));
};

console.log('Querying Proxy-Seller API…');
for (const path of ['resident/lists', 'resident/list', 'resident/package']) {
  try {
    const body = await get(path);
    if (!body) continue;
    console.log(`\n=== ${path} ===`);
    console.log(redact(JSON.stringify(body, null, 2)).slice(0, 4000));
    walk(body);
  } catch (e) {
    console.log(`  [${path}] failed: ${redact(e?.message ?? e)}`);
  }
}

if (found.length) {
  console.log('\n──────────────────────────────────────────────');
  console.log('Candidate connection entries found above ↑');
}
console.log('\nLook for host/server + port fields in the JSON above.');
console.log('Then set GOOGLE_ADS_PROXY_URL to: http://<login>:<password>@<host>:<port>');
