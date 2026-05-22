import { Router, Request, Response } from 'express';
import {
  getDefaultRecipientForUser,
  setDefaultRecipientForUser,
  getConnectedGmailEmailForUser,
  isGmailConnectedForUser,
} from './settings.js';
import { deleteGmailTokens } from './db.js';
import { sendEmailFromUser } from './gmail.js';
import { RequestWithUser } from './auth.js';
import { log } from './logger.js';

export const settingsRouter: Router = Router();

// GET /api/settings — per-user view
settingsRouter.get('/', (req: Request, res: Response) => {
  const user = (req as RequestWithUser).user!;
  res.json({
    userEmail: user.email,
    userName: user.name,
    gmailConnected: isGmailConnectedForUser(user.id),
    gmailEmail: getConnectedGmailEmailForUser(user.id),
    defaultRecipient: getDefaultRecipientForUser(user.id),
  });
});

// PUT /api/settings/recipient { email: string }
settingsRouter.put('/recipient', (req: Request, res: Response) => {
  const user = (req as RequestWithUser).user!;
  const { email } = req.body as { email: string };
  if (typeof email !== 'string') return res.status(400).json({ error: 'email required' });
  const trimmed = email.trim();
  if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'invalid email format' });
  }
  setDefaultRecipientForUser(user.id, trimmed || null);
  res.json({ defaultRecipient: trimmed || null });
});

// POST /api/settings/disconnect-gmail
settingsRouter.post('/disconnect-gmail', (req: Request, res: Response) => {
  const user = (req as RequestWithUser).user!;
  deleteGmailTokens(user.id);
  res.json({ ok: true });
});

// POST /api/settings/test-email — send a tiny test from the user's connected Gmail
settingsRouter.post('/test-email', async (req: Request, res: Response) => {
  const user = (req as RequestWithUser).user!;
  try {
    const to = getDefaultRecipientForUser(user.id);
    if (!to) return res.status(400).json({ error: 'no default recipient set' });
    if (!isGmailConnectedForUser(user.id)) {
      return res.status(400).json({ error: 'Gmail not connected for this user' });
    }

    const senderEmail = getConnectedGmailEmailForUser(user.id);
    await sendEmailFromUser(user.id, {
      to,
      subject: 'Ad Library Finder — test email',
      htmlBody: `<p>This is a test from your Ad Library Finder Replit deployment.</p>
                 <p>Sent by: <code>${senderEmail ?? user.email}</code></p>`,
    });
    res.json({ ok: true });
  } catch (err) {
    log.error('test email failed', err);
    res.status(500).json({ error: (err as Error).message });
  }
});