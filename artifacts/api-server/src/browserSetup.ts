import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, readdirSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const LIB_STABLE_DIR = path.resolve('.lib-stable');

export function prepareStableLibraryClosure(): void {
  if (process.platform !== 'linux') {
    log.info('non-linux platform, skipping stable library closure');
    return;
  }
  if (!existsSync('/nix/store')) {
    log.info('no /nix/store on host, skipping stable library closure');
    return;
  }

  const chromium = findChromiumBinary();
  if (!chromium) {
    log.warn('chromium binary not found under node_modules — skipping closure (Playwright will fail at launch)');
    return;
  }
  log.info(`stable closure: chromium = ${chromium}`);

  mkdirSync(LIB_STABLE_DIR, { recursive: true });

  let lddOutput: string;
  try {
    lddOutput = execSync(`ldd "${chromium}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    lddOutput = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
    if (!lddOutput) {
      log.warn('ldd produced no output; aborting closure prep');
      return;
    }
  }

  const re = /=>\s+(\/nix\/store\/[^\s]+\.so(?:\.[\d.]+)*)/g;
  const sourcePaths = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(lddOutput))) sourcePaths.add(m[1]);

  let copied = 0;
  let skipped = 0;
  let missing = 0;
  for (const src of sourcePaths) {
    try {
      accessSync(src, constants.R_OK);
    } catch {
      missing++;
      continue;
    }
    const dest = path.join(LIB_STABLE_DIR, path.basename(src));
    if (existsSync(dest)) {
      skipped++;
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied++;
    } catch (err) {
      log.warn(`failed to copy ${src}: ${(err as Error).message}`);
    }
  }
  log.info(`stable closure: ${sourcePaths.size} libs total, ${copied} copied, ${skipped} cached, ${missing} missing`);

  const prev = process.env.LD_LIBRARY_PATH || '';
  process.env.LD_LIBRARY_PATH = prev ? `${LIB_STABLE_DIR}:${prev}` : LIB_STABLE_DIR;
  log.info(`LD_LIBRARY_PATH set (head: ${LIB_STABLE_DIR})`);
}

function findChromiumBinary(): string | null {
  const pnpmDir = 'node_modules/.pnpm';
  if (existsSync(pnpmDir)) {
    const pwDirs = readdirSync(pnpmDir).filter((n) => n.startsWith('playwright-core@'));
    for (const d of pwDirs) {
      const browsersDir = path.join(pnpmDir, d, 'node_modules/playwright-core/.local-browsers');
      const found = locateInBrowsersDir(browsersDir);
      if (found) return found;
    }
  }
  return locateInBrowsersDir('node_modules/playwright-core/.local-browsers');
}

function locateInBrowsersDir(browsersDir: string): string | null {
  if (!existsSync(browsersDir)) return null;
  const chromiumDirs = readdirSync(browsersDir).filter((n) => n.startsWith('chromium_headless_shell-'));
  for (const c of chromiumDirs) {
    for (const arch of ['chrome-headless-shell-linux64', 'chrome-headless-shell-linux-arm64']) {
      const candidate = path.join(browsersDir, c, arch, 'chrome-headless-shell');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
