import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from './logger.js';

/**
 * Browser library setup for Playwright's bundled Chromium (chrome-headless-shell)
 * on this NixOS host.
 *
 * The Problem
 * -----------
 * Playwright ships a Chromium binary built against a standard Linux glibc.
 * On NixOS, the host's /lib/x86_64-linux-gnu/ glibc is incompatible with the
 * nix-store libs that supply Chromium's other dependencies (glib, nss, atk,
 * libxkbcommon, etc.) — those nix libs have RUNPATH entries pointing at a nix
 * glibc-2.33, and once they're loaded, libc/libpthread MUST come from that
 * same glibc-2.33 because glibc internally uses private symbols that are
 * tied to a specific (libc + ld-linux) pair.
 *
 * Symptoms before this fix:
 *   - "libglib-2.0.so.0: cannot open shared object file" (Chromium can't even
 *     find its deps; needs LD_LIBRARY_PATH or RPATH to point at nix lib dirs)
 *   - "libpthread.so.0: version `GLIBC_PRIVATE' not found" (deps loaded from
 *     nix glibc 2.33 but libpthread from host glibc; mismatch)
 *   - "libc.so.6: undefined symbol: _dl_catch_error_ptr, version GLIBC_PRIVATE"
 *     (nix glibc libc.so used with host ld-linux; ld interpreter mismatch)
 *
 * The Fix
 * -------
 * Use `patchelf` to rewrite the Chromium binary so:
 *   - Its ELF interpreter is the nix ld-linux (matches nix libc family)
 *   - Its RPATH lists the nix-glibc lib dir first, then every nix lib dir
 *     that provides a Chromium dependency, then Chromium's own dir (for
 *     bundled libEGL/libvulkan).
 *
 * After patching, Chromium loads as a fully nix-coherent process. The patch
 * is idempotent: we check the current interpreter and skip if already nix.
 *
 * We also do NOT mutate the parent Node process's LD_LIBRARY_PATH — Node 20
 * was built against glibc 2.38 and crashes if its dynamic loader resolves
 * libc/libm from nix glibc 2.33. Instead, the Chromium-specific env is
 * built and passed via chromium.launch({ env }) (see scraper.ts).
 *
 * Path Resolution (added 2025-05-20)
 * ----------------------------------
 * In production deploys, Playwright's auto-discovery sometimes ignored
 * PLAYWRIGHT_BROWSERS_PATH=0 from .replit [env] and looked at the default
 * ~/.cache/ms-playwright/chromium_headless_shell-1223/ path — which is
 * empty because pnpm-installed playwright-core stores browsers in
 * node_modules/.../.local-browsers/. We solved this by exporting the
 * resolved binary path and having scraper.ts pass it as executablePath
 * to chromium.launch(), bypassing Playwright's env-driven lookup entirely.
 */

interface CachedEnv {
  ldLibraryPath: string;
  chromiumPath: string | null;
  patched: boolean;
}

let cached: CachedEnv | null = null;

export function prepareStableLibraryClosure(): void {
  if (process.platform !== 'linux') {
    log.info('browser libs: non-linux platform, skipping');
    cached = { ldLibraryPath: process.env.LD_LIBRARY_PATH || '', chromiumPath: null, patched: false };
    return;
  }

  const replitLLP = process.env.REPLIT_LD_LIBRARY_PATH || '';
  const currentLLP = process.env.LD_LIBRARY_PATH || '';
  if (!replitLLP) {
    log.warn('browser libs: REPLIT_LD_LIBRARY_PATH is empty — replit.nix may be missing browser deps');
  }

  const chromiumPath = findChromiumBinary();
  if (!chromiumPath) {
    log.warn('browser libs: chromium binary not found — Playwright will surface its own error');
    cached = { ldLibraryPath: currentLLP, chromiumPath: null, patched: false };
    return;
  }
  log.info(`browser libs: chromium = ${chromiumPath}`);

  // Discover the nix glibc lib dir via ldd. We need this to (a) set it as
  // Chromium's new ELF interpreter source and (b) put it at the head of the
  // Chromium spawn LD_LIBRARY_PATH.
  let candidateLLP = replitLLP && currentLLP
    ? `${replitLLP}:${currentLLP}`
    : (replitLLP || currentLLP);

  const lddOutput = safeLdd(chromiumPath, candidateLLP);
  const glibcDirs = new Set<string>();
  if (lddOutput) {
    const re = /(\/nix\/store\/[^\/]+-glibc-[^\/]+\/lib)\//g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lddOutput))) glibcDirs.add(m[1]);
  }
  const nixGlibcLibDirs = Array.from(glibcDirs);
  if (nixGlibcLibDirs.length) {
    log.info(`browser libs: nix glibc lib dir(s): ${nixGlibcLibDirs.join(', ')}`);
    candidateLLP = `${nixGlibcLibDirs.join(':')}:${candidateLLP}`;
  } else {
    log.warn('browser libs: no nix glibc lib dir detected in ldd output (chromium may launch only on traditional Linux)');
  }

  // Patchelf the binary so it uses nix glibc's ld-linux as interpreter and
  // has a baked-in RPATH covering all browser deps. Idempotent: if already
  // patched (interpreter is in /nix/store), skip.
  let patched = false;
  if (nixGlibcLibDirs.length) {
    try {
      patched = patchelfChromiumIfNeeded(chromiumPath, nixGlibcLibDirs[0], candidateLLP);
    } catch (err) {
      log.warn(`browser libs: patchelf step failed: ${(err as Error).message}`);
    }
  }

  // Verify final state
  const lddOutput2 = safeLdd(chromiumPath, candidateLLP);
  if (lddOutput2) {
    const stillMissing = lddOutput2
      .split('\n')
      .filter((l) => l.includes('not found'))
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (stillMissing.length === 0) {
      log.info('browser libs: ldd reports all chromium dependencies resolved');
    } else {
      log.warn(`browser libs: ${stillMissing.length} lib(s) STILL not found: ${stillMissing.join(', ')}`);
    }
  }

  cached = { ldLibraryPath: candidateLLP, chromiumPath, patched };
  log.info(`browser libs: chromium spawn env ready (${candidateLLP.split(':').filter(Boolean).length} LD dirs, patched=${patched})`);
}

