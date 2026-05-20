import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDb } from './db.js';
import { jobsRouter } from './routes-jobs.js';
import { healthRouter } from './routes-health.js';
import { authRouter } from './routes-auth.js';
import { settingsRouter } from './routes-settings.js';
import { prepareStableLibraryClosure } from './browserSetup.js';
import { startQueue } from './queue.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await initDb();

  // Nix-rot fix: snapshot Chromium shared-library deps before any Playwright launch
  prepareStableLibraryClosure();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    log.info(`${req.method} ${req.path}`);
    next();
  });

  app.use('/api/health', healthRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);

  const dashboardDist = path.resolve(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    app.use(express.static(dashboardDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(dashboardDist, 'index.html'));
    });
  } else {
    log.warn(`Dashboard build not found at ${dashboardDist}. Run 'pnpm --filter dashboard build'.`);
  }

  startQueue();

  const port = Number(process.env.PORT) || 3001;
  app.listen(port, '0.0.0.0', () => {
    log.info(`api-server listening on :${port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
