/**
 * Ephemeral PostgreSQL cluster for the test gate.
 *
 * Every suite that needs a real database gets its OWN cluster, created in a
 * temp directory, listening on a unix socket, torn down when the suite ends.
 * Nothing here can reach the dev database and nothing can reach the live one:
 * the cluster is built by `initdb` seconds earlier and its socket directory is
 * the only way in.
 *
 * A unix socket rather than a TCP port on purpose — no port to collide with
 * another suite, another agent, or the operator's own psql, and no chance of a
 * stray connection from off the machine.
 *
 * Usage:
 *   const cluster = await startCluster('chief-surface');
 *   process.env.DATABASE_URL = cluster.url;   // or pass it to a child process
 *   ...
 *   await cluster.stop();
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The environment the postgres binaries must be spawned with.
 *
 * LD_LIBRARY_PATH IS STRIPPED, and that is the whole point of this function.
 * Replit injects REPLIT_LD_LIBRARY_PATH — glib 2.68, nss 3.68, systemd 247 and
 * friends, all built against glibc 2.33 — into the LD_LIBRARY_PATH that Node
 * inherits and passes to its children. The PostgreSQL 16.10 binaries on PATH
 * are built against glibc 2.40, so the loader finds glibc 2.33's librt.so.1
 * first and every one of them dies with:
 *
 *   libpthread.so.0: version `GLIBC_PRIVATE' not found (required by librt.so.1)
 *
 * They resolve their own dependencies through their RPATH, so removing the
 * variable entirely is both sufficient and correct. This is the same class of
 * trap replit.nix documents at length for the Chromium/glibc collision, and
 * browserSetup.ts already plumbs LD_LIBRARY_PATH explicitly for the same
 * reason. NOTE: it reproduces only under a spawned Node process — a plain login
 * shell has a shorter LD_LIBRARY_PATH and `postgres -V` works there, so this
 * cannot be diagnosed from the terminal.
 */
export function pgEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.LD_LIBRARY_PATH;
  return env;
}

/** Poll `pg_isready` against this socket dir, or throw with the startup log. */
async function waitReady(sockDir, dbDir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (spawnSync('pg_isready', ['-h', sockDir, '-q'], { encoding: 'utf8', env: pgEnv() }).status === 0) return;
    if (Date.now() > deadline) {
      let tail = '(no startup log)';
      try {
        tail = readFileSync(path.join(dbDir, 'startup.log'), 'utf8').split('\n').slice(-25).join('\n');
      } catch {
        /* keep the placeholder */
      }
      throw new Error(`ephemeral postgres did not become ready in ${timeoutMs}ms\n${tail}`);
    }
    await sleep(100);
  }
}

/**
 * Create, start and return a throwaway cluster.
 *
 * `label` only shapes the temp directory name, so a leftover directory names
 * the suite that leaked it.
 */
