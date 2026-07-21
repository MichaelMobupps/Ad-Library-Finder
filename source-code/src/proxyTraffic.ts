/**
 * Proxy-Seller residential traffic monitor.
 *
 * The Google Ads scraper egresses through a Proxy-Seller residential package
 * (GOOGLE_ADS_PROXY_URL) billed per GB. When the package runs dry the proxy
 * starts refusing tunnels and a job burns its whole retry/backoff ladder
 * against a dead egress before failing with a confusing "blocked" message.
 * This module asks the provider how much traffic is left BEFORE a job starts
 * (abort early, clear message) and again after it completes (log the job's
 * actual cost in MB — a burn-rate meter inside the job log).
 *
 * API (from the official user-api SDKs):
 *   GET https://proxy-seller.com/personal/api/v1/{API_KEY}/resident/package
 *   → { status: 'success', data: { …traffic_limit, traffic_usage… } }
 * Traffic values are bytes; a magnitude heuristic (parsePackageResponse)
 * also accepts GB-denominated values in case the provider changes units.
 * The key comes from dashboard → "Custom API".
 *
 * Env:
 *   PROXY_SELLER_API_KEY    — enables the feature; absent → all no-ops.
 *   PROXY_TRAFFIC_WARN_GB   — warn when remaining falls below (default 1).
 *   PROXY_TRAFFIC_ABORT_GB  — refuse to start a job below (default 0.05).
 *
 * Every call is fail-open: an unreachable/reshaped API logs a warning and
 * lets the job run — the monitor must never be the thing that breaks scraping.
 * These requests go DIRECT (never through the proxy): it's the provider's own
 * control-plane API, and it must stay reachable when the package is empty.
 */

const API_BASE = 'https://proxy-seller.com/personal/api/v1';
const API_KEY = (process.env.PROXY_SELLER_API_KEY || '').trim();
const TIMEOUT_MS = 10_000;

const WARN_GB = envGb('PROXY_TRAFFIC_WARN_GB', 1);
const ABORT_GB = envGb('PROXY_TRAFFIC_ABORT_GB', 0.05);
const BYTES_PER_GB = 1024 ** 3;

