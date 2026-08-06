#!/usr/bin/env node
/**
 * Mirror-drift gate for the source × target capability matrix.
 *
 * `sourceMatrix.ts` is the server's single truth about which (source, target)
 * pairs this app can run and which engine each one is. The dashboard cannot
 * import it — it is a separate workspace package — so it carries the same
 * mapping in one expression of its own (NewJobForm.tsx) and the reverse labelling
 * in another (App.tsx). Same pattern, and the same reason, as
 * check-country-mirror.mjs.
 *
 * Why it matters: order L-3.3c exists because these drifted apart silently. The
 * machine surface was built from the STORED source vocabulary and so refused
 * `google_ads` + `mobile` — a pair the human form maps to the `store_first`
 * engine and runs every day. Nothing failed; the Chief just got a 400 it could
 * not explain. This gate makes that class of drift a test failure.
 *
 * The dashboard's mapping is not string-matched — it is EVALUATED for every
 * (choice, mode) pair and compared against the matrix, so a rewrite that keeps
 * the same meaning passes and one that changes the meaning fails.
 *
 * Run standalone, or via `npm test`, which invokes it after the unit suites.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { UI_SOURCES, TARGET_TYPES, resolveStoredSource, uiSourceForStored } = await import(
  `${ROOT}/dist/sourceMatrix.js`
);

const formSrc = readFileSync(path.resolve(ROOT, '../dashboard/src/NewJobForm.tsx'), 'utf8');
const appSrc = readFileSync(path.resolve(ROOT, '../dashboard/src/App.tsx'), 'utf8');

let fails = 0;
const fail = (msg) => {
  console.log(`✗ ${msg}`);
  fails++;
};

// ── 1. The four source names the form offers ────────────────────────────────
const choiceDecl = formSrc.match(/type SourceChoice\s*=\s*([^;]+);/);
if (!choiceDecl) {
  fail('could not locate `type SourceChoice` in dashboard/src/NewJobForm.tsx');
} else {
  const uiChoices = [...choiceDecl[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (uiChoices.length === 0) {
    fail('SourceChoice parsed as empty — the gate would pass vacuously');
  } else if (uiChoices.join(',') !== [...UI_SOURCES].join(',')) {
    fail(`source names differ — form [${uiChoices.join(', ')}] vs matrix [${[...UI_SOURCES].join(', ')}]`);
  }
}

// ── 2. The form's choice+mode → stored-id mapping, evaluated ────────────────
const mapDecl = formSrc.match(/const source:\s*JobSource\s*=\s*([\s\S]*?);\n/);
if (!mapDecl) {
  fail('could not locate the `const source: JobSource = …` mapping in NewJobForm.tsx');
} else {
  let mapFn = null;
  try {
    // The expression is pure and has exactly two free variables. Evaluating it
    // tests what it MEANS, so a refactor that preserves behaviour still passes.
    mapFn = new Function('srcChoice', 'mode', `return (${mapDecl[1].trim()});`);
  } catch (e) {
    fail(`the form's mapping expression did not parse: ${e.message}`);
  }
  if (mapFn) {
    let compared = 0;
    for (const source of UI_SOURCES) {
      for (const target of TARGET_TYPES) {
        const expected = resolveStoredSource(source, target);
        if (expected === null) continue; // the form cannot submit this pair; see 3
        let got;
        try {
          got = mapFn(source, target);
        } catch (e) {
          fail(`the form's mapping threw on ${source}/${target}: ${e.message}`);
          continue;
        }
        compared++;
        if (got !== expected) {
          fail(`${source} + ${target}: form submits '${got}', matrix says '${expected}'`);
        }
      }
    }
    if (compared === 0) fail('no pairs were compared — the gate would pass vacuously');

    // Every engine the form can submit must be one the matrix knows. This is the
    // check that names order L-3.3c's defect directly: drop `store_first` from
    // the matrix and the form is still submitting it, so the server would refuse
    // a job the UI offers. The loop above cannot see that — it only walks pairs
    // the matrix still admits, which is exactly the set a deletion shrinks.
    const matrixEngines = new Set(
      UI_SOURCES.flatMap((s) => TARGET_TYPES.map((t) => resolveStoredSource(s, t))).filter(Boolean),
    );
    for (const source of UI_SOURCES) {
      for (const target of TARGET_TYPES) {
        let submitted;
        try {
          submitted = mapFn(source, target);
        } catch {
          continue; // already reported above
        }
        if (!matrixEngines.has(submitted)) {
          fail(
            `the form submits '${submitted}' for ${source} + ${target}, but the matrix has no such engine ` +
              `— the server would refuse a job the UI offers`,
          );
        }
      }
    }
  }
}

// ── 3. The pairs the matrix refuses must be unreachable in the form ─────────
// The form has no "unsupported" state: it prevents the pair instead. AppGoblin
// is mobile-only, and picking it forces the mode. If that guard goes, a human
// can submit a pair the server will refuse — a dead end in the UI, not a
// security problem, but exactly the drift this gate exists to catch.
for (const source of UI_SOURCES) {
  const refused = TARGET_TYPES.filter((t) => resolveStoredSource(source, t) === null);
  if (refused.length === 0) continue;
  const guard = new RegExp(`if\\s*\\(\\s*s\\s*===\\s*'${source}'\\s*\\)\\s*setMode\\(`);
  if (!guard.test(formSrc)) {
    fail(
      `${source} cannot run ${refused.join('/')}, but NewJobForm has no pickSource guard forcing its mode`,
    );
  }
}

// ── 4. The reverse labelling ────────────────────────────────────────────────
// Every stored id the matrix can produce must read back to a human as the source
// they picked. `store_first` is the one that would otherwise leak the storage
// name into the UI.
const labelBlock = appSrc.match(/const SOURCE_LABELS:[^=]*=\s*\{([\s\S]*?)\}/);
if (!labelBlock) {
  fail('could not locate SOURCE_LABELS in dashboard/src/App.tsx');
} else {
  const labels = Object.fromEntries(
    [...labelBlock[1].matchAll(/([a-z_]+)\s*:\s*'([^']*)'/g)].map((m) => [m[1], m[2]]),
  );
  for (const source of UI_SOURCES) {
    for (const target of TARGET_TYPES) {
      const stored = resolveStoredSource(source, target);
      if (stored === null || stored === source) continue; // no rename needed
      // A stored id whose name differs from the source the user picked MUST be
      // relabelled, or the human UI shows a word the user never chose.
      if (!labels[stored]) {
        fail(`stored id '${stored}' (from ${source} + ${target}) has no SOURCE_LABELS entry in App.tsx`);
        continue;
      }
      const back = uiSourceForStored(stored);
      const want = back.replace(/_/g, ' ').toUpperCase();
      if (!labels[stored].toUpperCase().startsWith(want)) {
        fail(`'${stored}' is labelled '${labels[stored]}', which does not read as the ${back} source`);
      }
    }
  }
}

if (!fails) {
  const pairs = UI_SOURCES.flatMap((s) =>
    TARGET_TYPES.filter((t) => resolveStoredSource(s, t) !== null).map((t) => `${s}/${t}`),
  );
  console.log(`✓ source matrix in sync with the dashboard (${pairs.length} runnable pairs: ${pairs.join(', ')})`);
}
console.log(fails === 0 ? 'SOURCE MATRIX: in sync' : `SOURCE MATRIX: ${fails} problem(s)`);
process.exit(fails ? 1 : 0);
