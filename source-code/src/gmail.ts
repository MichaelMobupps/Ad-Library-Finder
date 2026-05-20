import { google } from 'googleapis';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAuthorizedClient } from './oauth.js';
import { log } from './logger.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  htmlBody: string;
  attachments?: Array<{ path: string; filename?: string; mimeType?: string }>;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const client = await getAuthorizedClient();
  const gmail = google.gmail({ version: 'v1', auth: client });

  const raw = buildMimeMessage(input);
  const encoded = base64UrlEncode(raw);

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });
  log.info(`Email sent to ${input.to}`);
}

// ---------- MIME construction ----------

function buildMimeMessage(input: SendEmailInput): string {
  const { to, subject, htmlBody, attachments = [] } = input;
  const boundary = `=_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const headers = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    attachments.length > 0
      ? `Content-Type: multipart/mixed; boundary="${boundary}"`
      : `Content-Type: text/html; charset="UTF-8"`,
  ];

  if (attachments.length === 0) {
    // Simple HTML email
    return [...headers, 'Content-Transfer-Encoding: 7bit', '', htmlBody].join('\r\n');
  }

  // Multipart message
  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/html; charset="UTF-8"');
  parts.push('Content-Transfer-Encoding: 7bit');
  parts.push('');
  parts.push(htmlBody);

  for (const att of attachments) {
    const data = readFileSync(att.path);
    const filename = att.filename ?? path.basename(att.path);
    const mimeType = att.mimeType ?? 'application/octet-stream';
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${mimeType}; name="${filename}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${filename}"`);
    parts.push('');
    // Standard base64 (Gmail accepts in MIME body); wrap at 76 chars
    parts.push(chunk(data.toString('base64'), 76));
  }

  parts.push(`--${boundary}--`);
  return [...headers, '', ...parts].join('\r\n');
}

function encodeHeader(s: string): string {
  // If only ASCII, return as-is. Otherwise RFC 2047 encoded-word.
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function chunk(s: string, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.join('\r\n');
}
