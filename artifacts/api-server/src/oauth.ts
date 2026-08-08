import { google, oauth2_v2 } from 'googleapis';
import { OAuth2Client, Credentials } from 'google-auth-library';
import type { Request } from 'express';
import { getGmailTokensForUser, upsertGmailTokens } from './db.js';
import { basePath, publicUrl, PUBLIC_URL } from './urls.js';
import { log } from './logger.js';

/**
 * Path Google redirects back to. Registered in the Google Cloud Console as an
 * Authorized redirect URI — see TODO.md "External registrations discovered".
 * Changing the app's address or base path requires adding the new URI there
 * BEFORE the cutover, or sign-in breaks for everyone.
 */
const OAUTH_CALLBACK_PATH = '/api/auth/google/callback';

/**
 * Scopes requested at sign-in:
 *   - openid / email / profile: identity (who is signing in)
 *   - gmail.send: send mail on the user's behalf (job completion emails)
 *
 * One consent flow grants both identity AND send authorization. That's why
 * the prompt asks for "Sign in with Google" once and the same tokens are
 * then used to send from that user's Gmail.
 */
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
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
 *   1. PUBLIC_URL from urls.ts (env PUBLIC_BASE_URL), whenever it is set.
 *   2. The deployed host as seen by Replit's edge proxy
 *      (x-forwarded-proto + x-forwarded-host).
 *   3. Host header on the incoming request.
 *
 * WHY PUBLIC_BASE_URL COMES FIRST (H1, after a live sign-in outage)
 * Behind the gateway a request-derived host is not this app's public address.
 * The gateway proxies `tools.mobupps.net/leadfinder/*` to the `.replit.app`
 * deployment, and Replit's edge sets x-forwarded-host to the DEPLOYMENT host —
 * so the app derived
 *   https://ad-library-finder.replit.app/leadfinder/api/auth/google/callback
 * and Google, which has only the tools.mobupps.net and gateway URIs registered,
 * answered redirect_uri_mismatch for everyone. Three things were wrong with
 * deriving it from the request, and all three go away here:
 *
 *   - the host is whatever the last proxy says, which is not our public name;
 *   - the authorize step and the token exchange can arrive on DIFFERENT hosts
 *     (the callback returns through whatever URI Google was handed), and Google
 *     compares the two strings — so a per-request derivation is not even
 *     self-consistent across the pair;
 *   - a request with no x-forwarded-proto yields "http://", which Google
 *     rejects outright.
 *
 * PUBLIC_BASE_URL is this app's declared public base. It is already validated
 * at boot (absolute http(s), no userinfo, path exactly BASE_PATH) and is
 * already the source of every emailed link, so making it authoritative here
 * aligns the OAuth URI with what the app tells the world about itself, and
 * makes the string depend on NO per-request input.
 *
 * UNSET IS THE ROLLBACK PATH AND IS UNTOUCHED. With PUBLIC_BASE_URL empty the
 * header derivation below runs exactly as it always has, including the http://
 * case and the throw when a request carries no host at all.
 */
export function getRedirectUriFromReq(req: Request): string {
  // Authoritative when set: no header can move it, so the authorize step and
  // the token exchange are the same string by construction, not by coincidence.
  if (PUBLIC_URL) {
    return publicUrl(OAUTH_CALLBACK_PATH);
  }

  const xfProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const xfHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const hostHeader = req.get('host');

  const proto = xfProto || (req.secure ? 'https' : 'http');
  const host = xfHost || hostHeader;

  if (host) {
    return `${proto}://${host}${basePath(OAUTH_CALLBACK_PATH)}`;
  }

  // Reachable only with PUBLIC_BASE_URL empty — the early return above took
  // every other case — so there is nothing left to fall back to. The old code
  // had a `return publicUrl(...)` here; it is now unreachable by construction,
  // and leaving it would read as if PUBLIC_URL were still a last resort rather
  // than the first choice.
  throw new Error(
    'Cannot determine OAuth redirect URI: no x-forwarded-host / host header and PUBLIC_BASE_URL is not set'
  );
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
    access_type: 'offline', // Get refresh token
    prompt: 'consent',      // Force refresh-token return even if previously granted
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/**
 * Exchanges an authorization code for tokens and resolves the verified
 * email + name of the signing-in Google account.
 *
 * IMPORTANT: this function does NOT persist tokens. The caller is responsible
 * for:
 *   - checking the email against the allow-list domain
 *   - upserting the user
 *   - persisting tokens against that user_id (via persistGmailTokensForUser)
 *
 * Splitting persistence from the exchange lets us reject non-mobupps emails
 * before any user/token row is created.
 */
export async function exchangeCodeForTokensAndProfile(
  code: string,
  req: Request
): Promise<{ email: string; name: string | null; tokens: Credentials }> {
  const redirectUri = getRedirectUriFromReq(req);
  log.info(`OAuth callback: using redirect_uri=${redirectUri}`);
  const client = createOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) throw new Error('No access_token in OAuth response');
  if (!tokens.refresh_token) {
    log.warn('No refresh_token in OAuth response — user may need to revoke + re-consent');
  }

  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();
  const data = profile.data as oauth2_v2.Schema$Userinfo;
  const email = data.email;
  const name = data.name ?? null;
  if (!email) throw new Error('Could not resolve authorized account email');

  return { email, name, tokens };
}

export async function persistGmailTokensForUser(userId: string, email: string, tokens: Credentials) {
  await upsertGmailTokens({
    userId,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expiry_date ?? null,
    gmailEmail: email,
  });
}

/**
 * Returns an OAuth2Client with valid credentials for the given user,
 * refreshing the access token if needed. Throws a clear error if that
 * user has no Gmail connected (no refresh token).
 */
export async function getAuthorizedClientForUser(userId: string): Promise<OAuth2Client> {
  const row = await getGmailTokensForUser(userId);
  if (!row || !row.refresh_token) {
    throw new Error('Gmail not connected for this user');
  }

  const client = createOAuthClient();
  const creds: Credentials = {
    refresh_token: row.refresh_token,
    access_token: row.access_token ?? undefined,
    expiry_date: row.expires_at ?? undefined,
  };
  client.setCredentials(creds);

  // Persist any token refresh back to this user's row.
  client.on('tokens', async (newTokens: Credentials) => {
    await upsertGmailTokens({
      userId,
      accessToken: newTokens.access_token ?? null,
      // refresh_token usually only present on first consent; preserve existing if absent
      refreshToken: newTokens.refresh_token ?? null,
      expiresAt: newTokens.expiry_date ?? null,
      gmailEmail: row.gmail_email,
    });
  });

  const needsRefresh = !row.access_token || !row.expires_at || row.expires_at - Date.now() < 60_000;
  if (needsRefresh) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
  }

  return client;
}