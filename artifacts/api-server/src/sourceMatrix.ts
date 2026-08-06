/**
 * What discovery this app can actually do — ONE table, two views.
 *
 * This app carries two source vocabularies, and conflating them is what order
 * L-3.3c exists to fix:
 *
 *  • The USER-FACING one: the four source buttons on the New Job form, each with
 *    a mobile/cps mode. This is what a human picks, what the Chief commands, and
 *    the only vocabulary that ever appears on the machine wire.
 *  • The STORED one: `JobSource` (db.ts), the id written to `jobs.source` and
 *    dispatched on by queue.ts. It has FIVE values, because "Google Ads" means
 *    two different engines depending on the mode.
 *
 * The dashboard has always done the mapping itself, in one expression
 * (NewJobForm.tsx: `srcChoice === 'google_ads' ? (mode === 'mobile' ?
 * 'store_first' : 'google_ads') : srcChoice`), and labelled the stored id back
 * on the way out (App.tsx: `store_first: 'GOOGLE ADS - MOBILE'`). Order L-3.3a
 * mirrored only the STORED layer into the machine surface and published it as
 * the wire vocabulary, so the Chief was made to speak storage ids while every
 * human speaks UI labels — and its first command, `google_ads` + `mobile`, was
 * refused for naming a combination this app supports and runs every day.
 *
 * MATRIX below is the single source of truth. Everything else in this file is a
 * derived view of it:
 *
 *  • the machine surface asks `resolveStoredSource(source, target)` — is this
 *    pair real, and which engine is it?
 *  • the human route asks `targetsForStoredSource(stored)` — which product types
 *    may this ALREADY-MAPPED id run? That view is derived by inverting MATRIX,
 *    not written down a second time, which is what makes the two paths unable to
 *    disagree. `scripts/check-source-matrix.mjs` fails the test gate if the
 *    dashboard's mapping expression ever drifts from this table.
 *
 * Adding a source or an engine means editing MATRIX and nothing else.
 */

import type { JobSource, ProductType } from './db.js';

/**
 * The sources a caller names. Closed, and deliberately NOT `JobSource`:
 * `store_first` is a storage id, never an input. It is reached by naming
 * `google_ads` with `target_type: 'mobile'`, exactly as the human form reaches
 * it, so one capability never wears two names on the wire.
 */
export const UI_SOURCES = ['google_ads', 'meta', 'affplus', 'appgoblin'] as const;
export type UiSource = (typeof UI_SOURCES)[number];

/** The product types a caller names. Closed. Identical to `ProductType`. */
export const TARGET_TYPES = ['mobile', 'cps'] as const;

/**
 * THE TABLE. `MATRIX[source][target]` is the engine that pair runs, or absent
 * when this app cannot run it.
 *
 * The two mobile/cps splits are the whole reason this file exists:
 *
 *  • `google_ads` + `cps` → the Google Ads Transparency engine, whose advertiser
 *    search matches advertiser names and verified domains. It resolves web/CPS
 *    advertisers well and structurally cannot enumerate app advertisers.
 *  • `google_ads` + `mobile` → `store_first`, which harvests the app stores and
 *    runs its own transparency confirmation. This is the mobile path; a GATC
 *    mobile job would be a slower, worse duplicate of it, which is why the
 *    engine does not accept one.
 *
 * `appgoblin` is an app-store intelligence site and has no web/CPS side at all —
 * the one pair this app genuinely cannot run.
 */
const MATRIX: Readonly<Record<UiSource, Readonly<Partial<Record<ProductType, JobSource>>>>> = {
  google_ads: { mobile: 'store_first', cps: 'google_ads' },
  meta: { mobile: 'meta', cps: 'meta' },
  affplus: { mobile: 'affplus', cps: 'affplus' },
  appgoblin: { mobile: 'appgoblin' },
};

/**
 * Every engine MATRIX can name. Declared so the compiler can prove the table
 * covers `JobSource`: if db.ts gains a sixth source and MATRIX never produces
 * it, `_enginesCoverJobSource` below stops compiling.
 *
 * Without that proof the failure is silent and ugly — `targetsForStoredSource`
 * would answer `[]` for the new id, and the human route would refuse every
 * product type for it with the degenerate message "X source supports
 * productType= only".
 */
export const ENGINES = ['store_first', 'google_ads', 'meta', 'affplus', 'appgoblin'] as const;
const _enginesCoverJobSource: Exclude<JobSource, (typeof ENGINES)[number]> extends never
  ? true
  : ['MATRIX does not cover every JobSource — add the new source to it'] = true;
void _enginesCoverJobSource;

/** Is this one of the four names a caller may use? Narrows the type. */
export function isUiSource(v: string): v is UiSource {
  return (UI_SOURCES as readonly string[]).includes(v);
}

