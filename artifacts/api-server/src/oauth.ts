import { google, oauth2_v2 } from 'googleapis';
import { OAuth2Client, Credentials } from 'google-auth-library';
import type { Request } from 'express';
import { getSetting, setSetting, SETTING_KEYS } from './settings.js';
import { log } from './logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

/**
 * Derive the redirect URI to register with Google.
 *
 * Priority:
 *   1. The actual deployed host as seen by Replit's edge proxy
 *      (x-forwarded-proto + x-forwarded-host). This guarantees the URI
 *      matches the origin the user is on, even if PUBLIC_BASE_URL is
 *      misconfigured.
 *   2. Host header on the incoming request (covers direct-hit local dev).
 *   3. PUBLIC_BASE_URL environment variable (legacy fallback).
 *
 * The authorize-step and token-exchange step MUST produce the same string;
 * because both /api/auth/google and /api/auth/google/callback are hit on
 * the same host, header-derivation is stable across the two calls.
 */
export function getRedirectUriFromReq(req: Request): string {
  const xfProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const xfHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const hostHeader = req.get('host');

  const proto = xfProto || (req.secure ? 'https' : 'http');
  const host = xfHost || hostHeader;

  if (host) {
    return `${proto}://${host}/api/auth/google/callback`;
  }

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error(
      'Cannot determine OAuth redirect URI: no x-forwarded-host / host header and PUBLIC_BASE_URL is not set'
    );
  }
  return `${base}/api/auth/google/callback`;
}

export function createOAuthClient(redirectUri?: string): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri
  );
}

export function getAuthUrl(state: string, req: Request): string {
  const redirectUri = getRedirectUriFromReq(req);
  log.info(`OAuth authorize: using redirect_uri=${redirectUri}`);
  const client = createOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',     // Get refresh token
    prompt: 'consent',          // Force refresh-token return even if previously granted
    scope: SCOPES,
    state,
  });
}

export async function exchangeCodeForTokens(code: string, req: Request): Promise<{ email: string }> {
  const redirectUri = getRedirectUriFromReq(req);
  log.info(`OAuth callback: using redirect_uri=${redirectUri}`);
  const client = createOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) throw new Error('No access_token in OAuth response');
  if (!tokens.refresh_token) {
    // If the user has previously authorized, Google won't return a refresh_token
    // unless prompt=consent is set. We do set it above, so this is unusual.
    log.warn('No refresh_token in OAuth response — Disconnect & re-Connect to fix');
  }

  client.setCredentials(tokens);

  // Fetch the email of the authorized account
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();
  const email = (profile.data as oauth2_v2.Schema$Userinfo).email;
  if (!email) throw new Error('Could not resolve authorized account email');

  // Persist
  setSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN, tokens.access_token);
  if (tokens.refresh_token) setSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN, tokens.refresh_token);
  if (tokens.expiry_date) setSetting(SETTING_KEYS.OAUTH_EXPIRES_AT, String(tokens.expiry_date));
  setSetting(SETTING_KEYS.OAUTH_EMAIL, email);

  return { email };
}

/**
 * Returns an OAuth2Client with valid credentials, refreshing if needed.
 * Throws if Gmail is not connected.
 *
 * Note: redirect URI is NOT needed for the refresh-token flow, so we
 * construct the client without one.
 */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const refreshToken = getSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN);
  if (!refreshToken) throw new Error('Gmail not connected — go to Settings and click Connect');

  const accessToken = getSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN);
  const expiresAt = Number(getSetting(SETTING_KEYS.OAUTH_EXPIRES_AT) || 0);

  const client = createOAuthClient();
  const creds: Credentials = {
    refresh_token: refreshToken,
    access_token: accessToken ?? undefined,
    expiry_date: expiresAt || undefined,
  };
  client.setCredentials(creds);

  // Listen for any token refresh and persist
  client.on('tokens', (newTokens: Credentials) => {
    if (newTokens.access_token) setSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN, newTokens.access_token);
    if (newTokens.expiry_date) setSetting(SETTING_KEYS.OAUTH_EXPIRES_AT, String(newTokens.expiry_date));
    if (newTokens.refresh_token) setSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN, newTokens.refresh_token);
  });

  // If access token is missing or near expiry, force a refresh
  const needsRefresh = !accessToken || !expiresAt || expiresAt - Date.now() < 60_000;
  if (needsRefresh) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
  }

  return client;
}