import { getDb } from './db.js';

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

// Convenience typed accessors for the settings we use

export const SETTING_KEYS = {
  OAUTH_ACCESS_TOKEN: 'oauth_access_token',
  OAUTH_REFRESH_TOKEN: 'oauth_refresh_token',
  OAUTH_EXPIRES_AT: 'oauth_expires_at',
  OAUTH_EMAIL: 'oauth_email',
  DEFAULT_RECIPIENT: 'default_recipient',
} as const;

export function getDefaultRecipient(): string | null {
  return getSetting(SETTING_KEYS.DEFAULT_RECIPIENT);
}

export function getConnectedGmailEmail(): string | null {
  return getSetting(SETTING_KEYS.OAUTH_EMAIL);
}

export function isGmailConnected(): boolean {
  return !!getSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN);
}

export function disconnectGmail() {
  deleteSetting(SETTING_KEYS.OAUTH_ACCESS_TOKEN);
  deleteSetting(SETTING_KEYS.OAUTH_REFRESH_TOKEN);
  deleteSetting(SETTING_KEYS.OAUTH_EXPIRES_AT);
  deleteSetting(SETTING_KEYS.OAUTH_EMAIL);
}
