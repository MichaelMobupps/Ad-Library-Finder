#!/usr/bin/env node
/**
 * Gate: form controls must not be silently resized by a broader CSS rule.
 *
 * Why this exists — a real, shipped bug. `.checkbox input { width: 18px }` was
 * written to size the tick/dot controls, but it also matches ANY input nested in
 * a .checkbox row. When the custom lead-count box was added inside the Custom
 * row, that rule (specificity 0,1,1) silently beat `.input-inline` (0,1,0) and
 * squashed the box to 18x18. The control still existed, still focused, still
 * held state — it just had no room to render text, so the box looked like a tiny
 * empty oval and clicking it hit the number spinner instead of placing a caret.
 * Nothing threw; tsc was happy; the unit suites were happy. Only a human looking
 * at the page could tell, and the user hit it before we did.
 *
 * The lesson generalised: an element-type descendant selector under a class is a
 * standing trap, because it silently captures every control added to that
 * container later. So this gate forbids the pattern for sizing declarations on
 * form controls and requires the type-qualified form instead.
 *
 * Static-only by design: it needs no browser and no build, so it can run in the
 * same cheap gate as everything else. The behavioural counterpart (does the box
 * accept keystrokes, does the number reach the payload) is covered by the
 * browser probe, which cannot run in CI here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.resolve(HERE, '../../dashboard/src/styles.css');

const failures = [];
const fail = (msg) => failures.push(msg);

if (!fs.existsSync(CSS)) {
  console.error(`styles.css not found at ${CSS}`);
  process.exit(1);
}
const css = fs.readFileSync(CSS, 'utf8');

/** Strip comments so commented-out examples never trip the scan. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** [selectorList, declarationBlock] for every top-level rule. */
const rules = [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
  m[1].trim().replace(/\s+/g, ' '),
  m[2],
]);

// 1. No unqualified `.<class> input` rule may set a box dimension. Sizing every
//    input in a container is exactly how the custom lead box got squashed.
const SIZING = /(^|;)\s*(width|height|min-width|min-height|max-width|max-height)\s*:/;
for (const [selectors, decls] of rules) {
  if (!SIZING.test(decls)) continue;
  for (const sel of selectors.split(',').map((s) => s.trim())) {
    // Matches `.foo input` / `.foo > input` but NOT `.foo input[type="radio"]`.
    const broad = /\.[a-zA-Z][\w-]*\s+(>\s*)?(input|select|textarea|button)\s*(:[a-zA-Z-]+)?$/.exec(sel);
    if (broad) {
      // Only <input> is meaningfully narrowed by [type]; the rest need a class.
      const hint = broad[2] === 'input' ? `${sel}[type="radio"]` : `${sel}.some-class`;
      fail(
        `"${sel}" sizes every ${broad[2]} inside that container. Narrow it ` +
          `(e.g. \`${hint}\`) so a control added later is not silently resized.`,
      );
    }
  }
}

// 2. The two rules that were actually in conflict must keep their shape, so a
//    future edit that reintroduces the collision fails here rather than in prod.
const selectorsOf = (re) => rules.filter(([s]) => re.test(s));

const checkboxSizing = selectorsOf(/^\.checkbox input/).filter(([, d]) => SIZING.test(d));
if (checkboxSizing.length === 0) {
  fail('no `.checkbox input[type=...]` sizing rule found — the tick/dot controls are unsized.');
}
for (const [sel] of checkboxSizing) {
  if (!/\[type=/.test(sel)) fail(`"${sel}" must be type-qualified.`);
}

const inline = rules.find(([s]) => s.split(',').some((p) => p.trim() === '.input-inline'));
if (!inline) {
  fail('.input-inline rule is missing — the custom lead box would take full-width .input sizing.');
} else {
  const width = /(^|;)\s*width\s*:\s*([^;]+)/.exec(inline[1])?.[2]?.trim();
  const em = width && /^([\d.]+)em$/.exec(width);
  if (!em || Number(em[1]) < 5) {
    fail(`.input-inline width is "${width ?? 'unset'}" — needs a comfortable em width (>= 5em) to type a lead count into.`);
  }
  // The .checkbox label sets cursor:pointer, which is an inherited property, so
  // without this the text box shows a pointer and reads as a non-editable chip.
  if (!/(^|;)\s*cursor\s*:\s*text/.test(inline[1])) {
    fail('.input-inline must set `cursor: text` — cursor inherits from the .checkbox label (pointer).');
  }
  // .checkbox is a flex row; a bare width is still shrinkable by flex.
  if (!/(^|;)\s*flex\s*:\s*0 0 auto/.test(inline[1])) {
    fail('.input-inline must set `flex: 0 0 auto` — it lives in a flex row and would otherwise shrink.');
  }
}

if (failures.length) {
  console.error('form CSS gate FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`form CSS gate ok (${rules.length} rules scanned)`);
