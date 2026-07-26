import type { Request, Response, NextFunction } from 'express';
import { getSessionUser, UserRow, createSession, deleteSession } from './db.js';

export const ALLOWED_DOMAIN = 'mobupps.com';
export const SESSION_COOKIE = 'als_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Admin allowlist. Admins see the cross-user Activity view and the Publishers
 * tab, and can stop any user's job. Everyone else is a regular user.
 * Extendable via ADMIN_EMAILS env (comma-separated) without a code change.
 */
export const ADMIN_EMAILS: ReadonlySet<string> = new Set(
  (process.env.ADMIN_EMAILS || 'michael@mobupps.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isAdminUser(user: Pick<UserRow, 'email'> | null | undefined): boolean {
  if (!user || !user.email) return false;
  return ADMIN_EMAILS.has(user.email.trim().toLowerCase());
}

/** Require an authenticated ADMIN. 401 when anonymous, 403 for a non-admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as RequestWithUser).user;
  if (!user) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  if (!isAdminUser(user)) {
    res.status(403).json({ error: 'admin only' });
    return;
  }
  next();
}

/**
 * Strict domain check on a verified Google email.
 * Returns true ONLY if the email ends with "@<ALLOWED_DOMAIN>" exactly
 * (case-insensitive). Subdomains and other domains are refused.
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email || typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  // Exactly one '@', and the portion after it must be exactly the allowed domain.
  const atIdx = normalized.indexOf('@');
  if (atIdx <= 0 || atIdx !== normalized.lastIndexOf('@')) return false;
  const domain = normalized.slice(atIdx + 1);
  return domain === ALLOWED_DOMAIN;
}

/**
 * Parse the session cookie out of the Cookie header. We avoid pulling in
 * cookie-parser; the format we set is simple and we only need one cookie.
 */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

/**
 * Build the Set-Cookie header value for a session token.
 * HttpOnly + Secure + SameSite=Lax + Path=/.
 */
export function buildSessionCookie(token: string): string {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Attach the current user (if any) to req.user. Does NOT enforce.
 */
export function userContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = readSessionCookie(req);
  if (token) {
    const user = getSessionUser(token);
    if (user) {
      (req as RequestWithUser).user = user;
      (req as RequestWithUser).sessionToken = token;
    }
  }
  next();
}

/**
 * Require an authenticated user. JSON 401 on failure (suitable for /api/* routes).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = (req as RequestWithUser).user;
  if (!user) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
}

export interface RequestWithUser extends Request {
  user?: UserRow;
  sessionToken?: string;
}

export function loginUser(userId: string): { token: string; cookie: string } {
  const session = createSession(userId, SESSION_TTL_MS);
  return { token: session.token, cookie: buildSessionCookie(session.token) };
}

export function logoutSession(token: string | undefined) {
  if (!token) return;
  deleteSession(token);
}

// Lightweight HTML page for the domain-restriction refusal. Kept here (not in
// the dashboard build) so it works even before the SPA loads.
export function accessRestrictedHtml(deniedEmail: string): string {
  const safe = deniedEmail
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Access restricted</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a1410; color: #e6f4ed; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { max-width: 520px; background: #11231b; border: 1px solid #1f3a2c; border-radius: 8px; padding: 32px; }
    h1 { margin: 0 0 12px 0; font-size: 22px; color: #ff9c8a; }
    p { line-height: 1.5; color: #c8dccf; }
    code { background: #0a1410; padding: 2px 6px; border-radius: 3px; color: #5cf2a8; }
    a.btn { display: inline-block; margin-top: 16px; padding: 10px 18px; background: #5cf2a8; color: #0a1410; text-decoration: none; border-radius: 4px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Access restricted</h1>
    <p>Sign-in is limited to <strong>@${ALLOWED_DOMAIN}</strong> Google accounts.</p>
    <p>The account <code>${safe}</code> is not allowed. No session has been created.</p>
    <p>Sign out of that Google account or switch profiles, then try again.</p>
    <a class="btn" href="/">Back to login</a>
  </div>
</body>
</html>`;
}