function envGb(name: string, dflt: number): number {
  // Blank ("PROXY_TRAFFIC_ABORT_GB=" in a templated .env) means unset, not 0 —
  // Number('') is 0 and would silently disable the gate.
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

type LogFn = (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;

export interface ProxyTrafficSnapshot {
  limitBytes: number;
  usageBytes: number;
  remainingBytes: number;
  /** Package expiry if the API exposed one (ISO-ish string, verbatim). */
  expiresAt: string | null;
}

/** Thrown by checkProxyTrafficBeforeJob when remaining < PROXY_TRAFFIC_ABORT_GB.
 *  Message is kept < 200 chars so the dashboard's phase_detail slice shows it whole. */
export class ProxyTrafficExhaustedError extends Error {
  constructor(remainingBytes: number) {
    super(
      `proxy traffic exhausted: ${fmtBytes(remainingBytes)} left (< ${ABORT_GB} GB). ` +
        `Add GB in the Proxy-Seller dashboard, or unset PROXY_SELLER_API_KEY to bypass.`,
    );
    this.name = 'ProxyTrafficExhaustedError';
  }
}

export function isTrafficMonitorConfigured(): boolean {
  return !!API_KEY;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '? MB';
  const gb = n / BYTES_PER_GB;
  if (Math.abs(gb) >= 1) return `${gb.toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Never let the API key (it lives in the request URL) reach a log line. */
function redactKey(msg: string): string {
  return API_KEY ? msg.split(API_KEY).join('***') : msg;
}

/**
 * Fetch the residential package state. Returns null (after a warn log) on any
 * failure — network, auth, or an unrecognized response shape.
 */
export async function fetchProxyTraffic(onLog?: LogFn): Promise<ProxyTrafficSnapshot | null> {
  if (!API_KEY) return null;
  let body: unknown;
  try {
    const res = await fetch(`${API_BASE}/${API_KEY}/resident/package`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      void res.body?.cancel(); // release the undici connection
      onLog?.('warn', `proxy-traffic: Proxy-Seller API returned HTTP ${res.status} — skipping the traffic check`);
      return null;
    }
    // An invalid/revoked key can land on an HTML page (observed live: a 301
    // chain to the marketing homepage, served 200). Say so, instead of the
    // misleading "unreachable" that res.json() throwing would produce.
    const ct = res.headers.get('content-type') || '';
    if (!ct.toLowerCase().includes('json')) {
      void res.body?.cancel();
      onLog?.(
        'warn',
        `proxy-traffic: Proxy-Seller API returned ${ct || 'no content-type'} instead of JSON` +
          `${res.redirected ? ' after a redirect' : ''} — API key likely invalid/revoked — skipping the traffic check`,
      );
      return null;
    }
    body = await res.json();
  } catch (err) {
    // String(…?.message ?? err): this catch IS the fail-open perimeter — it must
    // itself be throw-proof even for non-Error rejections.
    onLog?.('warn', `proxy-traffic: Proxy-Seller API unreachable (${redactKey(String((err as Error)?.message ?? err))}) — skipping the traffic check`);
    return null;
  }

  const snap = parsePackageResponse(body);
  if (!snap) {
    // The API hands over the reason ("Error api key", "IP not allowed x.x.x.x",
    // "Request limit reached") in its error envelope — surface it at warn level
    // instead of burying it in the debug raw dump behind an opaque parse message.
    const apiErrors = extractApiErrors(body);
    if (apiErrors) {
      onLog?.('warn', `proxy-traffic: Proxy-Seller API error: ${redactKey(apiErrors).slice(0, 300)} — skipping the traffic check`);
    } else {
      onLog?.('warn', 'proxy-traffic: could not read traffic_limit/traffic_usage from the Proxy-Seller response — skipping the traffic check');
    }
    // Redact BEFORE slicing — a slice landing mid-key would defeat exact-match redaction.
    onLog?.('debug', `proxy-traffic: raw response: ${redactKey(safeJson(body)).slice(0, 500)}`);
    return null;
  }
  return snap;
}

/**
 * Job-start gate. No API key → no-op. Exhausted package → throws
 * ProxyTrafficExhaustedError (caller fails the job with that message).
 * Low package → warn. Otherwise → one info line with the remaining balance.
 * Returns the snapshot so the caller can diff it after the job.
 */
export async function checkProxyTrafficBeforeJob(onLog: LogFn): Promise<ProxyTrafficSnapshot | null> {
  const snap = await fetchProxyTraffic(onLog);
  if (!snap) return null; // unconfigured or fail-open
  const verdict = classifyRemaining(snap.remainingBytes);
  if (verdict === 'abort') throw new ProxyTrafficExhaustedError(snap.remainingBytes);
  const line =
    `proxy-traffic: ${fmtBytes(snap.remainingBytes)} of ${fmtBytes(snap.limitBytes)} remaining` +
    (snap.expiresAt ? ` (package active until ${snap.expiresAt})` : '');
  if (verdict === 'warn') {
    onLog('warn', `${line} — running LOW (warn threshold ${WARN_GB} GB); top up soon in the Proxy-Seller dashboard`);
  } else {
    onLog('info', line);
  }
  return snap;
}

/**
 * Job-end burn report: re-fetch usage and log what THIS job consumed.
 * Best-effort; silent no-op when the monitor is off or either fetch failed.
 */
export async function logProxyTrafficAfterJob(before: ProxyTrafficSnapshot | null, onLog: LogFn): Promise<void> {
  if (!before) return;
  const after = await fetchProxyTraffic(onLog);
  if (!after) return;
  const used = after.usageBytes - before.usageBytes;
  // A negative delta means the provider reset/renewed the package mid-job.
  if (used >= 0) {
    onLog('info', `proxy-traffic: this job used ${fmtBytes(used)}; ${fmtBytes(after.remainingBytes)} remaining`);
  } else {
    onLog('info', `proxy-traffic: package was renewed mid-job; ${fmtBytes(after.remainingBytes)} remaining`);
  }
}

// ── pure helpers (offline-testable) ──────────────────────────────────────────

/** Threshold verdict on a remaining-bytes balance. Thresholds are injectable
 *  for hermetic tests; production callers use the env-derived defaults. */
export function classifyRemaining(
  remainingBytes: number,
  abortGb: number = ABORT_GB,
  warnGb: number = WARN_GB,
): 'abort' | 'warn' | 'ok' {
  if (remainingBytes < abortGb * BYTES_PER_GB) return 'abort';
  if (remainingBytes < warnGb * BYTES_PER_GB) return 'warn';
  return 'ok';
}

/** Sanity window for a normalized package limit. Anything outside it means the
 *  parse (envelope or units) is suspect → fail-open, never gate on it.
 *  Residential packages run 1 GB – low TB; 256 MB and 100 TiB are generous. */
const PLAUSIBLE_LIMIT_MIN = 256 * 1024 ** 2;
const PLAUSIBLE_LIMIT_MAX = 100 * 1024 ** 4;

/**
 * Parse a resident/package response into a snapshot, or null when the shape is
 * unrecognizable / ungateable. Doctrine: this function's output can BLOCK jobs,
 * so any ambiguity resolves toward null (caller fails open) or toward the
 * candidate with the MOST remaining traffic (wrongly running is benign — no
 * worse than having no monitor; wrongly aborting kills good jobs). Defenses:
 *  - Envelope: collects EVERY object carrying traffic_limit+traffic_usage in
 *    the response (the API wraps data in { status, data } and an account with
 *    a renewal history may list several packages), drops entries explicitly
 *    marked inactive/expired, then gates on the one with most remaining.
 *  - Units: values are bytes by observation; a limit under 1e6 can only
 *    sensibly be GB-denominated (no package is < 1 MB) — scale it. After
 *    normalization the limit must land in a plausible package range, else
 *    the units are something we don't understand (KB? MB?) → null.
 *  - A non-positive limit (unknown/unlimited plan) is not gateable → skip.
 */
export function parsePackageResponse(body: unknown): ProxyTrafficSnapshot | null {
  const candidates: Record<string, unknown>[] = [];
  collectPackageObjects(body, candidates, 0);
  const snaps: ProxyTrafficSnapshot[] = [];
  for (const pkg of candidates) {
    if (isMarkedInactive(pkg)) continue;
    let limit = num(pkg['traffic_limit'] ?? pkg['trafficLimit']);
    let usage = num(pkg['traffic_usage'] ?? pkg['trafficUsage']);
    if (limit <= 0) continue;
    if (limit < 1e6) {
      limit *= BYTES_PER_GB;
      usage *= BYTES_PER_GB;
    }
    if (limit < PLAUSIBLE_LIMIT_MIN || limit > PLAUSIBLE_LIMIT_MAX) continue;
    const expiresAt = str(pkg['expired_at'] ?? pkg['date_end'] ?? pkg['expire_at']) || null;
    snaps.push({ limitBytes: limit, usageBytes: usage, remainingBytes: Math.max(0, limit - usage), expiresAt });
  }
  if (snaps.length === 0) return null;
  snaps.sort((a, b) => b.remainingBytes - a.remainingBytes);
  return snaps[0];
}

/** Pull human-readable messages out of the API's error envelope
 *  ({ status:'error', errors:[{message,…}] }, observed live) so the operator
 *  sees "Error api key" / "IP not allowed 1.2.3.4" instead of a parse warning.
 *  Returns null when the body isn't that envelope. */
export function extractApiErrors(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj['status'] !== 'error' || !Array.isArray(obj['errors'])) return null;
  const msgs = (obj['errors'] as unknown[])
    .map((e) => (e && typeof e === 'object' ? str((e as Record<string, unknown>)['message']) : ''))
    .filter(Boolean);
  return msgs.length ? msgs.join('; ') : null;
}

/** An entry the provider itself flags as not current must never gate a job. */
function isMarkedInactive(pkg: Record<string, unknown>): boolean {
  if (pkg['is_active'] === false || pkg['active'] === false) return true;
  const status = str(pkg['status']).toLowerCase();
  return status === 'expired' || status === 'inactive' || status === 'deleted' || status === 'archived';
}

/** Bounded walk collecting every object with traffic_limit + traffic_usage. */
function collectPackageObjects(node: unknown, out: Record<string, unknown>[], depth: number): void {
  if (depth > 4 || node === null || typeof node !== 'object' || out.length >= 16) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPackageObjects(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const hasLimit = 'traffic_limit' in obj || 'trafficLimit' in obj;
  const hasUsage = 'traffic_usage' in obj || 'trafficUsage' in obj;
  if (hasLimit && hasUsage) {
    out.push(obj);
    return; // a package entry's children can't be another package
  }
  for (const v of Object.values(obj)) collectPackageObjects(v, out, depth + 1);
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 500) ?? 'undefined';
  } catch {
    return '(unserializable)';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Offline unit tests (no network). House style: run<Module>UnitTests + isMain.
// ───────────────────────────────────────────────────────────────────────────

export function runProxyTrafficUnitTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };
  const GB = BYTES_PER_GB;

  // Envelope shapes: flat, {status,data}, nested list, camelCase, string numbers.
  const flat = parsePackageResponse({ traffic_limit: 10 * GB, traffic_usage: 2 * GB });
  check(!!flat && flat.remainingBytes === 8 * GB, 'flat bytes shape parses; remaining = limit - usage');
  const wrapped = parsePackageResponse({ status: 'success', data: { traffic_limit: 10 * GB, traffic_usage: 0, expired_at: '2026-08-21' } });
  check(!!wrapped && wrapped.remainingBytes === 10 * GB && wrapped.expiresAt === '2026-08-21', 'wrapped {status,data} shape parses with expiry');
  const listed = parsePackageResponse({ data: { items: [{ traffic_limit: String(5 * GB), traffic_usage: String(GB) }] } });
  check(!!listed && listed.remainingBytes === 4 * GB, 'nested list + string numbers parse');
  const camel = parsePackageResponse({ data: { trafficLimit: 2 * GB, trafficUsage: GB } });
  check(!!camel && camel.remainingBytes === GB, 'camelCase keys parse');

  // Unit heuristic: GB-denominated values get scaled to bytes.
  const gbUnits = parsePackageResponse({ traffic_limit: 10, traffic_usage: 2.5 });
  check(!!gbUnits && gbUnits.limitBytes === 10 * GB && gbUnits.remainingBytes === 7.5 * GB, 'GB-denominated values normalize to bytes');

  // Ungateable / garbage shapes → null (fail-open), never a bogus snapshot.
  check(parsePackageResponse({ traffic_limit: 0, traffic_usage: 0 }) === null, 'zero limit (unknown/unlimited) → null');
  check(parsePackageResponse({ status: 'error', errors: ['bad key'] }) === null, 'error envelope → null');
  check(parsePackageResponse(null) === null, 'null body → null');
  check(parsePackageResponse('<html>cloudflare</html>') === null, 'non-JSON-object body → null');

  // Usage overrun (provider lets it go slightly negative) clamps to 0.
  const over = parsePackageResponse({ traffic_limit: GB, traffic_usage: GB + 1024 });
  check(!!over && over.remainingBytes === 0, 'overrun usage clamps remaining to 0');

  // Multi-package accounts: an expired/inactive entry must be skipped even when
  // it looks RICHEST — the dead entry gets the most remaining in these fixtures,
  // so the filter (not the most-remaining sort) is what each assertion exercises.
  // (Earlier fixtures gave the dead entry 0 remaining; mutation testing showed
  // the filter could be deleted entirely and those assertions still passed.)
  const multi = parsePackageResponse({
    data: [
      { is_active: false, traffic_limit: 10 * GB, traffic_usage: GB }, // 9 GB but inactive
      { is_active: true, traffic_limit: 10 * GB, traffic_usage: 8 * GB }, // 2 GB, must win
    ],
  });
  check(!!multi && multi.remainingBytes === 2 * GB, 'multi-package: inactive entry with MORE remaining is skipped');
  const multiStatus = parsePackageResponse({
    data: [
      { status: 'expired', traffic_limit: 10 * GB, traffic_usage: GB }, // 9 GB but expired
      { status: 'active', traffic_limit: 10 * GB, traffic_usage: 8 * GB }, // 2 GB, must win
    ],
  });
  check(!!multiStatus && multiStatus.remainingBytes === 2 * GB, 'multi-package: expired-status entry with MORE remaining is skipped');
  const multiFlagVariants = parsePackageResponse({
    data: [
      { active: false, traffic_limit: 10 * GB, traffic_usage: 0 }, // 10 GB, active:false variant
      { status: 'deleted', traffic_limit: 10 * GB, traffic_usage: GB }, // 9 GB, deleted
      { status: 'archived', traffic_limit: 10 * GB, traffic_usage: 2 * GB }, // 8 GB, archived
      { traffic_limit: 10 * GB, traffic_usage: 9 * GB }, // 1 GB, the only live entry
    ],
  });
  check(!!multiFlagVariants && multiFlagVariants.remainingBytes === GB, 'multi-package: active:false / deleted / archived variants all skipped');
  const multiUnflagged = parsePackageResponse({
    data: [
      { traffic_limit: 5 * GB, traffic_usage: 5 * GB },
      { traffic_limit: 10 * GB, traffic_usage: GB },
    ],
  });
  check(!!multiUnflagged && multiUnflagged.remainingBytes === 9 * GB, 'multi-package unflagged: most-remaining wins (never wrongly abort)');
  check(
    parsePackageResponse({ data: [{ is_active: false, traffic_limit: 5 * GB, traffic_usage: GB }] }) === null,
    'only-inactive packages → null (fail-open)',
  );

  // Error-envelope extraction (real shape observed live from the API).
  check(
    extractApiErrors({ status: 'error', data: null, errors: [{ message: 'Error api key', code: 503 }, { message: 'IP not allowed 1.2.3.4' }] }) ===
      'Error api key; IP not allowed 1.2.3.4',
    'error envelope: messages joined for the warn line',
  );
  check(extractApiErrors({ status: 'success', data: {} }) === null, 'success envelope → no api-error string');
  check(extractApiErrors({ status: 'error', errors: [{ code: 503 }] }) === null, 'error envelope without messages → null');

  // Unit plausibility window: KB-denominated values (10 GB = 10,485,760 KB)
  // normalize to an implausible 10 MB limit → null, never a wrongful abort.
  check(parsePackageResponse({ traffic_limit: 10_485_760, traffic_usage: 2_097_152 }) === null, 'KB-denominated (implausible limit) → null');

  // Threshold classification (explicit thresholds — hermetic vs env overrides).
  check(classifyRemaining(0, 0.05, 1) === 'abort', '0 bytes → abort');
  check(classifyRemaining(0.04 * GB, 0.05, 1) === 'abort', 'below abort threshold → abort');
  check(classifyRemaining(0.5 * GB, 0.05, 1) === 'warn', 'between thresholds → warn');
  check(classifyRemaining(8 * GB, 0.05, 1) === 'ok', 'plenty → ok');

  // Formatting sanity.
  check(fmtBytes(10 * GB) === '10.00 GB', 'fmtBytes GB');
  check(fmtBytes(15 * 1024 ** 2) === '15.0 MB', 'fmtBytes MB');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('proxyTraffic.js') || process.argv[1].endsWith('proxyTraffic.ts'));
if (isMain) {
  const { passed, failed, failures } = runProxyTrafficUnitTests();
  console.log(`proxyTraffic unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
