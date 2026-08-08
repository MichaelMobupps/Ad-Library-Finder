import 'dotenv/config';
import { initDb } from './db.js';
import { buildApp } from './app.js';
import { prepareStableLibraryClosure } from './browserSetup.js';
import { startQueue } from './queue.js';
import {
  BASE_PATH,
  PUBLIC_URL,
  PUBLIC_URL_ENV_MISNAMED,
  PUBLIC_URL_MISSING_WHILE_PREFIXED,
} from './urls.js';
import { log } from './logger.js';

async function main() {
  await initDb();

  // Nix-rot fix: snapshot Chromium shared-library deps before any Playwright launch
  prepareStableLibraryClosure();

  // Route table, middleware and static serving all live in app.ts, so a test can
  // boot the real assembly without starting the queue or binding a port.
  const app = buildApp();

  startQueue();

  const port = Number(process.env.PORT) || 3001;
  app.listen(port, '0.0.0.0', () => {
    log.info(`api-server listening on :${port}`);
    // Resolved URL config, so a cutover can be confirmed from the logs alone.
    log.info(`url config: BASE_PATH=${BASE_PATH} PUBLIC_URL=${PUBLIC_URL || '(unset)'}`);
    if (PUBLIC_URL_ENV_MISNAMED) {
      // Silent otherwise: every emailed link would go out as a bare rooted path.
      log.warn(
        'PUBLIC_URL is set but PUBLIC_BASE_URL is not — this app reads PUBLIC_BASE_URL. ' +
          'Emailed links are being built WITHOUT an absolute address.',
      );
    }
    if (PUBLIC_URL_MISSING_WHILE_PREFIXED) {
      log.warn(
        `BASE_PATH=${BASE_PATH} is set but PUBLIC_BASE_URL is empty — emailed result links ` +
          'will be bare rooted paths, not clickable from an inbox.',
      );
    }
  });
}

void main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
