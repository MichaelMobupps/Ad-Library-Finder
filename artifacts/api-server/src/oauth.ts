import { google, oauth2_v2 } from 'googleapis';
import { OAuth2Client, Credentials } from 'google-auth-library';
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

function getRedirectUri(): string {
  const base = requireEnv('PUBLIC_BASE_URL').replace(/\/$/, '');
  return `${base}/api/auth/google/callback`;
}

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    getRedirectUri()
  );
}

export function getAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',     // Get refresh token
    prompt: 'consent',          // Force refresh-token return even if previously granted
    scope: SCOPES,
    state,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<{ email: string }> {
  const client = createOAuthClient();
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
