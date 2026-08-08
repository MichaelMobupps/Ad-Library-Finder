import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import {
  getAuthUrl,
  exchangeCodeForTokensAndProfile,
  getRedirectUriFromReq,
  persistGmailTokensForUser,
} from './oauth.js';
import { upsertUserByEmail } from './db.js';
import {
  isAllowedEmail,
  loginUser,
  logoutSession,
  accessRestrictedHtml,
  buildClearCookie,
  RequestWithUser,
  ALLOWED_DOMAIN,
} from './auth.js';
import { basePath } from './urls.js';
import { log } from './logger.js';

export const authRouter: Router = Router();

// Simple in-memory state store. State is short-lived (1 hour).
const stateStore = new Map<string, number>();
const STATE_TTL_MS = 60 * 60 * 1000;

function reapStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of stateStore.entries()) {
    if (v < cutoff) stateStore.delete(k);
  }
}

// GET /api/auth/google — initiate OAuth flow (login + Gmail send authorization)
authRouter.get('/google', (req: Request, res: Response) => {
  try {
    reapStates();
    const state = nanoid(24);
    stateStore.set(state, Date.now());
    const url = getAuthUrl(state, req);
    res.redirect(url);
  } catch (err) {
    log.error('auth init failed', err);
    res.status(500).send(`Failed to start OAuth: ${(err as Error).message}`);
  }
});

// GET /api/auth/google/debug — diagnostic, shows the exact redirect URI we'd send to Google
authRouter.get('/google/debug', (req: Request, res: Response) => {
  try {
    const redirectUri = getRedirectUriFromReq(req);
    res.json({
      redirectUri,
      clientIdPresent: !!process.env.GOOGLE_CLIENT_ID,
      clientSecretPresent: !!process.env.GOOGLE_CLIENT_SECRET,
      publicBaseUrlEnv: process.env.PUBLIC_BASE_URL || null,
      forwardedProto: req.headers['x-forwarded-proto'] || null,
      forwardedHost: req.headers['x-forwarded-host'] || null,
      hostHeader: req.get('host') || null,
      allowedDomain: ALLOWED_DOMAIN,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/auth/google/callback — Google redirects here after user consents
authRouter.get('/google/callback', async (req: Request, res: Response) => {
  const { code, state, error: oauthError } = req.query as Record<string, string | undefined>;

  if (oauthError) {
    return res.status(400).send(`OAuth error: ${oauthError}`);
  }
  if (!code) {
    return res.status(400).send('Missing code in callback');
  }
  if (!state || !stateStore.has(state)) {
    return res.status(400).send('Invalid or expired state');
  }
  stateStore.delete(state);

  try {
    const { email, name, tokens } = await exchangeCodeForTokensAndProfile(code, req);

    // Strict domain gate. Do NOT create a user, do NOT create a session,
    // do NOT persist any tokens for non-mobupps accounts.
    if (!isAllowedEmail(email)) {
      log.warn(`Sign-in REFUSED: ${email} (not @${ALLOWED_DOMAIN})`);
      res.status(403).type('html').send(accessRestrictedHtml(email));
      return;
    }

    // Allowed. Upsert user, persist tokens, issue session.
    const user = await upsertUserByEmail(email, name);
    await persistGmailTokensForUser(user.id, email, tokens);
    const { cookie } = await loginUser(user.id);

    log.info(`Sign-in OK: ${email} (user=${user.id})`);
    res.setHeader('Set-Cookie', cookie);
    // Server-side redirect to the app root. basePath() keeps it a same-origin
    // rooted path — it is never operator-controlled and never carries a token.
    res.redirect(basePath('/'));
  } catch (err) {
    log.error('OAuth callback failed', err);
    res.status(500).send(`OAuth exchange failed: ${(err as Error).message}`);
  }
});

// POST /api/auth/logout — clear the session
authRouter.post('/logout', async (req: Request, res: Response) => {
  const r = req as RequestWithUser;
  await logoutSession(r.sessionToken);
  res.setHeader('Set-Cookie', buildClearCookie());
  res.json({ ok: true });
});