/** Is this one of the two target types a caller may use? Narrows the type. */
export function isTargetType(v: string): v is ProductType {
  return (TARGET_TYPES as readonly string[]).includes(v);
}

/**
 * The engine behind a caller's (source, target) pair, or null when this app
 * cannot run it.
 *
 * Callers MUST have already established that `source` and `target` are members
 * of the two closed lists above — this is a lookup, not a validator, and a
 * lookup that invented a verdict for an unknown key would widen the vocabulary
 * silently. The signature makes that structural: neither parameter accepts a
 * bare `string`.
 */
export function resolveStoredSource(source: UiSource, target: ProductType): JobSource | null {
  const row = row_(source);
  if (!row) return null;
  return has_(row, target) ? row[target] ?? null : null;
}

/** The target types a caller may name for this source, in TARGET_TYPES order. */
export function targetsForUiSource(source: UiSource): ProductType[] {
  const row = row_(source);
  if (!row) return [];
  return TARGET_TYPES.filter((t) => has_(row, t) && row[t] != null);
}

/**
 * Own-property lookups, so an unknown key answers "no" instead of reaching
 * `Object.prototype` or throwing.
 *
 * `MATRIX[k]` is not safe on an arbitrary string even though the signatures say
 * it is: `MATRIX['']` is `undefined` and indexing that throws a TypeError, while
 * `MATRIX['constructor']` yields a function that is not an engine. Both callers
 * allowlist before they get here and TypeScript refuses a bare string, so this
 * is defence in depth rather than a live hole — but a lookup that throws on an
 * unknown key is a landmine for the next caller, and this file exists precisely
 * to be the one place nobody has to think twice about.
 */
const has_ = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const row_ = (source: string): Readonly<Partial<Record<ProductType, JobSource>>> | null =>
  has_(MATRIX, source) ? MATRIX[source as UiSource] : null;

/**
 * The product types an ALREADY-MAPPED stored id may run — the human route's
 * view, since the dashboard maps before it posts.
 *
 * Derived by inverting MATRIX rather than written down again. That derivation
 * reproduces routes-jobs.ts's original hand-written rules exactly: `store_first`
 * and `appgoblin` mobile-only, `google_ads` cps-only, `meta` and `affplus` both.
 */
export function targetsForStoredSource(stored: JobSource): ProductType[] {
  const out: ProductType[] = [];
  for (const t of TARGET_TYPES) {
    for (const s of UI_SOURCES) {
      if (MATRIX[s][t] === stored) {
        out.push(t);
        break;
      }
    }
  }
  return out;
}

/**
 * The name a caller knows this stored id by — the inverse of the mapping, used
 * to echo a commanded job back in the vocabulary it was commanded in.
 *
 * `store_first` answers `google_ads`, which is the same thing App.tsx does when
 * it renders that id as "GOOGLE ADS - MOBILE". Total over `JobSource`: every
 * stored id this app can write appears in MATRIX.
 */
export function uiSourceForStored(stored: JobSource): UiSource {
  for (const s of UI_SOURCES) {
    for (const t of TARGET_TYPES) {
      if (MATRIX[s][t] === stored) return s;
    }
  }
  // Unreachable while MATRIX covers JobSource — proven by a test rather than
  // trusted. Answering the stored id is the honest fallback: it is wrong as a
  // label but it is never a lie about which engine ran.
  return stored as UiSource;
}

/**
 * The refusal for a pair this app cannot run, stating the real supported set for
 * the source the caller actually named.
 */
export function unsupportedPairMessage(source: UiSource): string {
  const ok = targetsForUiSource(source);
  return `source ${source} supports target_type ${ok.join(' and ')} only`;
}

// ── offline tests (pure — no DB, no network, no socket) ──────────────────────

