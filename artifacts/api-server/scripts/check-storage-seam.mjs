#!/usr/bin/env node
/**
 * Storage-seam source gate (order L-3.4g). Two properties, both static.
 *
 * ── 1. THE SQLITE FILE IS GONE FROM SERVER CODE ──────────────────────────────
 * No module under src/ may import `better-sqlite3`, construct a `Database`, or
 * name `ad-library.sqlite`. That file lived on the deployment's filesystem,
 * which a Reserved VM does not carry across a publish — every job, lead and
 * session this app had ever recorded was thrown away on each deploy, and chief
 * job job_7nQAfTUr1v was confirmed already lost to it. A single re-introduced
 * import would silently restore that behaviour for whatever it touched, and
 * nothing in a passing test suite would look different.
 *
 * ── 2. NO STORAGE WRITE IS LEFT UNAWAITED ────────────────────────────────────
 * Every database helper became async in this order. TypeScript catches a
 * forgotten `await` on a READ (a Promise is not a JobRow) but cannot catch one
 * on a WRITE: `appendLog(...)` returning an ignored Promise compiles perfectly
 * and then races, or vanishes when the process exits first.
 *
 * That is not hypothetical. This check was written after exactly two such bugs
 * survived the compiler in this very order:
 *   • publisherRollup.ts's fast lane called upsertPublisher() without await, so
 *     it reported "1 publisher" while the row was still in flight and the table
 *     stayed empty;
 *   • storeDiscoveryDb.ts absorbed duplicate publishers without awaiting, which
 *     would have lost merges under any real concurrency.
 * The fast-lane gate caught the first by luck — its next assertion happened to
 * read the row back. Nothing would have caught the second.
 *
 * So: any call whose static type is a Promise and whose result is DISCARDED is
 * an error. `void expr` is the escape hatch for a deliberate fire-and-forget,
 * and it has to be written down.
 */
import ts from '../node_modules/typescript/lib/typescript.js';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failures++;
};
const ok = (m) => console.log(`  ✓ ${m}`);

// ── 1. the sqlite ban ────────────────────────────────────────────────────────

const BANNED = [
  { re: /from\s+['"]better-sqlite3['"]/, what: "an import of better-sqlite3" },
  { re: /require\(\s*['"]better-sqlite3['"]\s*\)/, what: "a require of better-sqlite3" },
  { re: /\bnew\s+Database\s*\(/, what: 'a `new Database(...)` construction' },
  { re: /ad-library\.sqlite/, what: 'the old database filename' },
];

let banHits = 0;
for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
  const text = readFileSync(path.join(SRC, file), 'utf8');
  // Comments may DISCUSS the old engine — this file's own header does, and so
  // does sql.ts's. Only code counts, so strip comments before matching.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const { re, what } of BANNED) {
    if (re.test(code)) {
      fail(`src/${file} contains ${what} — server state must never touch a deployment-disk file`);
      banHits++;
    }
  }
}
if (banHits === 0) ok('no module under src/ opens the old sqlite database');

// ── 2. no floating storage promise ───────────────────────────────────────────

const cfg = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();

const isPromise = (node) => /^Promise</.test(checker.typeToString(checker.getTypeAtLocation(node)));

let floating = 0;
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !sf.fileName.startsWith(SRC + path.sep)) continue;

  const visit = (node) => {
    // A call (or optional-call) standing alone as a statement discards whatever
    // it returned. That is fine for a synchronous helper and a bug for a Promise.
    if (ts.isExpressionStatement(node)) {
      const expr = node.expression;
      const isCallish =
        ts.isCallExpression(expr) || (ts.isAwaitExpression(expr) === false && ts.isCallExpression(expr));
      if (isCallish && !ts.isAwaitExpression(expr) && isPromise(expr)) {
        const { line } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
        fail(
          `${path.relative(ROOT, sf.fileName)}:${line + 1} discards a Promise — ` +
            `\`${expr.getText(sf).replace(/\s+/g, ' ').slice(0, 70)}\` (await it, or write \`void\` to say the drop is deliberate)`,
        );
        floating++;
      }
    }
    // `for (…) somePromiseCall();` — a single-statement loop body is not an
    // ExpressionStatement's parent we would otherwise reach differently, but it
    // IS an ExpressionStatement, so the branch above covers it. Kept explicit
    // here only as a reminder that it was considered.
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}
if (floating === 0) ok('every storage call is awaited (no discarded Promise in src/)');

// ── 3. the migrations are non-destructive ────────────────────────────────────
// The standing fleet rule, enforced rather than reviewed: a generated migration
// containing DROP is never approved.
const { assertNoDestructiveMigrations } = await import(`${ROOT}/dist/migrations.js`);
try {
  assertNoDestructiveMigrations();
  ok('no shipped migration contains DROP or TRUNCATE');
} catch (err) {
  fail(`migrations: ${err.message}`);
}

process.exit(failures === 0 ? 0 : 1);
