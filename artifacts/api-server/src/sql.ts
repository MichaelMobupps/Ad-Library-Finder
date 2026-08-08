/**
 * The database seam. ONE engine, one connection pool, PostgreSQL.
 *
 * WHY THIS FILE EXISTS
 * Until order L-3.4g this app kept every row it had ever written in a
 * `better-sqlite3` file under `data/ad-library.sqlite`, resolved relative to the
 * working directory. That file lived on the deployment's filesystem, and a
 * Reserved VM's disk does NOT survive a publish — `.replitignore` also excludes
 * `data/` from the image, so a published deployment started from an empty
 * database every single time. The proof is not theoretical: chief job
 * `job_7nQAfTUr1v` answered 404 on the live seam while `job_u5I0sjFlo_`, created
 * after the last publish, was still there with its lead ids starting at 21.
 *
 * So state moved off the disk entirely. `DATABASE_URL` is platform-provisioned
 * and points at managed PostgreSQL, which is the only storage in this repo that
 * outlives a deploy.
 *
 * WHY THE ADAPTER LOOKS LIKE better-sqlite3
 * `getDb().prepare(sql).get(a, b)` appears at 115 call sites across nine
 * modules. Rewriting each one into a different calling convention at the same
 * time as changing the engine would mean 115 chances to transpose an argument
 * with nothing but review to catch it. Instead the shape is kept and only the
 * two things that genuinely changed are visible at the call sites:
 *
 *   1. every method is async, so every site gains an `await`, which the
 *      compiler enforces for reads (a Promise is not a JobRow) and
 *      scripts/check-storage-seam.mjs enforces for writes and value positions
 *      (an un-awaited call serialised into JSON ships as `{}`); and
 *   2. `?` placeholders are rewritten to `$1…$n` HERE rather than in 115 SQL
 *      strings, so the SQL in each module is still the SQL that module wrote.
 *
 * This is a deliberate, bounded piece of translation — not a general-purpose
 * ORM, and not a compatibility layer that would let sqlite back in.
 *
 * WHAT IS NOT HERE
 * No fallback. If `DATABASE_URL` is unset or the backend is unreachable, boot
 * fails loudly. A server that silently degrades to a local file is exactly the
 * failure this order exists to end.
 */

import pg from 'pg';
import { log } from './logger.js';

// ── Type parsing ─────────────────────────────────────────────────────────────

/**
 * Every SQLite `INTEGER` column became `bigint` here (see migrations.ts for
 * why), and `pg` hands `int8` back as a STRING by default so no precision is
 * lost on values past 2^53. This app has no such value — its int8 columns are
 * epoch-milliseconds, row ids and counters, all far below that — and a
 * `created_at` that arrived as "1754578305606" instead of a number would break
 * every comparison, every `new Date(ms)` and every JSON response shape the
 * dashboard and the Chief already depend on.
 *
 * So int8 reads back as a JS number, which is exactly what better-sqlite3 did.
 * `count(*)` (also int8) comes back as a number for the same reason, which is
 * what the countX() helpers have always returned.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

/**
 * `REAL` became `double precision` (float8), which `pg` already parses to a
 * number. `numeric` is deliberately NOT re-registered: no column in this schema
 * is numeric, and blanket-casting it to a float is how exact-decimal money
 * columns quietly lose cents in some future order.
 */

// ── The connection string ────────────────────────────────────────────────────

export class DatabaseNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseNotConfiguredError';
  }
}

/**
 * The connection string, or a refusal.
 *
 * Read at call time rather than at module load so a test can point one child
 * process at its own ephemeral cluster through the environment, exactly the way
 * the deployment points the real process at the managed one.
 */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.DATABASE_URL ?? '').trim();
  if (!raw) {
    throw new DatabaseNotConfiguredError(
      'DATABASE_URL is not set. This server stores every job, lead and session in ' +
        'PostgreSQL and has no local-file fallback — a filesystem database does not ' +
        'survive a publish. Provision the database and restart.',
    );
  }
  return raw;
}

