/**
 * The Express assembly, and nothing else.
 *
 * Split out of index.ts so the app can be BUILT without being STARTED. index.ts
 * still owns the process: database init, the Chromium library snapshot, the job
 * queue, the listener. Importing this module has no side effects beyond
 * importing the routers, which is what lets a gate boot the real app instead of
 * a hand-maintained copy of it — the copy is the thing that drifts, and a
 * status code pinned against a copy proves nothing about what ships.
 *
 * Everything below the "legacy address survival" block is Bundle 1/Bundle 2
 * code moved verbatim; the DARK byte-identity gate is what proves the move
 * changed nothing.
 */
import express, { Request, Response, NextFunction } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { jobsRouter } from './routes-jobs.js';
import { healthRouter, versionRouter } from './routes-health.js';
import { authRouter } from './routes-auth.js';
import { settingsRouter } from './routes-settings.js';
import {
  basePath,
  BASE_PATH,
  IS_PREFIXED,
  bareBasePathRedirect,
  legacyRedirect,
  LEGACY_REDIRECT_STATUS,
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

/** The raw query string of a request, leading "?" included, or ''. */
function rawSearch(req: Request): string {
  const qIdx = req.originalUrl.indexOf('?');
  return qIdx === -1 ? '' : req.originalUrl.slice(qIdx);
}

export function buildApp(): express.Express {
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

  // ---- Legacy address survival ----------------------------------------------
  // Registered ONLY while a prefix is active, and BEFORE userContextMiddleware
  // and every requireAuth mount, for a reason that is easy to get wrong: once
  // Bundle 2 scopes the session cookie to Path=/leadfinder/, a browser does NOT
  // send it to an unprefixed path (RFC 6265 §5.1.4 path-match excludes it). A
  // legacy link is therefore ALWAYS anonymous as far as this app can see, and a
  // legacy layer sitting behind authentication would answer a months-old
  // emailed link with 401 instead of moving it. The redirect needs no identity:
  // it names a location, and the browser re-issues the request under the prefix
  // WITH the cookie attached, where the real auth check runs as it always has.
  //
  // Placed after the request logger on purpose, so both halves of a legacy
  // click — the original method+path and the redirected one — appear in the
  // server's own access log rather than being asserted.
  if (IS_PREFIXED) {
    // Machine callers get a REAL mount, not a redirect: plenty of pollers and
    // probes treat a 3xx as a failure, or simply do not follow one. Both are
    // public, side-effect-free GETs, so serving them at two addresses costs
    // nothing. /version is polled by the out-of-repo deploy detector (O-11).
    app.use('/api/health', healthRouter);
    app.use('/version', versionRouter);

    // Browser-facing legacy addresses: the old root (which is also where the
    // emailed "/#/jobs/<id>" link lands, since a fragment is never sent to the
    // server and the browser re-attaches it across the redirect) and the two
    // emailed download links.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const to = legacyRedirect(BASE_PATH, req.path, rawSearch(req));
      if (to === null) return next();
      // 307: temporary (so a rollback is not fought by a cached redirect) and
      // method-preserving (so a POST is not silently downgraded to a GET).
      res.redirect(LEGACY_REDIRECT_STATUS, to);
    });
  }

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
      const to = bareBasePathRedirect(BASE_PATH, req.path, rawSearch(req));
      if (to === null) return next();
      // Same status as every other redirect this app emits while prefixed —
      // see LEGACY_REDIRECT_STATUS for why it is 307 and not 302 or 308.
      res.redirect(LEGACY_REDIRECT_STATUS, to);
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
        // The raw target is passed as well because Express's mount strip eats an
        // empty segment: "/leadfinder//api/jobs/x/csv" arrives with req.path
        // "/api/jobs/x/csv", which is exactly how a broken download link used to
        // be answered with 200 index.html instead of the file or a 401.
        const rawPath = req.originalUrl.split('?')[0].split('#')[0];
        if (!spaFallbackServesIndex(req.method, req.path, rawPath)) return next();
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

  return app;
}
