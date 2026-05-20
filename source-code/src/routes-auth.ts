import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { getAuthUrl, exchangeCodeForTokens } from './oauth.js';
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

// GET /api/auth/google — initiate OAuth flow
authRouter.get('/google', (_req: Request, res: Response) => {
  try {
    reapStates();
    const state = nanoid(24);
    stateStore.set(state, Date.now());
    const url = getAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    log.error('auth init failed', err);
    res.status(500).send(`Failed to start OAuth: ${(err as Error).message}`);
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
    const { email } = await exchangeCodeForTokens(code);
    log.info(`Gmail connected: ${email}`);
    // Bounce back to the UI settings page
    res.redirect('/?gmail_connected=1#/settings');
  } catch (err) {
    log.error('OAuth callback failed', err);
    res.status(500).send(`OAuth exchange failed: ${(err as Error).message}`);
  }
});
