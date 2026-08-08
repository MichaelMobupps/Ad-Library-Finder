import { getDb, getGmailTokensForUser, getUserById, setUserDefaultRecipient } from './db.js';

/**
 * Generic settings table — retained for legacy / future use. The Gmail
 * connection and per-user default recipient have moved to user-scoped
 * storage (gmail_tokens and users.default_recipient respectively); the
 * helpers below operate on the per-user model.
 */

export async function getSetting(key: string): Promise<string | null>{
  const row = await getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    )
    .run(key, value, Date.now());
}

export async function deleteSetting(key: string) {
  await getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

// ---------- per-user accessors ----------

export async function getDefaultRecipientForUser(userId: string): Promise<string | null>{
  const user = await getUserById(userId);
  // Zero-config default: if the user has not set an explicit default recipient,
  // fall back to the email they sign in with. Every user therefore receives
  // job-completion emails at their own address with no setup. An explicit
  // default (set below) and a per-job recipient on the New Job form both still
  // take precedence over this fallback.
  return user?.default_recipient || user?.email || null;
}

export async function setDefaultRecipientForUser(userId: string, recipient: string | null) {
  await setUserDefaultRecipient(userId, recipient);
}

export async function getConnectedGmailEmailForUser(userId: string): Promise<string | null>{
  return await (await getGmailTokensForUser(userId))?.gmail_email ?? null;
}

export async function isGmailConnectedForUser(userId: string): Promise<boolean>{
  const t = await getGmailTokensForUser(userId);
  return !!(t && t.refresh_token);
}