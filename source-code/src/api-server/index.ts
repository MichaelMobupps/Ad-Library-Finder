import 'dotenv/config';
import express, { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDb } from './db.js';
import { jobsRouter } from './routes-jobs.js';
import { healthRouter, versionRouter } from './routes-health.js';
import { authRouter } from './routes-auth.js';
import { settingsRouter } from './routes-settings.js';
import { prepareStableLibraryClosure } from './browserSetup.js';
import { startQueue } from './queue.js';
import { log } from './logger.js';
import {
  userContextMiddleware,
  requireAuth,
  RequestWithUser,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await initDb();

  // Nix-rot fix: snapshot Chromium shared-library deps before any Playwright launch
  prepareStableLibraryClosure();

  const app = express();

  // Trust the Replit edge proxy so req.secure / req.ip / req.protocol reflect
  // the real client connection. Required for forwarded-header-derived OAuth
  // redirect URIs to be correct.
  app.set('trust proxy', true);

  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    log.info(`${req.method} ${req.path}`);
    next();
  });

  // Attach the current user (if any) to every request based on session cookie.
  // This is purely informational — does NOT enforce.
  app.use(userContextMiddleware);

  // ---- Public routes ----
  app.use('/api/health', healthRouter);
  app.use('/version', versionRouter);
  app.use('/api/auth', authRouter);

  // ---- /api/me — returns current user or 401 (used by SPA to detect login) ----
  app.get('/api/me', (req: Request, res: Response) => {
    const user = (req as RequestWithUser).user;
    if (!user) return res.status(401).json({ error: 'not signed in' });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
    });
  });

  // ---- Protected API routes ----
  app.use('/api/jobs', requireAuth, jobsRouter);
  app.use('/api/settings', requireAuth, settingsRouter);

  // ---- Static SPA (login screen + app — SPA decides which to show via /api/me) ----
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