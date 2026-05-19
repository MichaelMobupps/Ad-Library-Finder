import path from 'node:path';
import { existsSync } from 'node:fs';
import { JobRow, setJobNotificationStatus } from './db.js';
import { sendEmail } from './gmail.js';
import { getDefaultRecipient, isGmailConnected } from './settings.js';
import { log } from './logger.js';

function resolveRecipient(job: JobRow): string | null {
  return job.recipient_email || getDefaultRecipient();
}

function publicJobUrl(jobId: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/#/jobs/${jobId}`;
}

function publicCsvUrl(jobId: string): string {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/jobs/${jobId}/csv`;
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

export async function notifyJobCompleted(job: JobRow) {
  if (!isGmailConnected()) {
    log.info(`Job ${job.id} done but Gmail not connected — skipping email`);
    return;
  }
  const to = resolveRecipient(job);
  if (!to) {
    log.info(`Job ${job.id} done but no recipient configured — skipping email`);
    return;
  }

  const countries = (JSON.parse(job.countries) as string[]).join(', ');
  const duration = fmtDuration(job.started_at, job.completed_at);
  const csvUrl = publicCsvUrl(job.id);
  const jobUrl = publicJobUrl(job.id);
  const csvExists = !!job.csv_path && existsSync(job.csv_path);

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
  </table>

  <p>
    <a href="${csvUrl}" style="display: inline-block; padding: 10px 18px; background: #0a1410; color: #5cf2a8; text-decoration: none; border-radius: 4px; font-weight: 600;">⬇ Download CSV</a>
  </p>

  ${csvExists ? `<p style="color: #6b7280; font-size: 13px;">The CSV is also attached to this email for convenience.</p>` : ''}

  <p style="color: #6b7280; font-size: 13px;">
    View full job log: <a href="${jobUrl}">${jobUrl}</a>
  </p>
</body></html>`;

  try {
    await sendEmail({
      to,
      subject,
      htmlBody: html,
      attachments: csvExists ? [{ path: job.csv_path!, mimeType: 'text/csv' }] : [],
    });
    setJobNotificationStatus(job.id, 'sent');
  } catch (err) {
    log.error(`notify completed failed for ${job.id}`, (err as Error).message);
    setJobNotificationStatus(job.id, 'failed');
  }
}

export async function notifyJobFailed(job: JobRow) {
  if (!isGmailConnected()) return;
  const to = resolveRecipient(job);
  if (!to) return;

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
    await sendEmail({ to, subject, htmlBody: html });
    setJobNotificationStatus(job.id, 'sent');
  } catch (err) {
    log.error(`notify failed-job email failed for ${job.id}`, (err as Error).message);
    setJobNotificationStatus(job.id, 'failed');
  }
}
