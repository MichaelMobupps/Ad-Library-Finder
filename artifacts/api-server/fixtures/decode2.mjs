import fs from 'node:fs';

function devalueParse(pool) {
  const seen = new Map();
  function deref(idx) {
    if (idx === -1) return undefined;
    if (idx === -2) return undefined;
    if (idx === -3) return NaN;
    if (idx === -4) return Infinity;
    if (idx === -5) return -Infinity;
    if (idx === -6) return -0;
    if (typeof idx !== 'number' || idx < 0 || idx >= pool.length) return idx;
    if (seen.has(idx)) return seen.get(idx);
    const raw = pool[idx];
    if (raw === null) { seen.set(idx, null); return null; }
    if (typeof raw !== 'object') { seen.set(idx, raw); return raw; }
    if (Array.isArray(raw)) {
      const out = [];
      seen.set(idx, out);
      for (const v of raw) out.push(typeof v === 'number' ? deref(v) : v);
      return out;
    }
    const out = {};
    seen.set(idx, out);
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === 'number' ? deref(v) : v;
    }
    return out;
  }
  return deref(0);
}

console.log('\n===== COMPANY (appsflyer): companyTopApps =====');
{
  const j = JSON.parse(fs.readFileSync('artifacts/api-server/fixtures/appgoblin_company_appsflyer.json', 'utf8'));
  const node4 = devalueParse(j.nodes[4].data);
  const tops = node4.companyTopApps;
  console.log('ios.title:', tops.ios.title);
  console.log('ios.apps len:', tops.ios.apps?.length);
  console.log('android.apps len:', tops.android.apps?.length);
  console.log('--- first iOS app ---');
  console.log(JSON.stringify(tops.ios.apps[0], null, 2));
  console.log('--- first Android app ---');
  console.log(JSON.stringify(tops.android.apps[0], null, 2));
}

console.log('\n===== CATEGORY (game_casino) =====');
{
  const j = JSON.parse(fs.readFileSync('artifacts/api-server/fixtures/appgoblin_category_game_casino.json', 'utf8'));
  // Find the node carrying the heavy payload
  for (let i = 0; i < j.nodes.length; i++) {
    const n = j.nodes[i];
    if (!n || n.type !== 'data' || !Array.isArray(n.data)) continue;
    if (n.data.length < 100) continue; // skip light nodes
    console.log(`\n-- node[${i}] len=${n.data.length} --`);
    const root = devalueParse(n.data);
    const keys = Object.keys(root);
    console.log('root keys:', keys);
    for (const k of keys) {
      const v = root[k];
      if (Array.isArray(v)) {
        console.log(`  ${k}: array(len=${v.length})`);
        if (v.length > 0 && v[0] && typeof v[0] === 'object') {
          console.log(`    sample[0]:`, JSON.stringify(v[0]).slice(0, 600));
        }
      } else if (v && typeof v === 'object') {
        const sk = Object.keys(v);
        console.log(`  ${k}: object {${sk.slice(0, 15).join(',')}${sk.length > 15 ? ',…' : ''}}`);
        // Drill in: look for arrays
        for (const k2 of sk) {
          const v2 = v[k2];
          if (Array.isArray(v2) && v2.length > 0) {
            console.log(`    .${k2}: array(len=${v2.length})`);
            if (v2[0] && typeof v2[0] === 'object') {
              console.log(`      sample:`, JSON.stringify(v2[0]).slice(0, 500));
            }
          } else if (v2 && typeof v2 === 'object') {
            console.log(`    .${k2}: object {${Object.keys(v2).slice(0, 10).join(',')}}`);
          }
        }
      }
    }
  }
}