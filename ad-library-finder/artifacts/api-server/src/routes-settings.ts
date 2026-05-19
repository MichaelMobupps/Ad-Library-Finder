import { Router, Request, Response } from 'express';
import {
  SETTING_KEYS,
  getSetting,
  setSetting,
  getDefaultRecipient,
  getConnectedGmailEmail,
  isGmailConnected,
  disconnectGmail,
} from './settings.js';
import { sendEmail } from './gmail.js';
import { log } from './logger.js';

export const settingsRouter: Router = Router();

// GET /api/settings
settingsRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    gmailConnected: isGmailConnected(),
    gmailEmail: getConnectedGmailEmail(),
    defaultRecipient: getDefaultRecipient(),
  });
});

// PUT /api/settings/recipient { email: string }
settingsRouter.put('/recipient', (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  if (typeof email !== 'string') return res.status(400).json({ error: 'email required' });
  const trimmed = email.trim();
  if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'invalid email format' });
  }
  setSetting(SETTING_KEYS.DEFAULT_RECIPIENT, trimmed);
  res.json({ defaultRecipient: trimmed });
});

// POST /api/settings/disconnect-gmail
settingsRouter.post('/disconnect-gmail', (_req: Request, res: Response) => {
  disconnectGmail();
  res.json({ ok: true });
});

// POST /api/settings/test-email — send a tiny test from the connected account to the default recipient
settingsRouter.post('/test-email', async (_req: Request, res: Response) => {
  try {
    const to = getDefaultRecipient();
    if (!to) return res.status(400).json({ error: 'no default recipient set' });
    if (!isGmailConnected()) return res.status(400).json({ error: 'Gmail not connected' });

    await sendEmail({
      to,
      subject: 'Ad Library Finder — test email',
      htmlBody: `<p>This is a test from your Ad Library Finder Replit deployment.</p>
                 <p>Sent by: <code>${getSetting(SETTING_KEYS.OAUTH_EMAIL)}</code></p>`,
    });
    res.json({ ok: true });
  } catch (err) {
    log.error('test email failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});