export async function startCluster(label = 'lf') {
  for (const bin of ['initdb', 'pg_ctl', 'pg_isready', 'psql']) {
    if (spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', env: pgEnv() }).status !== 0) {
      throw new Error(`ephemeral postgres needs ${bin} on PATH — not found`);
    }
  }

  const root = mkdtempSync(path.join(tmpdir(), `pgtest-${label}-`));
  const dbDir = path.join(root, 'data');
  const sockDir = path.join(root, 'sock');
  mkdirSync(sockDir, { recursive: true });

  let stopped = false;
  const teardown = () => {
    if (stopped) return;
    stopped = true;
    spawnSync('pg_ctl', ['-D', dbDir, '-m', 'immediate', '-w', '-t', '20', 'stop'], { encoding: 'utf8', env: pgEnv() });
    rmSync(root, { recursive: true, force: true });
  };

  // --auth=trust is safe precisely because the cluster listens on NO tcp port
  // (-h '' below): the socket lives inside a 0700 temp dir owned by this user.
  // fsync/full_page_writes off because the entire cluster is deleted in a
  // moment — durability of a throwaway is worth nothing and costs seconds.
  const init = spawnSync(
    'initdb',
    ['-D', dbDir, '--auth=trust', '--username=postgres', '--encoding=UTF8', '--locale=C', '--no-sync'],
    { encoding: 'utf8', env: pgEnv() },
  );
  if (init.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`initdb failed: ${init.stderr || init.stdout}`);
  }

  const start = spawnSync(
    'pg_ctl',
    [
      '-D', dbDir,
      '-l', path.join(dbDir, 'startup.log'),
      '-o', `-k ${sockDir} -h '' -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      '-w', '-t', '30',
      'start',
    ],
    { encoding: 'utf8', env: pgEnv() },
  );
  if (start.status !== 0) {
    const log = (() => {
      try {
        return readFileSync(path.join(dbDir, 'startup.log'), 'utf8');
      } catch {
        return '';
      }
    })();
    rmSync(root, { recursive: true, force: true });
    throw new Error(`pg_ctl start failed: ${start.stderr || start.stdout}\n${log}`);
  }

  // A postmaster that started but never became ready must still be reaped.
  process.once('exit', teardown);
  try {
    await waitReady(sockDir, dbDir);
    const create = spawnSync(
      'psql',
      ['-h', sockDir, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE leadfinder'],
      { encoding: 'utf8', env: pgEnv() },
    );
    if (create.status !== 0) {
      throw new Error(`could not create the test database: ${create.stderr || create.stdout}`);
    }
  } catch (err) {
    teardown();
    throw err;
  }

  // A socket-directory URL: `host` is the socket PATH, so `pg` connects over
  // the unix socket and never opens a TCP connection.
  const urlFor = (dbName) =>
    `postgresql://postgres@localhost/${dbName}?host=${encodeURIComponent(sockDir)}`;

  /**
   * A second (third, fourth…) database inside the SAME cluster.
   *
   * Suites that boot the server several times over — the chief surface runs
   * four env modes, the legacy-address gate two — give each boot its own
   * database rather than its own cluster: same isolation, one `initdb` instead
   * of four, and the whole lot still disappears with the temp directory.
   */
  const createDatabase = (name) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`ephemeral database name must be a simple identifier, got ${JSON.stringify(name)}`);
    }
    const r = spawnSync(
      'psql',
      ['-h', sockDir, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`],
      { encoding: 'utf8', env: pgEnv() },
    );
    if (r.status !== 0) throw new Error(`could not create database ${name}: ${r.stderr || r.stdout}`);
    return urlFor(name);
  };

  return {
    url: urlFor('leadfinder'),
    urlFor,
    createDatabase,
    sockDir,
    dataDir: dbDir,
    root,
    stop: async () => teardown(),
  };
}

/**
 * Refuse to run against anything but a throwaway cluster.
 *
 * This exists because of what happened the first time the gate was run after
 * the storage move: the check scripts inherited the workspace's own
 * `DATABASE_URL`, connected to the DEV database, and wrote their fixture jobs
 * and users straight into it. Nothing was lost — but nothing stopped it either,
 * and the same inheritance pointed at a production URL would be far worse.
 *
 * An ephemeral cluster is recognisable with certainty: it is reached over a
 * unix socket in a `pgtest-*` directory that startCluster() made under the
 * system temp dir moments ago. Anything else — any TCP host, any socket path
 * this module did not create — is refused.
 */
export function assertEphemeral(url) {
  const fail = (why) => {
    throw new Error(
      `refusing to run tests against ${why}. Tests only ever run against an ephemeral cluster ` +
        'created by scripts/pgtest.mjs — see startCluster().',
    );
  };
  if (!url) fail('an unset DATABASE_URL');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('an unparseable DATABASE_URL');
  }
  const host = parsed.searchParams.get('host');
  if (!host) fail('a TCP database (no unix socket host parameter)');
  const real = path.resolve(host);
  const tmpReal = path.resolve(tmpdir());
  if (!real.startsWith(tmpReal + path.sep)) fail(`a socket outside ${tmpReal}`);
  if (!/(^|\/)pgtest-[^/]*\//.test(real + '/')) fail('a socket that pgtest.mjs did not create');
  return url;
}

/** Run `fn` against a fresh cluster and always tear it down. */
export async function withCluster(label, fn) {
  const cluster = await startCluster(label);
  try {
    return await fn(cluster);
  } finally {
    await cluster.stop();
  }
}
