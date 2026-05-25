import fs from 'node:fs';

// SvelteKit __data.json uses devalue's wire format:
// - data is a flat array. data[0] is the root.
// - Inside any object/array, numeric values are INDICES into data.
// - Leaf primitives (strings, real numbers, booleans, null) live at their own index.
// - Negative numbers are special markers: -1=undefined, -2=hole, -3=NaN, -4=+Inf, -5=-Inf, -6=-0.

function devalueParse(pool) {
  const seen = new Map();
  function deref(idx) {
    if (idx === -1) return undefined;
    if (idx === -2) return undefined; // hole
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
    // Special devalue object wrappers like {"@type":"Set",...} — skip for now.
    const out = {};
    seen.set(idx, out);
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === 'number' ? deref(v) : v;
    }
    return out;
  }
  return deref(0);
}

function describeShape(obj, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth) return '…';
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)?.slice(0, 80);
  if (Array.isArray(obj)) {
    return `[len=${obj.length}, first=${describeShape(obj[0], depth + 1, maxDepth)}]`;
  }
  const keys = Object.keys(obj);
  return `{${keys.slice(0, 12).join(',')}${keys.length > 12 ? ',…+' + (keys.length - 12) : ''}}`;
}

const files = [
  ['artifacts/api-server/fixtures/appgoblin_company_appsflyer.json', 'company/appsflyer'],
  ['artifacts/api-server/fixtures/appgoblin_category_game_casino.json', 'category/game_casino'],
];

for (const [path, label] of files) {
  console.log('\n=========================');
  console.log('FILE:', label);
  console.log('=========================');
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(j.nodes)) continue;

  for (let ni = 0; ni < j.nodes.length; ni++) {
    const node = j.nodes[ni];
    if (!node || node.type !== 'data' || !Array.isArray(node.data)) {
      console.log(`node[${ni}]: skipped (type=${node?.type})`);
      continue;
    }
    let root;
    try {
      root = devalueParse(node.data);
    } catch (err) {
      console.log(`node[${ni}]: decode failed: ${err.message}`);
      continue;
    }
    console.log(`\nnode[${ni}] root keys: ${describeShape(root)}`);
    if (root && typeof root === 'object') {
      for (const [k, v] of Object.entries(root)) {
        const shape = describeShape(v, 1, 4);
        console.log(`  ${k}: ${shape}`);
        // For arrays, show first element's shape
        if (Array.isArray(v) && v.length > 0) {
          console.log(`    [0]: ${describeShape(v[0], 1, 5)}`);
        }
        // Drill one more level for objects
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v)) {
            console.log(`    .${k2}: ${describeShape(v2, 1, 4)}`);
            if (Array.isArray(v2) && v2.length > 0) {
              console.log(`      [0]: ${describeShape(v2[0], 1, 5)}`);
            }
          }
        }
      }
    }
  }
}