/**
 * `host:port/database` and nothing else — never the user, never the password,
 * never the raw URL. This is what the boot line prints, so it is the one place
 * a credential could leak into a log and it is written to make that impossible
 * by construction rather than by care.
 */
export function describeBackend(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port || '5432';
    const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || '(default)';
    return `${u.hostname}:${port}/${database}`;
  } catch {
    // An unparseable URL must not be echoed — it may BE the credential.
    return '(unparseable DATABASE_URL)';
  }
}

// ── Placeholder translation ──────────────────────────────────────────────────

/**
 * Rewrite better-sqlite3's parameters into PostgreSQL's `$1…$n`.
 *
 * Two forms, because this codebase used both:
 *   • positional `?`, bound from the argument list, and
 *   • named `@name`, bound from a single object — which storeDiscoveryDb.ts's
 *     26-column publisher upsert uses, and which is precisely the statement
 *     nobody should be hand-converting into 26 ordered arguments.
 * A statement mixing the two is refused rather than guessed at.
 *
 * A repeated `@name` reuses its first `$n`, exactly as better-sqlite3 bound one
 * value to every occurrence (`VALUES (…, @now, @now)` is one timestamp, not
 * two, and must stay that way).
 *
 * The scanner skips everything a parameter could hide inside — single-quoted
 * literals (with `''` escapes), double-quoted identifiers, `--` line comments,
 * `/* *\/` block comments and `$tag$…$tag$` dollar-quoted bodies — because a
 * naive global replace would corrupt a literal question mark or an email
 * address in a comment the moment somebody wrote one, and would do it silently.
 * `@name` requires a letter or underscore after the `@`, so PostgreSQL's own
 * `@>`, `@@` and `@-@` operators are left alone.
 *
 * Exported for its own unit tests: this function sits under every query in the
 * app, so "it looked right" is not a good enough standard for it.
 */
