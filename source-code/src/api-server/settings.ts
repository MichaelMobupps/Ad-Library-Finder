import { getDb, getGmailTokensForUser, getUserById, setUserDefaultRecipient } from './db.js';

/**
 * Generic settings table — retained for legacy / future use. The Gmail
 * connection and per-user default recipient have moved to user-scoped
 * storage (gmail_tokens and users.default_recipient respectively); the
 * helpers below operate on the per-user model.
 */

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    )
    .run(key, value, Date.now());
}

export function deleteSetting(key: string) {
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

// ---------- per-user accessors ----------

export function getDefaultRecipientForUser(userId: string): string | null {
  const user = getUserById(userId);
  return user?.default_recipient ?? null;
}

export function setDefaultRecipientForUser(userId: string, recipient: string | null) {
  setUserDefaultRecipient(userId, recipient);
}

export function getConnectedGmailEmailForUser(userId: string): string | null {
  return getGmailTokensForUser(userId)?.gmail_email ?? null;
}

export function isGmailConnectedForUser(userId: string): boolean {
  const t = getGmailTokensForUser(userId);
  return !!(t && t.refresh_token);
}