export function runSourceMatrixTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // ── the caller-facing view ──
  check(UI_SOURCES.length === 4, 'four sources a caller may name');
  check(!(UI_SOURCES as readonly string[]).includes('store_first'), 'store_first is never an input name');
  check(isUiSource('google_ads') && !isUiSource('store_first'), 'the source guard admits exactly the four');
  check(!isUiSource('Google_Ads') && !isUiSource('__proto__'), 'the source guard is case-sensitive and not fooled');
  check(isTargetType('mobile') && isTargetType('cps') && !isTargetType('web'), 'the target guard admits exactly the two');

  check(resolveStoredSource('google_ads', 'mobile') === 'store_first', 'google_ads + mobile is the store engine');
  check(resolveStoredSource('google_ads', 'cps') === 'google_ads', 'google_ads + cps is the transparency engine');
  check(resolveStoredSource('appgoblin', 'cps') === null, 'appgoblin + cps is the one pair this app cannot run');
  check(resolveStoredSource('meta', 'mobile') === 'meta', 'meta submits as itself');
  check(resolveStoredSource('affplus', 'cps') === 'affplus', 'affplus submits as itself');

  check(
    targetsForUiSource('google_ads').join(',') === 'mobile,cps',
    'google_ads offers both target types to a caller',
  );
  check(targetsForUiSource('appgoblin').join(',') === 'mobile', 'appgoblin offers mobile only');

  // ── the lookup cannot widen the vocabulary ──
  //
  // Both callers allowlist before they look up (chief.ts via isUiSource /
  // isTargetType, routes-jobs.ts via its five-literal source check), and the
  // signatures refuse a bare string. This proves the layer underneath holds
  // anyway: called with a hostile key from plain JS, the lookup invents nothing.
  const hostile = ['__proto__', 'constructor', 'prototype', 'toString', 'store_first', '', 'GOOGLE_ADS'];
  for (const key of hostile) {
    check(!isUiSource(key), `the source guard rejects ${JSON.stringify(key)}`);
    check(!isTargetType(key), `the target guard rejects ${JSON.stringify(key)}`);
    const asSource = resolveStoredSource(key as UiSource, 'mobile');
    const asTarget = resolveStoredSource('meta', key as ProductType);
    check(
      asSource === null || (ENGINES as readonly string[]).includes(asSource),
      `a hostile source key never yields a non-engine (${JSON.stringify(key)} → ${String(asSource)})`,
    );
    check(
      asTarget === null || (ENGINES as readonly string[]).includes(asTarget),
      `a hostile target key never yields a non-engine (${JSON.stringify(key)} → ${String(asTarget)})`,
    );
  }
  check(
    targetsForUiSource('__proto__' as UiSource).length === 0,
    'a hostile source name has no supported target types',
  );

  // ── the human route's view ──
  //
  // These five lines ARE routes-jobs.ts's original hand-written rules. Before
  // L-3.3c they were two `if`s in that file; the point of deriving them from
  // MATRIX is that they still say exactly this. If a line here changes, a
  // human's job-creation behaviour changed with it.
  check(targetsForStoredSource('store_first').join(',') === 'mobile', 'human: store_first is mobile-only');
  check(targetsForStoredSource('appgoblin').join(',') === 'mobile', 'human: appgoblin is mobile-only');
  check(targetsForStoredSource('google_ads').join(',') === 'cps', 'human: google_ads (GATC) is cps-only');
  check(targetsForStoredSource('meta').join(',') === 'mobile,cps', 'human: meta takes both');
  check(targetsForStoredSource('affplus').join(',') === 'mobile,cps', 'human: affplus takes both');

  // Every engine is reachable and non-degenerate. An engine MATRIX never names
  // would answer [] here, and the human route would then refuse every product
  // type for it with "… supports productType= only".
  for (const engine of ENGINES) {
    check(targetsForStoredSource(engine).length > 0, `every engine runs at least one target type (${engine})`);
    check(
      (UI_SOURCES as readonly string[]).includes(uiSourceForStored(engine)),
      `every engine maps back to a real source name (${engine})`,
    );
  }
  check(uiSourceForStored('store_first') === 'google_ads', 'store_first reads back as google_ads, never as itself');

  // ── the two views agree ──
  // The invariant the whole file exists for: if the machine surface accepts a
  // pair, the human route accepts that engine with that product type too.
  let pairs = 0;
  for (const s of UI_SOURCES) {
    for (const t of TARGET_TYPES) {
      const stored = resolveStoredSource(s, t);
      if (stored === null) continue;
      pairs++;
      check(
        targetsForStoredSource(stored).includes(t),
        `both views agree on ${s} + ${t} (engine ${stored})`,
      );
    }
  }
  check(pairs === 7, `seven runnable pairs (got ${pairs})`);

  // ── refusal messages state the real supported set ──
  check(
    unsupportedPairMessage('appgoblin') === 'source appgoblin supports target_type mobile only',
    'the refusal names appgoblin’s real supported set',
  );
  // A source with an empty supported set would render "source x supports
  // target_type  only" — a double space and no answer. Nothing may read that way.
  for (const s of UI_SOURCES) {
    const msg = unsupportedPairMessage(s);
    check(
      !msg.includes('  ') && TARGET_TYPES.some((t) => msg.includes(t)),
      `the refusal for ${s} names at least one target type (got "${msg}")`,
    );
  }

  return { passed, failed: failures.length, failures };
}

const isMainSourceMatrix =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('sourceMatrix.js') || process.argv[1].endsWith('sourceMatrix.ts'));
if (isMainSourceMatrix) {
  const { passed, failed, failures } = runSourceMatrixTests();
  console.log(`sourceMatrix: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