export function toPositional(sql: string): { text: string; params: number; names: string[] } {
  let out = '';
  let n = 0;
  let i = 0;
  const names: string[] = [];
  const slotForName = new Map<string, number>();

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ — PostgreSQL nests these, so track the depth.
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // 'string literal', where '' is an escaped quote
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // "quoted identifier", where "" is an escaped quote
    if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // $tag$ dollar-quoted body $tag$
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const stop = close === -1 ? sql.length : close + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (c === '?') {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }

    // @name — but only when a name actually follows, so `@>` and `@@` survive.
    if (c === '@') {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        const name = m[1];
        let slot = slotForName.get(name);
        if (slot === undefined) {
          n++;
          slot = n;
          slotForName.set(name, slot);
          names.push(name);
        }
        out += `$${slot}`;
        i += m[0].length;
        continue;
      }
    }

    out += c;
    i++;
  }

  if (names.length > 0 && names.length !== n) {
    throw new Error(
      `SQL statement mixes named (@name) and positional (?) parameters — ${sql.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
    );
  }

  return { text: out, params: n, names };
}

// ── The handle ───────────────────────────────────────────────────────────────

/** What `.run()` reports back. `changes` is better-sqlite3's name, kept. */
export interface RunResult {
  changes: number;
}

export interface Statement {
  get<T = Record<string, unknown>>(...args: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...args: unknown[]): Promise<T[]>;
  run(...args: unknown[]): Promise<RunResult>;
}

export interface SqlHandle {
  /** One statement, `?`-parameterised, executed on this handle. */
  prepare(sql: string): Statement;
  /** DDL and other multi-statement scripts. NO parameters — none are accepted. */
  exec(sql: string): Promise<void>;
}

export interface Db extends SqlHandle {
  /**
   * Run `fn` inside a single BEGIN/COMMIT on ONE pooled client.
   *
   * The handle passed to `fn` is the only way to reach that client, so a
   * statement issued through the module-level pool from inside the callback
   * runs OUTSIDE the transaction. That is a real hazard, so callers keep
   * transaction bodies to statements they issue on the handle themselves.
   */
  transaction<T>(fn: (h: SqlHandle) => Promise<T>): Promise<T>;
}

type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * Turn what the call site passed into the array `pg` wants.
 *
 * A NAMED statement takes exactly one argument, the binding object, and every
 * name the statement uses must be a key on it — a missing key is an error, not
 * a silent NULL, because "the column quietly went null" is the hardest kind of
 * data bug to find later. (better-sqlite3 threw here too.)
 *
 * A POSITIONAL statement takes the spread. An arity mismatch is refused here
 * rather than left to the driver, whose "bind message supplies 1 parameters"
 * names no call site at all.
 */
function bindArgs(args: unknown[], text: string, expected: number, names: string[]): unknown[] {
  if (names.length > 0) {
    if (args.length !== 1 || typeof args[0] !== 'object' || args[0] === null || Array.isArray(args[0])) {
      throw new Error(
        `SQL named-parameter statement expects exactly one binding object — ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
      );
    }
    const obj = args[0] as Record<string, unknown>;
    return names.map((name) => {
      if (!(name in obj)) {
        throw new Error(
          `SQL named parameter @${name} was not supplied — ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
        );
      }
      return obj[name];
    });
  }
  if (args.length !== expected) {
    throw new Error(
      `SQL parameter count mismatch: statement expects ${expected}, got ${args.length} — ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
    );
  }
  return args;
}

function statementOn(q: Queryable, sql: string): Statement {
  const { text, params, names } = toPositional(sql);
  return {
    async get<T>(...args: unknown[]): Promise<T | undefined> {
      const res = await q.query(text, bindArgs(args, text, params, names));
      return res.rows[0] as T | undefined;
    },
    async all<T>(...args: unknown[]): Promise<T[]> {
      const res = await q.query(text, bindArgs(args, text, params, names));
      return res.rows as T[];
    },
    async run(...args: unknown[]): Promise<RunResult> {
      const res = await q.query(text, bindArgs(args, text, params, names));
      return { changes: res.rowCount ?? 0 };
    },
  };
}

function handleOn(q: Queryable): SqlHandle {
  return {
    prepare: (sql: string) => statementOn(q, sql),
    exec: async (sql: string) => {
      await q.query(sql);
    },
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let pool: pg.Pool | null = null;
let db: Db | null = null;

/**
 * Open the pool and prove the backend answers.
 *
 * Returns the human-readable backend description so the caller can log it —
 * this function does not log it itself, because initDb() wants one boot line
 * that also names the migration state.
 */
export async function openDatabase(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (pool) return describeBackend(requireDatabaseUrl(env));
  const url = requireDatabaseUrl(env);

  const created = new pg.Pool({
    connectionString: url,
    // Small on purpose. This app's concurrency is a handful of pipeline workers
    // plus dashboard polling, and a managed instance's connection budget is
    // shared with anything else Michael runs against it.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle client that dies (managed restart, network blip) must not take the
  // process down with an unhandled 'error' event.
  created.on('error', (err) => {
    log.warn(`db: idle pool client error — ${err.message}`);
  });

  try {
    const probe = await created.query('SELECT 1 AS ok');
    if (probe.rows[0]?.ok !== 1) throw new Error('backend did not answer SELECT 1');
  } catch (err) {
    await created.end().catch(() => {});
    // The message may contain the host but never the password: `pg` errors quote
    // the host and database, and the connection string is not interpolated here.
    throw new DatabaseNotConfiguredError(
      `Could not reach the database at ${describeBackend(url)} — ${(err as Error).message}`,
    );
  }

  pool = created;
  db = {
    ...handleOn(created),
    async transaction<T>(fn: (h: SqlHandle) => Promise<T>): Promise<T> {
      const client = await created.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(handleOn(client as unknown as Queryable));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return describeBackend(url);
}

export function sql(): Db {
  if (!db) throw new Error('DB not initialized');
  return db;
}

/** Is the pool open? Lets a test assert a boot refusal without catching on shape. */
export function isDatabaseOpen(): boolean {
  return db !== null;
}

/** Close the pool. Used by tests and by the graceful-shutdown path. */
export async function closeDatabase(): Promise<void> {
  const p = pool;
  pool = null;
  db = null;
  if (p) await p.end();
}

// ── offline tests (pure string work — no database) ───────────────────────────

export async function runSqlTests(): Promise<{ passed: number; failed: number; failures: string[] }> {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  const t = (s: string) => toPositional(s).text;
  const n = (s: string) => toPositional(s).params;

  check(t('SELECT * FROM jobs WHERE id = ?') === 'SELECT * FROM jobs WHERE id = $1', 'placeholder: one ? becomes $1');
  check(
    t('INSERT INTO t (a,b,c) VALUES (?, ?, ?)') === 'INSERT INTO t (a,b,c) VALUES ($1, $2, $3)',
    'placeholder: numbering ascends left to right',
  );
  check(n('SELECT ?, ?, ?') === 3, 'placeholder: the count is reported');
  check(n('SELECT 1') === 0, 'placeholder: a statement with no parameters counts zero');

  // The whole reason the scanner exists.
  check(
    t("SELECT * FROM t WHERE note = 'why?' AND id = ?") === "SELECT * FROM t WHERE note = 'why?' AND id = $1",
    'placeholder: a ? inside a string literal is left alone',
  );
  check(
    t("SELECT 'it''s a ?' , ?") === "SELECT 'it''s a ?' , $1",
    'placeholder: an escaped quote does not end the literal early',
  );
  check(
    t('SELECT "odd?column", ? FROM t') === 'SELECT "odd?column", $1 FROM t',
    'placeholder: a ? inside a quoted identifier is left alone',
  );
  check(
    t('SELECT ? -- what about ?\n, ?') === 'SELECT $1 -- what about ?\n, $2',
    'placeholder: a ? inside a line comment is left alone',
  );
  check(
    t('SELECT ? /* ? and /* nested ? */ still */ , ?') === 'SELECT $1 /* ? and /* nested ? */ still */ , $2',
    'placeholder: a ? inside a nested block comment is left alone',
  );
  check(
    t('SELECT $tag$ ? $tag$, ?') === 'SELECT $tag$ ? $tag$, $1',
    'placeholder: a ? inside a dollar-quoted body is left alone',
  );

  // An unterminated literal must not silently swallow the rest of the statement
  // AND renumber what survives — it should simply consume to the end, so the
  // backend reports the syntax error rather than this file inventing one.
  check(n("SELECT ? , 'unterminated") === 1, 'placeholder: an unterminated literal still counts what preceded it');

  // The parameter-count guard. A statement that binds the wrong number of
  // arguments must fail loudly HERE: PostgreSQL would otherwise report
  // "bind message supplies 1 parameters" from deep inside the driver, with no
  // hint of which call site got it wrong.
  const seen: Array<{ text: string; values: unknown[] }> = [];
  const stub: Queryable = {
    query: async (text: string, values?: unknown[]) => {
      seen.push({ text, values: values ?? [] });
      return { rows: [{ id: 'x' }], rowCount: 1 };
    },
  };
  const two = statementOn(stub, 'SELECT * FROM t WHERE a = ? AND b = ?');
  let mismatch = '';
  try {
    await two.get('only-one');
  } catch (err) {
    mismatch = (err as Error).message;
  }
  check(/expects 2, got 1/.test(mismatch), 'bind: too few arguments is refused before the query is sent');
  check(seen.length === 0, 'bind: a mismatched statement never reaches the backend');

  await two.get('a', 'b');
  check(
    seen.length === 1 && seen[0].text === 'SELECT * FROM t WHERE a = $1 AND b = $2',
    'bind: the translated text is what gets sent',
  );
  check(
    seen[0].values.length === 2 && seen[0].values[0] === 'a' && seen[0].values[1] === 'b',
    'bind: arguments are passed through in order',
  );

  const run = await statementOn(stub, 'DELETE FROM t WHERE a = ?').run('a');
  check(run.changes === 1, 'run: rowCount is reported as changes');

  // ── named parameters ──
  const named = toPositional('INSERT INTO t (a, b, c) VALUES (@a, @b, @now), (@a, @b, @now)');
  check(named.text.endsWith('VALUES ($1, $2, $3), ($1, $2, $3)'), 'named: a repeated @name reuses its slot');
  check(named.names.join(',') === 'a,b,now', 'named: names are reported in first-use order');
  check(named.params === 3, 'named: three distinct names is three parameters');

  seen.length = 0;
  await statementOn(stub, 'UPDATE t SET x = @x, at = @now WHERE id = @id').run({ x: 1, now: 2, id: 'z' });
  check(seen[0]?.text === 'UPDATE t SET x = $1, at = $2 WHERE id = $3', 'named: text is translated by name');
  check(
    JSON.stringify(seen[0]?.values) === JSON.stringify([1, 2, 'z']),
    'named: values are ordered by the slots the names took',
  );

  let missing = '';
  try {
    await statementOn(stub, 'UPDATE t SET x = @x WHERE id = @id').run({ x: 1 });
  } catch (err) {
    missing = (err as Error).message;
  }
  check(/@id was not supplied/.test(missing), 'named: a missing binding is refused, never bound as NULL');

  let notObject = '';
  try {
    await statementOn(stub, 'UPDATE t SET x = @x').run(1);
  } catch (err) {
    notObject = (err as Error).message;
  }
  check(/exactly one binding object/.test(notObject), 'named: a positional argument to a named statement is refused');

  let mixed = '';
  try {
    toPositional('UPDATE t SET x = @x WHERE id = ?');
  } catch (err) {
    mixed = (err as Error).message;
  }
  check(/mixes named .* and positional/.test(mixed), 'named: mixing @name and ? is refused');

  // PostgreSQL's own @-operators are not parameters.
  check(toPositional("SELECT * FROM t WHERE r @> '[1,2]'").params === 0, 'named: the @> operator is not a parameter');
  check(toPositional('SELECT a @@ b FROM t').params === 0, 'named: the @@ operator is not a parameter');
  check(
    toPositional("SELECT 'mail@example.com', @x").names.join(',') === 'x',
    'named: an address inside a string literal is not a parameter',
  );

  // describeBackend must never echo a credential.
  const withCreds = 'postgres://someuser:sup3rsecret@db.internal:5433/leadfinder?sslmode=require';
  const described = describeBackend(withCreds);
  check(described === 'db.internal:5433/leadfinder', 'backend: host:port/database is what gets described');
  check(
    !described.includes('sup3rsecret') && !described.includes('someuser'),
    'backend: neither the password nor the user appears in the description',
  );
  check(
    describeBackend('this is not a url') === '(unparseable DATABASE_URL)',
    'backend: an unparseable URL is never echoed back',
  );

  // The refusal.
  let refused = false;
  try {
    requireDatabaseUrl({} as NodeJS.ProcessEnv);
  } catch (err) {
    refused = err instanceof DatabaseNotConfiguredError;
  }
  check(refused, 'boot: an unset DATABASE_URL is refused, not defaulted');
  let refusedBlank = false;
  try {
    requireDatabaseUrl({ DATABASE_URL: '   ' } as NodeJS.ProcessEnv);
  } catch (err) {
    refusedBlank = err instanceof DatabaseNotConfiguredError;
  }
  check(refusedBlank, 'boot: a whitespace-only DATABASE_URL is refused too');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('sql.js') || process.argv[1].endsWith('sql.ts'));
if (isMain) {
  const { passed, failed, failures } = await runSqlTests();
  console.log(`sql tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