function safeLdd(binary: string, llp: string): string {
  try {
    return execSync(`ldd "${binary}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: llp },
    });
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    return typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
  }
}

/**
 * Patchelf the chromium binary so its ELF interpreter points to nix ld-linux
 * and its RPATH covers every browser-dep lib dir. Returns true if patching
 * was done this call, false if already patched or unable to patch.
 */
function patchelfChromiumIfNeeded(
  chromium: string,
  nixGlibcLib: string,
  ldLibraryPath: string
): boolean {
  // Check current interpreter — if already nix, skip.
  let currentInterp = '';
  try {
    currentInterp = execFileSync('patchelf', ['--print-interpreter', chromium], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    log.warn(`browser libs: patchelf not available or unreadable binary: ${(err as Error).message}`);
    return false;
  }

  const nixLoader = path.join(nixGlibcLib, 'ld-linux-x86-64.so.2');
  if (!existsSync(nixLoader)) {
    log.warn(`browser libs: nix ld-linux not found at ${nixLoader}; skipping patchelf`);
    return false;
  }

  if (currentInterp === nixLoader) {
    log.info('browser libs: chromium already patched (interpreter is nix ld-linux)');
    return false;
  }

  // Backup original once
  const backup = `${chromium}.unpatched`;
  if (!existsSync(backup)) {
    try {
      copyFileSync(chromium, backup);
      log.info(`browser libs: backed up unpatched chromium to ${backup}`);
    } catch (err) {
      log.warn(`browser libs: could not backup chromium: ${(err as Error).message}`);
    }
  }

  // RPATH = all browser dep dirs (incl. nix glibc) + chromium's own dir
  // (for bundled libEGL.so / libvulkan.so.1 / libvk_swiftshader.so).
  const chromeDir = path.dirname(chromium);
  const rpath = `${ldLibraryPath}:${chromeDir}`;

  try {
    execFileSync('patchelf', ['--set-interpreter', nixLoader, chromium], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('patchelf', ['--set-rpath', rpath, chromium], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log.warn(`browser libs: patchelf invocation failed: ${(err as Error).message}`);
    return false;
  }

  log.info('browser libs: chromium binary patched (interpreter + rpath)');
  return true;
}

/**
 * Return env for chromium.launch({ env }). Includes the chromium-specific
 * LD_LIBRARY_PATH with nix glibc + nix browser deps at the head.
 *
 * The patched binary's RPATH ALREADY contains these paths, but we also pass
 * LD_LIBRARY_PATH belt-and-suspenders for any libs Chromium dlopen()s at
 * runtime that don't follow the binary's RPATH chain.
 */
export function browserSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (cached) {
    env.LD_LIBRARY_PATH = cached.ldLibraryPath;
  }
  return env;
}

/**
 * The absolute path to the chrome-headless-shell binary we resolved at
 * startup. Pass this to chromium.launch({ executablePath }) so Playwright
 * doesn't fall back to its env-driven auto-discovery (which has been seen
 * to ignore PLAYWRIGHT_BROWSERS_PATH=0 in deploy contexts).
 *
 * Returns undefined if startup failed to find the binary; callers can let
 * Playwright surface its own error in that case.
 */
export function browserExecutablePath(): string | undefined {
  return cached?.chromiumPath ?? undefined;
}

function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (existsSync(path.join(dir, 'node_modules/.pnpm'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function findChromiumBinary(): string | null {
  const root = findWorkspaceRoot();
  log.info(`browser libs: workspace root = ${root}`);

  // Search order — prefer node_modules location (PLAYWRIGHT_BROWSERS_PATH=0
  // layout) because that's where `pnpm install:playwright` puts it during
  // our deploy build. Fall back to .cache layouts.
  const pnpmDir = path.join(root, 'node_modules/.pnpm');
  if (existsSync(pnpmDir)) {
    let pwDirs: string[] = [];
    try {
      pwDirs = readdirSync(pnpmDir).filter((n) => n.startsWith('playwright-core@'));
    } catch {
      /* ignore */
    }
    for (const d of pwDirs) {
      const browsersDir = path.join(pnpmDir, d, 'node_modules/playwright-core/.local-browsers');
      const found = locateInBrowsersDir(browsersDir);
      if (found) return found;
    }
  }

  const directNodeModules = locateInBrowsersDir(
    path.join(root, 'node_modules/playwright-core/.local-browsers')
  );
  if (directNodeModules) return directNodeModules;

  const cacheCandidates: string[] = [
    path.join(os.homedir(), '.cache/ms-playwright'),
    path.join(root, '.cache/ms-playwright'),
  ];
  for (const browsersDir of cacheCandidates) {
    const found = locateInBrowsersDir(browsersDir);
    if (found) return found;
  }

  return null;
}

function locateInBrowsersDir(browsersDir: string): string | null {
  if (!existsSync(browsersDir)) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(browsersDir);
  } catch {
    return null;
  }
  const chromiumDirs = entries.filter((n) => n.startsWith('chromium_headless_shell-'));
  for (const c of chromiumDirs) {
    for (const arch of ['chrome-headless-shell-linux64', 'chrome-headless-shell-linux-arm64']) {
      const candidate = path.join(browsersDir, c, arch, 'chrome-headless-shell');
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}