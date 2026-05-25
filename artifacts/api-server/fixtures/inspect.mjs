import fs from 'node:fs';

const files = [
  'artifacts/api-server/fixtures/appgoblin_company_appsflyer.json',
  'artifacts/api-server/fixtures/appgoblin_category_game_casino.json',
];

function preview(v, n = 200) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 'undefined' : s.slice(0, n);
  } catch {
    return '[unserializable]';
  }
}

for (const path of files) {
  console.log('\n=========================');
  console.log('FILE:', path);
  console.log('=========================');
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log('top keys:', Object.keys(j));
  console.log('type:', j.type);
  if (!Array.isArray(j.nodes)) {
    console.log('nodes not array; preview:', preview(j, 600));
    continue;
  }
  console.log('nodes len:', j.nodes.length);
  j.nodes.forEach((n, i) => {
    if (!n) { console.log(`  node[${i}]: null`); return; }
    console.log(`  node[${i}] type=${n.type} keys=${Object.keys(n).join(',')}`);
    if (n.type === 'data' && Array.isArray(n.data)) {
      console.log(`    data length: ${n.data.length}`);
      for (let k = 0; k < Math.min(5, n.data.length); k++) {
        console.log(`    data[${k}] (${typeof n.data[k]}): ${preview(n.data[k], 250)}`);
      }
    } else if (n.type === 'data') {
      console.log(`    data not array; preview: ${preview(n.data, 400)}`);
    }
  });
}