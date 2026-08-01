import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDb } from './db.js';
import { jobsRouter } from './routes-jobs.js';
import { healthRouter, versionRouter } from './routes-health.js';
import { authRouter } from './routes-auth.js';
import { settingsRouter } from './routes-settings.js';
import { prepareStableLibraryClosure } from './browserSetup.js';
import { startQueue } from './queue.js';
import {
  basePath,
  BASE_PATH,
  PUBLIC_URL,
  IS_PREFIXED,
  PUBLIC_URL_ENV_MISNAMED,
  PUBLIC_URL_MISSING_WHILE_PREFIXED,
  bareBasePathRedirect,
  spaFallbackServesIndex,
} from './urls.js';
import { log } from './logger.js';
import {
  userContextMiddleware,
  requireAuth,
  isAdminUser,
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

  // ---- Bare prefix -> trailing slash ----
  // Registered ONLY when a prefix is active, and as plain middleware doing an
  // exact compare rather than a route at BASE_PATH: Express routing is
  // non-strict, so a route at "/leadfinder" also matches "/leadfinder/" and the
  // handler redirects the trailing-slash form to itself, taking the main page
  // down. Three sibling apps hit exactly that. Must precede express.static,
  // which would otherwise answer the bare prefix with index.html directly and
  // leave the SPA on a broken relative asset base.
  if (IS_PREFIXED) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      // req.path excludes the query; carry it across so the redirect loses
      // nothing. The path half is a fixed literal built from the validated
      // prefix, so no query can move the target off this origin.
      const qIdx = req.originalUrl.indexOf('?');
      const search = qIdx === -1 ? '' : req.originalUrl.slice(qIdx);
      const to = bareBasePathRedirect(BASE_PATH, req.path, search);
      if (to === null) return next();
      res.redirect(to);
    });
  }

  // ---- Public routes ----
  // Mount paths resolve through urls.ts: with BASE_PATH unset basePath() is the
  // identity, so these are the same strings the app has always mounted.
  app.use(basePath('/api/health'), healthRouter);
  app.use(basePath('/version'), versionRouter);
  app.use(basePath('/api/auth'), authRouter);

  // ---- /api/me — returns current user or 401 (used by SPA to detect login) ----
  app.get(basePath('/api/me'), (req: Request, res: Response) => {
    const user = (req as RequestWithUser).user;
    if (!user) return res.status(401).json({ error: 'not signed in' });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: isAdminUser(user),
    });
  });

  // ---- Protected API routes ----
  app.use(basePath('/api/jobs'), requireAuth, jobsRouter);
  app.use(basePath('/api/settings'), requireAuth, settingsRouter);

  // ---- Static SPA (login screen + app — SPA decides which to show via /api/me) ----
  const dashboardDist = path.resolve(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    // BASE_PATH is '/' by default, and app.use('/', h) === app.use(h).
    app.use(BASE_PATH, express.static(dashboardDist));

    // The prefix is a BUILD-time constant on the client side and a run-time one
    // here. A server started under a prefix over a dist built without it serves
    // an index.html whose every asset 404s — a blank page for everyone, with
    // nothing in the logs. Say it out loud instead. Prefixed deploys only, so
    // the unprefixed path does not so much as read the file.
    if (IS_PREFIXED) {
      try {
        const html = readFileSync(path.join(dashboardDist, 'index.html'), 'utf8');
        const stray = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)]
          .map((m) => m[1])
          .filter((ref) => !ref.startsWith(`${BASE_PATH}/`));
        if (stray.length > 0) {
          log.warn(
            `Dashboard build does NOT match BASE_PATH=${BASE_PATH} — ${stray.join(', ')} ` +
              'will 404 and the page will be blank. Rebuild with BASE_PATH set.',
          );
        }
      } catch (err) {
        log.warn(`Could not verify the dashboard build's base path: ${(err as Error).message}`);
      }
    }

    // SPA fallback. The two arms are deliberately NOT one expression: unprefixed
    // this app answers index.html on every path, including paths that look like
    // missing assets, and the darkness rule makes that exact behaviour the
    // contract. The prefixed arm is the one that gets the honest 404 — it can
    // afford it, because nothing outside the mount belongs to us any more.
    if (IS_PREFIXED) {
      // app.use(prefix, …) rather than app.get(prefix + '/*'): mount-prefix
      // matching is stable across Express majors, where wildcard route strings
      // are not (Express 5 rejects "/leadfinder/*" at registration).
      // Express strips the mount, so req.path arrives as "/api/jobs/x".
      app.use(BASE_PATH, (req: Request, res: Response, next: NextFunction) => {
        if (!spaFallbackServesIndex(req.method, req.path)) return next();
        res.sendFile(path.join(dashboardDist, 'index.html'));
      });
    } else {
      app.get('*', (_req, res) => {
        res.sendFile(path.join(dashboardDist, 'index.html'));
      });
    }
  } else {
    log.warn(`Dashboard build not found at ${dashboardDist}. Run 'pnpm --filter dashboard build'.`);
  }

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

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});