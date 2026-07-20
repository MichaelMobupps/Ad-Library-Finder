import { existsSync } from 'node:fs';
import path from 'node:path';
import { JobRow, setJobNotificationStatus, getUserById, getGmailTokensForUser, appendLog } from './db.js';
import { sendEmailFromUser } from './gmail.js';
import { getDefaultRecipientForUser } from './settings.js';
import { log } from './logger.js';

function resolveRecipient(job: JobRow): string | null {
  if (job.recipient_email) return job.recipient_email;
  if (job.created_by_user_id) return getDefaultRecipientForUser(job.created_by_user_id);
  return null;
}

function publicJobUrl(jobId: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/#/jobs/${jobId}`;
}

function publicCsvUrl(jobId: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/jobs/${jobId}/csv`;
}

function publicHqZipUrl(jobId: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/jobs/${jobId}/hq-zip`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtDuration(startMs: number | null, endMs: number | null): string {
  if (!startMs || !endMs) return '—';
  const s = Math.round((endMs - startMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

/**
 * Resolve the sender for a job: the user who created it. The user's Gmail
 * must be connected. Returns null with a logged reason if not sendable.
 */
function resolveSender(job: JobRow): { userId: string; gmailEmail: string } | null {
  if (!job.created_by_user_id) {
    log.warn(`Job ${job.id} has no created_by_user_id — cannot send (legacy job?)`);
    return null;
  }
  const user = getUserById(job.created_by_user_id);
  if (!user) {
    log.warn(`Job ${job.id} created_by_user_id=${job.created_by_user_id} does not exist`);
    return null;
  }
  const tokens = getGmailTokensForUser(user.id);
  if (!tokens || !tokens.refresh_token) {
    log.warn(`Job ${job.id} owner ${user.email} has no Gmail connected — cannot send`);
    return null;
  }
  return { userId: user.id, gmailEmail: tokens.gmail_email ?? user.email };
}

export async function notifyJobCompleted(job: JobRow) {
  const sender = resolveSender(job);
  if (!sender) {
    appendLog(job.id, 'warn', 'completion email skipped: sender Gmail not connected — connect Gmail in Settings');
    setJobNotificationStatus(job.id, 'failed');
    return;
  }
  const to = resolveRecipient(job);
  if (!to) {
    appendLog(job.id, 'warn', 'completion email skipped: no recipient resolved — set a default recipient in Settings');
    log.info(`Job ${job.id} done but no recipient resolved — skipping email`);
    setJobNotificationStatus(job.id, 'failed');
    return;
  }

  const countries = (JSON.parse(job.countries) as string[]).join(', ');
  const duration = fmtDuration(job.started_at, job.completed_at);
  const csvUrl = publicCsvUrl(job.id);
  const jobUrl = publicJobUrl(job.id);
  const csvExists = !!job.csv_path && existsSync(job.csv_path);

  // HQ-split zip: present iff HQ resolution produced one — mobile jobs (any
  // source) and Google Ads web/CPS jobs. Gated on hq_zip_path, not product_type.
  const hqZipExists = !!job.hq_zip_path && existsSync(job.hq_zip_path);
  const hqZipUrl = publicHqZipUrl(job.id);

  const subject = `Ad Library Finder: ${job.product_type.toUpperCase()} job complete — ${job.total_advertisers} advertisers (${countries})`;
  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 640px;">
  <h2 style="margin-bottom: 4px;">Job complete</h2>
  <p style="color: #6b7280; margin-top: 0;"><code>${escapeHtml(job.id)}</code></p>

  <table style="border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 6px 16px 6px 0; color: #6b7280; font-size: 13px;">Product type</td><td style="padding: 6px 0;"><strong>${escapeHtml(job.product_type.toUpperCase())}</strong></td></tr>
    <tr><td style="padding: 6px 16px 6px 0; color: #6b7280; font-size: 13px;">Countries</td><td style="padding: 6px 0;">${escapeHtml(countries)}</td></tr>
    <tr><td style="padding: 6px 16px 6px 0; color: #6b7280; font-size: 13px;">Advertisers in CSV</td><td style="padding: 6px 0;"><strong>${job.total_advertisers}</strong></td></tr>
    <tr><td style="padding: 6px 16px 6px 0; color: #6b7280; font-size: 13px;">Ads scraped</td><td style="padding: 6px 0;">${job.total_ads_scraped}</td></tr>
    <tr><td style="padding: 6px 16px 6px 0; color: #6b7280; font-size: 13px;">Duration</td><td style="padding: 6px 0;">${duration}</td></tr>
    <tr><td style="padding: 6px 16px 6px 0; color: #6b7280; font-size: 13px;">Sent by</td><td style="padding: 6px 0;"><code>${escapeHtml(sender.gmailEmail)}</code></td></tr>
  </table>

  <p>
    <a href="${csvUrl}" style="display: inline-block; padding: 10px 18px; background: #0a1410; color: #5cf2a8; text-decoration: none; border-radius: 4px; font-weight: 600;">⬇ Download CSV</a>
    ${hqZipExists ? `&nbsp;&nbsp;<a href="${hqZipUrl}" style="display: inline-block; padding: 10px 18px; background: #1a1a1a; color: #ffd166; text-decoration: none; border-radius: 4px; font-weight: 600;">⬇ Download HQ split (.zip)</a>` : ''}
  </p>

  ${hqZipExists ? `<p style="color: #6b7280; font-size: 13px;">The HQ-split bundle contains one .xlsx per HQ country (US.xlsx, BR.xlsx, JP.xlsx, …) plus Unknown.xlsx for apps where the HQ could not be resolved. Both the CSV and the zip are attached to this email for convenience.</p>` : ''}
  ${csvExists && !hqZipExists ? `<p style="color: #6b7280; font-size: 13px;">The CSV is also attached to this email for convenience.</p>` : ''}

  <p style="color: #6b7280; font-size: 13px;">
    View full job log: <a href="${jobUrl}">${jobUrl}</a>
  </p>
</body></html>`;

  // Compose attachments: CSV (if exists) + HQ zip (if exists). Any job whose HQ
  // split produced a zip (mobile jobs, and Google Ads web/CPS jobs) gets both.
  const attachments: Array<{ path: string; mimeType: string; filename?: string }> = [];
  if (csvExists) {
    attachments.push({ path: job.csv_path!, mimeType: 'text/csv' });
  }
  if (hqZipExists) {
    attachments.push({
      path: job.hq_zip_path!,
      mimeType: 'application/zip',
      filename: path.basename(job.hq_zip_path!),
    });
  }

  try {
    await sendEmailFromUser(sender.userId, {
      to,
      subject,
      htmlBody: html,
      attachments,
    });
    appendLog(job.id, 'info', `completion email sent to ${to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}`);
    setJobNotificationStatus(job.id, 'sent');
  } catch (err) {
    appendLog(job.id, 'error', `completion email failed: ${(err as Error).message}`);
    log.error(`notify completed failed for ${job.id}`, (err as Error).message);
    setJobNotificationStatus(job.id, 'failed');
  }
}

export async function notifyJobFailed(job: JobRow) {
  const sender = resolveSender(job);
  if (!sender) {
    appendLog(job.id, 'warn', 'failure email skipped: sender Gmail not connected');
    setJobNotificationStatus(job.id, 'failed');
    return;
  }
  const to = resolveRecipient(job);
  if (!to) {
    appendLog(job.id, 'warn', 'failure email skipped: no recipient resolved');
    setJobNotificationStatus(job.id, 'failed');
    return;
  }

  const countries = (JSON.parse(job.countries) as string[]).join(', ');
  const jobUrl = publicJobUrl(job.id);

  const subject = `Ad Library Finder: job FAILED — ${job.id}`;
  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 640px;">
  <h2 style="color: #c0392b;">Job failed</h2>
  <p><code>${escapeHtml(job.id)}</code> — ${escapeHtml(job.product_type.toUpperCase())} / ${escapeHtml(countries)}</p>
  <p style="background: #fef2f2; padding: 12px 16px; border-left: 3px solid #c0392b; font-family: ui-monospace, monospace; font-size: 13px;">
    ${escapeHtml(job.error || 'unknown error')}
  </p>
  <p style="color: #6b7280; font-size: 13px;">
    View full job log: <a href="${jobUrl}">${jobUrl}</a>
  </p>
</body></html>`;

  try {
    await sendEmailFromUser(sender.userId, { to, subject, htmlBody: html });
    appendLog(job.id, 'info', `failure email sent to ${to}`);
    setJobNotificationStatus(job.id, 'sent');
  } catch (err) {
    appendLog(job.id, 'error', `failure email send failed: ${(err as Error).message}`);
    log.error(`notify failed-job email failed for ${job.id}`, (err as Error).message);
    setJobNotificationStatus(job.id, 'failed');
  }
}