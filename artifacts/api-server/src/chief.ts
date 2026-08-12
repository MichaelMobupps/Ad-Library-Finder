/**
 * The Chief machine surface — the token, the system principal, and every pure
 * decision behind `/api/chief/*`. The Express wiring lives in routes-chief.ts;
 * everything here is either a constant, a pure function, or a small DB helper,
 * so the contract can be unit-tested without a socket.
 *
 * WHY A SEPARATE SURFACE AT ALL
 * The Chief (the orchestrator app) commands discovery jobs over the network and
 * collects the results. It is a machine: it holds no Google account, no cookie
 * and no session. Bolting it onto the human surface would mean either handing a
 * robot a session cookie or teaching `requireAuth` a second identity — both of
 * which make "who is this?" a question with two answers on every route in the
 * app. Instead there is one mount, `/api/chief`, whose only credential is a
 * shared secret, and the two authentications never meet:
 *
 *   - `requireChiefToken` reads ONLY the Authorization header. It never looks at
 *     req.user, so a valid human session cannot open a chief path.
 *   - `requireAuth` (auth.ts) reads ONLY req.user, which comes ONLY from the
 *     session cookie. It has never read a header and does not now, so the token
 *     cannot open a cookie path.
 *
 * That separation is structural, not conventional, and check-chief-surface.mjs
 * proves it in both directions over real HTTP.
 *
 * THE SECRET
 * `CHIEF_TOKEN` is a Replit secret on this app; its value equals the Chief's
 * `LEAD_FINDER_TOKEN`. It is read once, trimmed, and never printed — not at
 * boot, not in a log line, not in an error, not in a response body. Unset means
 * nothing authenticates: every `/api/chief/*` request answers the same 401 as a
 * wrong token, which is also what a caller sees for a missing or malformed
 * header. All four causes are indistinguishable on the wire.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';
import {
  createJob,
  getDb,
  getJob,
  JobRow,
  JobResultRow,
  JobSource,
  ProductType,
} from './db.js';
import {
  isTargetType,
  isUiSource,
  resolveStoredSource,
  targetsForStoredSource,
  TARGET_TYPES,
  UI_SOURCES,
  unsupportedPairMessage,
  uiSourceForStored,
  type UiSource,
} from './sourceMatrix.js';
import { ALL_MARKETS } from './storeDiscoveryConfig.js';
import { log } from './logger.js';

// ── The token ────────────────────────────────────────────────────────────────

const RAW_CHIEF_TOKEN = process.env.CHIEF_TOKEN;

/**
 * The expected credential, trimmed. A secret pasted into a Replit Secrets box
 * arrives with a trailing newline often enough that trimming is the difference
 * between "the seam works" and a 401 nobody can explain.
 */
const CHIEF_TOKEN: string = (RAW_CHIEF_TOKEN ?? '').trim();

/**
 * True only when the stored value can ACTUALLY authenticate something. An unset
 * variable and a whitespace-only one are the same fact: nothing can log in.
 */
export const CHIEF_TOKEN_LOADED: boolean = CHIEF_TOKEN.length > 0;

/** The stored value carried surrounding whitespace and was trimmed to load. */
export const CHIEF_TOKEN_TRIMMED_WHITESPACE: boolean =
  typeof RAW_CHIEF_TOKEN === 'string' && RAW_CHIEF_TOKEN !== CHIEF_TOKEN;

/**
 * One boot line about the machine surface. Called from buildApp() rather than
 * at module load so importing this module still has no side effects.
 *
 * NEVER prints the value, and not its length either: a length narrows a brute
 * force and buys the operator nothing they cannot get from the secrets panel.
 */
export function chiefBootLog(): void {
  if (CHIEF_TOKEN_TRIMMED_WHITESPACE) {
    log.warn(
      'CHIEF_TOKEN carried surrounding whitespace and was trimmed before use. ' +
        'The trimmed value is what must match the Chief\'s LEAD_FINDER_TOKEN.',
    );
  }
  log.info(
    CHIEF_TOKEN_LOADED
      ? 'chief surface: CHIEF_TOKEN loaded — /api/chief/* is live'
      : 'chief surface: CHIEF_TOKEN is not set — every /api/chief/* request will answer 401',
  );
}

/** Constant-time string compare. Length is checked first, as timingSafeEqual demands. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // A length difference is not secret — it is observable from the request the
  // caller sent — and timingSafeEqual throws on unequal lengths.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Does this Authorization header carry the expected credential?
 *
 * Exported (with the expected value as an argument) so the decision can be
 * tested without an environment variable.
 *
 *   - the scheme is case-SENSITIVE: "Bearer", never "bearer" or "BEARER". A
 *     machine caller emits exactly what its contract says; tolerating case
 *     variants only widens what has to be reasoned about.
 *   - exactly one space between scheme and credential, and the credential is
 *     taken verbatim — NOT trimmed. Trimming here would make " tok " and "tok"
 *     the same credential, which is a whitespace trick, not a convenience.
 *   - an unset expected value authenticates nothing, whatever was presented.
 */
export function tokenAuthorizes(header: unknown, expected: string): boolean {
  if (!expected) return false;
  if (typeof header !== 'string') return false;
  const sp = header.indexOf(' ');
  if (sp === -1) return false;
  if (header.slice(0, sp) !== 'Bearer') return false;
  const presented = header.slice(sp + 1);
  if (presented.length === 0) return false;
  return constantTimeEquals(presented, expected);
}

/** Every chief response, success or failure. A machine surface is never cached. */
export function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * THE 401. One literal body for all four causes — no header, a malformed
 * header, a wrong token, and an unset secret are indistinguishable to the
 * caller. Nothing about the expected value (existence, length, shape) leaks.
 */
export function sendChiefUnauthorized(res: Response): void {
  noStore(res);
  res.status(401).json({ error: 'unauthorized' });
}

/**
 * Bearer gate for the whole `/api/chief` mount.
 *
 * Reads the Authorization header and NOTHING else. In particular it never
 * consults `req.user`, which is what makes "a cookie session cannot open a
 * chief path" true by construction rather than by review.
 */
export function requireChiefToken(req: Request, res: Response, next: NextFunction): void {
  if (!tokenAuthorizes(req.headers.authorization, CHIEF_TOKEN)) {
    sendChiefUnauthorized(res);
    return;
  }
  next();
}

// ── The system principal ─────────────────────────────────────────────────────

/**
 * Commanded jobs are owned by a non-human principal. Not by Michael, not by
 * whichever human happened to be signed in, and not by NULL — a NULL owner is
 * the legacy-job shape and `canReadJob` treats it as readable by everyone.
 *
 * It is a real `users` row, deliberately, so the admin Activity view keeps
 * labelling every job with a creator through its existing LEFT JOIN rather than
 * showing a blank. The email is in a `.internal` TLD that cannot resolve and can
 * never be a Google account: `isAllowedEmail` (auth.ts) admits `@mobupps.com`
 * only, so no OAuth flow can ever produce or claim this identity.
 */
export const CHIEF_PRINCIPAL_ID = 'usr_chief';
export const CHIEF_PRINCIPAL_EMAIL = 'chief@orchestrator.internal';
export const CHIEF_PRINCIPAL_NAME = 'Chief (orchestrator)';

/** Is this the machine principal? The one owner test used everywhere. */
export function isChiefPrincipal(userId: string | null | undefined): boolean {
  return userId === CHIEF_PRINCIPAL_ID;
}

/**
 * Is this a commanded job? Used by notifier.ts to refuse to email about one,
 * and by the chief routes to keep human jobs invisible to the token.
 */
export function isChiefJob(job: Pick<JobRow, 'created_by_user_id'>): boolean {
  return isChiefPrincipal(job.created_by_user_id);
}

// ── The system principal ─────────────────────────────────────────────────────

/**
 * The principal row commanded jobs are owned by. Called from initDb().
 *
 * The `chief_jobs` table itself is no longer created here — migrations.ts owns
 * every table in this app since order L-3.4g. What is left is the one ROW that
 * has to exist before a commanded job can reference it, and it is written on
 * every boot because it is cheap and because a database restored from anywhere
 * else must not leave the Chief unable to command anything.
 *
 * ON CONFLICT DO NOTHING with no conflict target, not `ON CONFLICT (id)`:
 * users.email is UNIQUE too, and a boot must never die on a row that already
 * exists under EITHER constraint.
 */
export async function ensureChiefPrincipal(): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO users (id, email, name, default_recipient, created_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(CHIEF_PRINCIPAL_ID, CHIEF_PRINCIPAL_EMAIL, CHIEF_PRINCIPAL_NAME, Date.now());
}

// ── What a commanded job may ask for ─────────────────────────────────────────

/**
 * Sources the Chief may command. `store_first` is deliberately absent: it is
 * this app's shared-corpus store crawl, whose deliverable is the Publishers
 * table rather than per-job `job_results` rows, so it has nothing to return
 * through `/leads`.
 */
/**
 * The wire vocabulary is the USER-FACING one, and it is not restated here — it
 * is `sourceMatrix.ts`, the table the human path reads too. See that file for
 * why a machine caller names `google_ads` + `mobile` rather than `store_first`.
 */
export const CHIEF_SOURCES = UI_SOURCES;
export type ChiefSource = UiSource;

export const CHIEF_TARGET_TYPES = TARGET_TYPES;
export type ChiefTargetType = ProductType;

/**
 * The lead caps the human form offers (csv.ts LEAD_LIMIT_CHOICES). "As many as
 * found" exists for a human watching a run; it does not exist for a commanded
 * one, because an uncapped job hands the Chief an unbounded result set to page
 * through and an unbounded run to wait for.
 */
export const CHIEF_LEAD_COUNTS = [20, 50, 100] as const;


/**
 * The countries this app supports, upper-case ISO-3166 alpha-2.
 *
 * MIRRORED from `artifacts/dashboard/src/countries.ts`, which is the catalog the
 * human New Job form offers, because the dashboard is a separate workspace
 * package and this repo mirrors shared constants rather than importing across
 * the boundary (same pattern as LEAD_LIMIT_CHOICES). The mirror is not a
 * comment asking to be kept in sync: scripts/check-country-mirror.mjs fails the
 * test gate when the two lists diverge by so much as one code.
 *
 * The human POST /api/jobs only shape-checks that a code is two letters, so it
 * accepts "XX" and runs a job that can never find anything. A machine caller
 * gets a refusal instead — that is what "supported" means here.
 */
export const SUPPORTED_COUNTRIES: readonly string[] = [
  'US', 'CA', 'MX', 'GT', 'BZ', 'HN', 'SV', 'NI', 'CR', 'PA', 'DO', 'HT',
  'JM', 'TT', 'BS', 'BB', 'AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'GY', 'PY',
  'PE', 'SR', 'UY', 'VE', 'GB', 'IE', 'FR', 'DE', 'AT', 'CH', 'BE', 'NL',
  'LU', 'ES', 'PT', 'IT', 'MT', 'GR', 'CY', 'DK', 'SE', 'NO', 'FI', 'IS',
  'EE', 'LV', 'LT', 'PL', 'CZ', 'SK', 'HU', 'SI', 'HR', 'BA', 'RS', 'ME',
  'MK', 'AL', 'RO', 'BG', 'MD', 'UA', 'BY', 'RU', 'IL', 'TR', 'SA', 'AE',
  'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'IQ', 'EG', 'YE', 'ZA', 'NG', 'KE',
  'GH', 'TZ', 'UG', 'CI', 'SN', 'CM', 'MA', 'DZ', 'TN', 'LY', 'ET', 'ZM',
  'ZW', 'MU', 'MZ', 'AO', 'BW', 'NA', 'RW', 'CD', 'IN', 'PK', 'BD', 'LK',
  'NP', 'AF', 'MM', 'TH', 'VN', 'KH', 'LA', 'MY', 'SG', 'ID', 'PH', 'BN',
  'CN', 'HK', 'TW', 'MO', 'JP', 'KR', 'KZ', 'UZ', 'KG', 'MN', 'GE', 'AM',
  'AZ', 'AU', 'NZ', 'FJ', 'PG',
];

const SUPPORTED_COUNTRY_SET: ReadonlySet<string> = new Set(SUPPORTED_COUNTRIES);

/** Upper-cases first: "us" and "US" name the same country, "XX" names none. */
export function isSupportedCountry(code: string): boolean {
  return SUPPORTED_COUNTRY_SET.has(code.trim().toUpperCase());
}

/**
 * Ceiling on the idempotency key, in BYTES of UTF-8 — the unit it is stored and
 * compared in. Over-length is REFUSED, never truncated: truncation would map
 * two different Chief-side keys onto one job, which is the exact failure
 * idempotency exists to prevent.
 */
export const EXTERNAL_ID_MAX_BYTES = 200;

/** The complete set of fields a create body may carry. Anything else is refused. */
export const CREATE_BODY_FIELDS = [
  'source',
  'target_type',
  'countries',
  'lead_count',
  'external_id',
  'appgoblin_category',
  'appgoblin_ad_network',
] as const;

export interface ChiefCreateRequest {
  source: ChiefSource;
  target_type: ChiefTargetType;
  /**
   * The engine this pair resolves to (sourceMatrix), and what `jobs.source`
   * gets. Derived during validation rather than at insert time so exactly one
   * place decides which engine a command means. Never on the wire in either
   * direction — `source` above is the caller's vocabulary.
   */
  stored_source: JobSource;
  /** Upper-cased, de-duplicated, every code known to be supported. */
  countries: string[];
  lead_count: number;
  /** Exactly the bytes the Chief sent. Never trimmed, never case-folded. */
  external_id: string;
  appgoblin_category: string | null;
  appgoblin_ad_network: string | null;
}

export type ValidationResult =
  | { ok: true; value: ChiefCreateRequest }
  | { ok: false; error: string };

const bad = (error: string): ValidationResult => ({ ok: false, error });

/**
 * Caller input echoed back inside an error message, bounded.
 *
 * A refusal that names the offending value is far easier to act on than one
 * that does not — but the value came from the network, and reflecting an
 * unbounded string turns a 400 into an amplifier and hands whatever renders the
 * message (the Chief's console) a payload of the caller's choosing. Two
 * characters is a country code; forty is a generous field name.
 */
const echo = (v: string, max: number): string => (v.length > max ? `${v.slice(0, max)}…` : v);

/** C0 and C1 control characters — refused in the idempotency key. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * The closed body. Every refusal is a 400 with a message naming the field, and
 * the messages are the contract C-3.3b is written from, so they are stable
 * strings rather than sentences that read well today.
 */
export function validateCreateBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return bad('body must be a JSON object');
  }
  const b = body as Record<string, unknown>;

  // Closed body: an unknown field is a caller/contract mismatch, and silently
  // ignoring it is how a Chief-side bug ships as "it seemed to work".
  const allowed = new Set<string>(CREATE_BODY_FIELDS);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) return bad(`unknown field: ${echo(key, 40)}`);
  }

  // source — closed list first, so the matrix below is only ever asked about a
  // key it defines. The narrowing is what keeps the shared truth from being able
  // to widen this vocabulary: resolveStoredSource does not accept a bare string.
  if (typeof b.source !== 'string') return bad('source is required');
  if (!isUiSource(b.source)) {
    return bad(`source must be one of ${CHIEF_SOURCES.join(', ')}`);
  }
  const source = b.source;

  // target_type — same shape, same reason.
  if (typeof b.target_type !== 'string') return bad('target_type is required');
  if (!isTargetType(b.target_type)) {
    return bad(`target_type must be one of ${CHIEF_TARGET_TYPES.join(', ')}`);
  }
  const targetType = b.target_type;

  // Which engine is this pair? Absent means this app genuinely cannot run it —
  // NOT that the name is unknown, which the two checks above already settled.
  const storedSource = resolveStoredSource(source, targetType);
  if (storedSource === null) return bad(unsupportedPairMessage(source));

  // countries
  if (!Array.isArray(b.countries) || b.countries.length === 0) {
    return bad('countries must be a non-empty array');
  }
  const countries: string[] = [];
  for (const raw of b.countries) {
    if (typeof raw !== 'string') return bad('countries must contain only strings');
    const code = raw.trim().toUpperCase();
    if (!SUPPORTED_COUNTRY_SET.has(code)) return bad(`unsupported country: ${echo(raw, 8)}`);
    // Refused rather than de-duplicated: a duplicate doubles the work of a run
    // that can take hours, and quietly fixing a caller's bug hides it.
    if (countries.includes(code)) return bad(`duplicate country: ${code}`);
    countries.push(code);
  }

  // lead_count
  if (typeof b.lead_count !== 'number' || !Number.isInteger(b.lead_count)) {
    return bad(`lead_count must be one of ${CHIEF_LEAD_COUNTS.join(', ')}`);
  }
  if (!(CHIEF_LEAD_COUNTS as readonly number[]).includes(b.lead_count)) {
    return bad(`lead_count must be one of ${CHIEF_LEAD_COUNTS.join(', ')}`);
  }
  const leadCount = b.lead_count;

  // external_id — the idempotency key
  if (typeof b.external_id !== 'string') return bad('external_id is required');
  if (b.external_id.length === 0) return bad('external_id must not be empty');
  if (CONTROL_CHARS.test(b.external_id)) {
    return bad('external_id must not contain control characters');
  }
  if (Buffer.byteLength(b.external_id, 'utf8') > EXTERNAL_ID_MAX_BYTES) {
    return bad(`external_id must be at most ${EXTERNAL_ID_MAX_BYTES} bytes`);
  }
  const externalId = b.external_id;

  // AppGoblin discovery axis. NOT an optional extra: appgoblinPipeline.ts:116
  // throws `job missing source_params (category or adNetworkDomain required)`
  // the moment it starts without one, so a commanded AppGoblin job with no axis
  // is a job that is guaranteed to fail. Same two validators the human form
  // uses (routes-jobs.ts:292-297), so the two paths cannot drift.
  let appgoblinCategory: string | null = null;
  let appgoblinAdNetwork: string | null = null;
  if (b.appgoblin_category != null) {
    if (typeof b.appgoblin_category !== 'string') return bad('appgoblin_category must be a string');
    const cat = b.appgoblin_category.trim();
    if (cat && !/^[a-z0-9_]+$/.test(cat)) {
      return bad('appgoblin_category must be lowercase letters/digits/underscores');
    }
    appgoblinCategory = cat || null;
  }
  if (b.appgoblin_ad_network != null) {
    if (typeof b.appgoblin_ad_network !== 'string') {
      return bad('appgoblin_ad_network must be a string');
    }
    const adn = b.appgoblin_ad_network.trim().toLowerCase();
    if (adn && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(adn)) {
      return bad('appgoblin_ad_network must be a domain like "appsflyer.com"');
    }
    appgoblinAdNetwork = adn || null;
  }
  if (source === 'appgoblin' && !appgoblinCategory && !appgoblinAdNetwork) {
    return bad('appgoblin jobs require appgoblin_category and/or appgoblin_ad_network');
  }
  if (source !== 'appgoblin' && (appgoblinCategory || appgoblinAdNetwork)) {
    return bad('appgoblin_category and appgoblin_ad_network apply to source appgoblin only');
  }

  return {
    ok: true,
    value: {
      source,
      target_type: targetType,
      stored_source: storedSource,
      countries,
      lead_count: leadCount,
      external_id: externalId,
      appgoblin_category: appgoblinCategory,
      appgoblin_ad_network: appgoblinAdNetwork,
    },
  };
}

/**
 * The `source_params` blob for a commanded job, built to be BYTE-IDENTICAL to
 * what routes-jobs.ts writes for the same request from a human, so the engine
 * cannot tell the two apart. Anything else would make "commanded jobs run with
 * this app's normal engine" a claim rather than a fact.
 */
export function commandedSourceParams(v: ChiefCreateRequest): Record<string, unknown> {
  // Dispatch on the ENGINE, not the caller's word for it: `google_ads` means two
  // different pipelines depending on target_type, and they read different keys.
  if (v.stored_source === 'appgoblin') {
    return {
      category: v.appgoblin_category,
      adNetworkDomain: v.appgoblin_ad_network,
      maxLeads: v.lead_count,
    };
  }
  if (v.stored_source === 'google_ads') {
    // The five keys the human path always writes, all null = "run the default
    // multilingual keyword sample across all verticals".
    return {
      verticals: null,
      languages: null,
      maxKeywords: null,
      customKeywords: null,
      region: null,
      maxLeads: v.lead_count,
    };
  }
  if (v.stored_source === 'store_first') {
    // The five keys routes-jobs.ts writes for a human store-first job, plus the
    // cap. `markets` is the one that MUST be filled: this pipeline does not read
    // `jobs.countries` at all — resolveStoreParams takes its markets from here
    // and falls back to DEFAULT_ACTIVE_MARKETS (12) when the list is absent, so
    // a commanded Brazil job would quietly have run the default twelve markets
    // and reported success. The human form fills it the same way, from the same
    // country picker (NewJobForm.tsx: `markets: countries.map(lowercase)`), and
    // every code here has already been checked against SUPPORTED_COUNTRIES —
    // which is ALL_MARKETS, code for code.
    //
    // `verticals` stays null on purpose: the closed body has no vertical field,
    // and null is how the human path says "run the default set" rather than a
    // guess this surface would be inventing.
    return {
      verticals: null,
      markets: v.countries.map((c) => c.toLowerCase()),
      similarMaxAppsPerRun: null,
      searchTermsLimit: null,
      confirmationMaxApiCalls: null,
      maxLeads: v.lead_count,
    };
  }
  return { maxLeads: v.lead_count };
}

// ── Creating and finding commanded jobs ──────────────────────────────────────

interface ChiefJobRow {
  external_id: string;
  job_id: string;
  created_at: number;
}

/** The job this external_id already names, or null. Exact bytes, no normalising. */
export async function jobIdForExternalId(externalId: string): Promise<string | null>{
  const row = await getDb()
    .prepare(`SELECT job_id FROM chief_jobs WHERE external_id = ?`)
    .get(externalId) as Pick<ChiefJobRow, 'job_id'> | undefined;
  return row?.job_id ?? null;
}

/** The idempotency key a commanded job was created under, or null for a human job. */
export async function externalIdForJob(jobId: string): Promise<string | null>{
  const row = await getDb()
    .prepare(`SELECT external_id FROM chief_jobs WHERE job_id = ?`)
    .get(jobId) as Pick<ChiefJobRow, 'external_id'> | undefined;
  return row?.external_id ?? null;
}

/**
 * Create the commanded job, or return the one this external_id already names.
 *
 * Idempotency is enforced by the PRIMARY KEY, not by the read below: two
 * simultaneous identical commands both find nothing, both insert, and exactly
 * one wins. The loser catches the constraint and returns the winner's job —
 * which is why the mapping row is written in the SAME transaction as the job.
 */
export async function createCommandedJob(v: ChiefCreateRequest): Promise<{ job: JobRow; created: boolean; }>{
  const existingId = await jobIdForExternalId(v.external_id);
  if (existingId) {
    const existing = await getJob(existingId);
    if (existing) return { job: existing, created: false };
    // The mapping outlived its job (nothing in this app deletes jobs, so this
    // is a torn-state guard rather than a path anyone takes). Drop the orphan
    // and create afresh rather than answering 404 forever.
    await getDb().prepare(`DELETE FROM chief_jobs WHERE external_id = ?`).run(v.external_id);
  }

  try {
    // Both writes go through `t`, the transaction's OWN handle. That is not a
    // stylistic detail: a statement issued through getDb() inside this callback
    // would run on a different pooled connection and therefore OUTSIDE the
    // transaction, which is exactly the atomicity this function's contract
    // above promises. createJob/getJob take the handle for the same reason.
    const job = await getDb().transaction(async (t) => {
      const created = await createJob(
        {
          id: `job_${nanoid(10)}`,
          productType: v.target_type as ProductType,
          countries: v.countries,
          recipientEmail: null, // a commanded job has no recipient; see notifier.ts
          createdByUserId: CHIEF_PRINCIPAL_ID,
          source: v.stored_source,
          sourceParams: commandedSourceParams(v),
        },
        t,
      );
      await t
        .prepare(`INSERT INTO chief_jobs (external_id, job_id, created_at) VALUES (?, ?, ?)`)
        .run(v.external_id, created.id, Date.now());
      return created;
    });
    return { job, created: true };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const winnerId = await jobIdForExternalId(v.external_id);
    const winner = winnerId ? await getJob(winnerId) : null;
    if (!winner) throw err; // genuinely broken, not a race — do not invent a job
    return { job: winner, created: false };
  }
}

/**
 * Did this fail because the idempotency key was already taken?
 *
 * PostgreSQL reports it as SQLSTATE 23505 (unique_violation) — one code for
 * both a PRIMARY KEY and a UNIQUE collision, where SQLite had two. The two
 * SQLITE_* codes are gone rather than kept "just in case": no code path in this
 * app can produce them any more, and a stale alternative in a predicate like
 * this one is how a real constraint error gets mistaken for a lost race.
 */
function isUniqueConstraintError(err: unknown): boolean {
  return ((err as { code?: string } | null)?.code ?? '') === '23505';
}

/**
 * The job behind a chief-facing id, or null when the token may not see it.
 *
 * A job owned by a human is answered EXACTLY as a job that does not exist —
 * same 404, same body — so the token cannot be used to probe whether a given id
 * belongs to somebody.
 */
export async function getChiefJob(jobId: string): Promise<JobRow | null>{
  const job = await getJob(jobId);
  if (!job) return null;
  if (!isChiefJob(job)) return null;
  return job;
}

// ── The wire shapes ──────────────────────────────────────────────────────────

/** Epoch ms → ISO-8601 UTC, or null. The Chief is a separate service; ISO is unambiguous. */
export function isoOrNull(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** The states a job never leaves. `final: true` is what tells the Chief to stop polling. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalState(status: string): boolean {
  return TERMINAL_STATES.has(status);
}

export interface ChiefJobDto {
  job_id: string;
  external_id: string | null;
  source: string;
  target_type: string;
  countries: string[];
  lead_count: number | null;
  state: string;
  phase: string | null;
  step: string | null;
  progress_pct: number;
  leads_found: number;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  /**
   * When a deferred job becomes runnable again — the next Asia/Jerusalem
   * midnight, set when a job hits this app's daily LLM cap mid-run. Null for
   * every job that has never been deferred. Without it a `deferred` state is a
   * job the Chief would poll blindly for up to a day.
   */
  run_after: string | null;
  final: boolean;
}

/** The lead cap a job was created with, read back off its own source_params. */
export function jobLeadCount(job: JobRow): number | null {
  if (!job.source_params) return null;
  try {
    const p = JSON.parse(job.source_params) as Record<string, unknown>;
    const n = p.maxLeads;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function parseCountries(raw: string): string[] {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * A job as the Chief sees it. `state` is this repo's own `jobs.status`
 * vocabulary and `phase`/`step` are exactly what the human UI renders as the
 * live progress line — no translation layer, so the two views cannot disagree.
 */
export function jobToChiefDto(job: JobRow, externalId: string | null): ChiefJobDto {
  return {
    job_id: job.id,
    external_id: externalId,
    // The caller's vocabulary, not the storage id: a job commanded as
    // `google_ads` + `mobile` is stored as `store_first` and must read back as
    // `google_ads`, or the Chief cannot recognise its own command. This is the
    // same translation App.tsx does when it renders that id as
    // "GOOGLE ADS - MOBILE" for a human.
    source: uiSourceForStored(job.source),
    target_type: job.product_type,
    countries: parseCountries(job.countries),
    lead_count: jobLeadCount(job),
    state: job.status,
    phase: job.phase,
    step: job.phase_detail,
    progress_pct: job.progress_pct,
    leads_found: job.leads_found,
    // Pipeline failure text, the same string the human UI shows. Bounded
    // because it is caller-visible and its length is not otherwise constrained.
    error: job.error == null ? null : job.error.slice(0, 500),
    created_at: isoOrNull(job.created_at),
    started_at: isoOrNull(job.started_at),
    completed_at: isoOrNull(job.completed_at),
    run_after: isoOrNull(job.run_after),
    final: isTerminalState(job.status),
  };
}

export interface ChiefLeadDto {
  lead_id: number;
  advertiser_name: string;
  country: string;
  classification: string | null;
  store_url: string | null;
  landing_url: string | null;
  page_url: string | null;
  app_category: string | null;
  is_game: boolean | null;
  found_at: string | null;
}

/**
 * One lead, derived from the `job_results` row this app actually stores.
 *
 * `ad_text` is the one stored column deliberately left out: it is ad creative
 * copy of unbounded length, and 100 of them would blow past the Chief's 64 KB
 * response ceiling on their own. It is still in the CSV and the .xlsx bundle.
 */
export function leadToChiefDto(r: JobResultRow): ChiefLeadDto {
  return {
    lead_id: r.id,
    advertiser_name: r.advertiser_name,
    country: r.country,
    classification: r.classification,
    store_url: r.store_url,
    landing_url: r.landing_url,
    page_url: r.page_url,
    app_category: r.app_category,
    is_game: r.is_game == null ? null : r.is_game === 1,
    found_at: isoOrNull(r.created_at),
  };
}

// ── Pagination ───────────────────────────────────────────────────────────────

export const LEADS_LIMIT_DEFAULT = 50;
export const LEADS_LIMIT_MAX = 100;
/**
 * Byte budget for one page's `leads` array. The Chief's ceiling is 64 KB for
 * the whole response; 48 KB for the array leaves the envelope and headers a
 * wide margin. The cap on `limit` alone cannot hold the ceiling — a landing URL
 * carrying a tracking payload is not length-bounded anywhere in this app — so
 * the page stops early when the budget binds and says so with `next_offset`.
 */
export const LEADS_PAGE_MAX_BYTES = 48 * 1024;

export type PaginationResult =
  | { ok: true; offset: number; limit: number }
  | { ok: false; error: string };

/**
 * `?offset=&limit=`. Absent means the default. Malformed is REFUSED (a silently
 * corrected `limit=abc` is how a caller ends up paging with a limit it does not
 * think it asked for); above the maximum is CLAMPED, which is what "capped at
 * 100" means and what the response's own `limit` field then reports back.
 */
export function parsePagination(query: Record<string, unknown>): PaginationResult {
  const intParam = (raw: unknown, name: string, min: number): number | string => {
    if (raw === undefined) return NaN; // caller substitutes the default
    // Anything not a plain string is a repeated or structured query parameter
    // (`?limit=1&limit=2`, `?limit[a]=1`). Refused rather than last-wins: a
    // caller that sent two limits does not know which one it is paging with.
    if (typeof raw !== 'string') return `${name} must be a single non-negative integer`;
    if (!/^\d+$/.test(raw)) return `${name} must be a non-negative integer`;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return `${name} must be a non-negative integer`;
    if (n < min) return `${name} must be at least ${min}`;
    return n;
  };

  const off = intParam(query.offset, 'offset', 0);
  if (typeof off === 'string') return { ok: false, error: off };
  const lim = intParam(query.limit, 'limit', 1);
  if (typeof lim === 'string') return { ok: false, error: lim };

  return {
    ok: true,
    offset: Number.isNaN(off) ? 0 : off,
    limit: Math.min(Number.isNaN(lim) ? LEADS_LIMIT_DEFAULT : lim, LEADS_LIMIT_MAX),
  };
}

export interface LeadsPage {
  leads: ChiefLeadDto[];
  next_offset: number;
  has_more: boolean;
  bytes: number;
}

/**
 * One page out of an already-ordered lead list.
 *
 * Stops at `limit` leads or at the byte budget, whichever binds first. A single
 * lead larger than the whole budget is still returned alone rather than
 * producing an empty page the caller could never advance past — the alternative
 * is a silent truncation of somebody's URL, and this app does not truncate data
 * to make a wire format comfortable.
 */
export function pageLeads(all: JobResultRow[], offset: number, limit: number): LeadsPage {
  const leads: ChiefLeadDto[] = [];
  let bytes = 0;
  for (let i = offset; i < all.length && leads.length < limit; i++) {
    const dto = leadToChiefDto(all[i]);
    const size = Buffer.byteLength(JSON.stringify(dto), 'utf8') + 1; // + the comma
    if (leads.length > 0 && bytes + size > LEADS_PAGE_MAX_BYTES) break;
    leads.push(dto);
    bytes += size;
  }
  const next = Math.min(offset, all.length) + leads.length;
  return { leads, next_offset: next, has_more: next < all.length, bytes };
}

// ── Status ───────────────────────────────────────────────────────────────────

export interface ChiefStatus {
  app: 'leadfinder';
  ok: true;
  accepting_jobs: boolean;
  active_jobs: number;
  /**
   * This app's own spend figure, on this app's own day. UNCHANGED by L-3.5a and
   * deliberately so: it is the number the $100 cap is enforced against, and a
   * card showing a figure the cap does not use would be worse than no card.
   */
  spend_today_usd: number;
  /**
   * The window `spend_today_usd` is measured in. Named because the UTC figure
   * beside it is measured in a different one, and for three hours a day
   * (21:00–24:00 UTC in summer) the two legitimately disagree.
   */
  spend_today_window: 'Asia/Jerusalem';
  /** UTC-day spend — the same scope and boundary reported to the Chief. */
  spend_today_utc_usd: number;
  spend_today_utc_window: 'UTC';
  /** This UTC day's USD not yet acknowledged by the Chief: the cursor's lag. */
  spend_unreported_usd: number;
  spend_reported_quanta: number;
  /** dormant | active | latched — so a silent reporter is visible, not assumed. */
  spend_reporter: 'dormant' | 'active' | 'latched';
  server_time: string;
}

/**
 * Jobs actually executing right now, across every owner — human and commanded
 * alike. The Chief is asking about this app's load, and a run started from the
 * browser consumes exactly the same worker slot as a commanded one.
 */
export async function activeJobCount(): Promise<number>{
  const row = await getDb()
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`)
    .get() as { n: number };
  return row.n;
}

/**
 * Today's LLM spend in USD, straight off this app's own ledger.
 *
 * NOT the constant 0 the order predicted. This app DOES have a paid vendor: the
 * Anthropic API, called by classifier.ts, hqResolver.ts and webResolver.ts, with
 * every call's exact cost written to the `llm_spend` table by
 * llmBudget.recordSpend() and a $100/day cap enforced against the same sum. On a
 * day with no LLM calls this returns 0 — but it returns it because the ledger
 * says so, not because a literal was hardcoded. Reporting a fabricated 0 on a
 * day this app spent money is exactly what "never a fabricated value" forbids.
 *
 * Deliberately does NOT use llmBudget.spentTodayUsd(): that helper swallows a
 * failed read and returns 0, which is the right answer for a budget gate (fail
 * open, never block a job on a query error) and the wrong one here, where a
 * failed read must surface as 503.
 */
export async function spendTodayUsd(jerusalemDay: string): Promise<number>{
  const row = await getDb()
    .prepare(`SELECT COALESCE(SUM(usd), 0) AS total FROM llm_spend WHERE spend_day = ?`)
    .get(jerusalemDay) as { total: number };
  return row.total || 0;
}

/**
 * Would a new commanded job be accepted right now?
 *
 * This app's queue cannot refuse a creation. `createJob` inserts a `pending`
 * row and `dispatchRunnable` (queue.ts) only decides WHEN it starts — the global
 * concurrency ceiling, the per-user serialisation and the LLM daily cap all
 * delay a start, none of them rejects a create. So the honest answer is "yes,
 * whenever this app can reach its own database", and the read below is what
 * establishes that rather than a hardcoded `true`. POST /api/chief/jobs calls
 * this same function and 503s when it is false, so the flag can never be a
 * promise the create path does not keep.
 *
 * Consequence worth knowing on the Chief side, and reported with the contract:
 * because every commanded job is owned by ONE principal, the per-user rule runs
 * them one at a time. Accepted is not started.
 */
export async function acceptingJobs(): Promise<boolean>{
  await getDb().prepare(`SELECT 1 FROM jobs LIMIT 1`).get();
  return true;
}

// ── offline tests (pure — no DB, no network, no socket) ──────────────────────

export function runChiefTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // ── the token ──
  const SECRET = 'sk-chief-abcdefghijklmnop';
  check(tokenAuthorizes(`Bearer ${SECRET}`, SECRET), 'token: the exact header authorizes');
  check(!tokenAuthorizes(`Bearer ${SECRET}`, ''), 'token: an unset secret authorizes nothing');
  check(!tokenAuthorizes(undefined, SECRET), 'token: a missing header does not authorize');
  check(!tokenAuthorizes(null, SECRET), 'token: a null header does not authorize');
  check(!tokenAuthorizes(['Bearer x'] as unknown, SECRET), 'token: a non-string header does not authorize');
  check(!tokenAuthorizes('', SECRET), 'token: an empty header does not authorize');
  check(!tokenAuthorizes(SECRET, SECRET), 'token: the bare secret with no scheme does not authorize');
  check(!tokenAuthorizes(`bearer ${SECRET}`, SECRET), 'token: the scheme is case-sensitive (bearer)');
  check(!tokenAuthorizes(`BEARER ${SECRET}`, SECRET), 'token: the scheme is case-sensitive (BEARER)');
  check(!tokenAuthorizes(`Bearer  ${SECRET}`, SECRET), 'token: a doubled space is not the credential');
  check(!tokenAuthorizes(`Bearer ${SECRET} `, SECRET), 'token: a trailing space is not trimmed away');
  check(!tokenAuthorizes(`Bearer  ${SECRET} `, SECRET), 'token: leading+trailing whitespace is not trimmed');
  check(!tokenAuthorizes('Bearer ', SECRET), 'token: an empty credential does not authorize');
  check(!tokenAuthorizes(`Bearer ${SECRET.toUpperCase()}`, SECRET), 'token: the credential is case-sensitive');
  check(!tokenAuthorizes(`Bearer ${SECRET}x`, SECRET), 'token: a longer credential does not authorize');
  check(!tokenAuthorizes(`Bearer ${SECRET.slice(0, -1)}`, SECRET), 'token: a shorter credential does not authorize');
  check(!tokenAuthorizes(`Basic ${SECRET}`, SECRET), 'token: another scheme does not authorize');
  check(!tokenAuthorizes(`Bearer\t${SECRET}`, SECRET), 'token: a tab is not the scheme separator');
  // Multi-byte credentials must still compare byte-exact, and must not throw.
  check(tokenAuthorizes('Bearer é☃', 'é☃'), 'token: a multi-byte credential compares equal to itself');
  check(!tokenAuthorizes('Bearer é', 'e'), 'token: a multi-byte credential is not its ASCII lookalike');

  // ── the principal ──
  check(isChiefPrincipal(CHIEF_PRINCIPAL_ID), 'principal: the id is the principal');
  check(!isChiefPrincipal('usr_abc'), 'principal: a human id is not the principal');
  check(!isChiefPrincipal(null), 'principal: a legacy NULL owner is NOT the principal');
  check(!isChiefPrincipal(undefined), 'principal: undefined is not the principal');
  check(!isChiefPrincipal(''), 'principal: empty is not the principal');
  check(!isChiefPrincipal('USR_CHIEF'), 'principal: the id compare is case-sensitive');
  check(isChiefJob({ created_by_user_id: CHIEF_PRINCIPAL_ID }), 'principal: a commanded job is a chief job');
  check(!isChiefJob({ created_by_user_id: 'usr_human' }), 'principal: a human job is not a chief job');
  check(!isChiefJob({ created_by_user_id: null }), 'principal: a legacy job is not a chief job');
  check(
    !/@mobupps\.com$/i.test(CHIEF_PRINCIPAL_EMAIL),
    'principal: the identity is outside the OAuth-allowed domain, so no human can ever claim it',
  );

  // ── the country catalog ──
  check(SUPPORTED_COUNTRIES.length === 137, `countries: the catalog has 137 codes (got ${SUPPORTED_COUNTRIES.length})`);
  check(new Set(SUPPORTED_COUNTRIES).size === SUPPORTED_COUNTRIES.length, 'countries: no duplicates in the catalog');
  check(SUPPORTED_COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c)), 'countries: every code is upper-case alpha-2');
  check(isSupportedCountry('US') && isSupportedCountry('us'), 'countries: case-insensitive lookup');
  check(!isSupportedCountry('XX'), 'countries: an unassigned code is unsupported');
  check(!isSupportedCountry('KP'), 'countries: an excluded country is unsupported');
  check(!isSupportedCountry('USA'), 'countries: alpha-3 is unsupported');
  // The invariant that makes google_ads + mobile safe to command: every country
  // this surface accepts is a market the store-first pipeline recognises. If the
  // two ever diverge, a commanded job would be accepted for a market the engine
  // then drops on the floor.
  check(
    SUPPORTED_COUNTRIES.every((c) => (ALL_MARKETS as readonly string[]).includes(c.toLowerCase())),
    'countries: every supported country is a store market the engine knows',
  );

  // ── the closed body ──
  const base = {
    source: 'meta',
    target_type: 'mobile',
    countries: ['US'],
    lead_count: 50,
    external_id: 'chief-1',
  };
  const ok = (over: Record<string, unknown> = {}) => validateCreateBody({ ...base, ...over });
  const errOf = (r: ValidationResult) => (r.ok ? '' : r.error);

  check(ok().ok, 'body: the minimal valid command is accepted');
  check(!validateCreateBody(null).ok, 'body: null is refused');
  check(!validateCreateBody([]).ok, 'body: an array is refused');
  check(!validateCreateBody('{}').ok, 'body: a string is refused');
  check(!validateCreateBody({}).ok, 'body: an empty object is refused');
  check(errOf(ok({ nope: 1 })) === 'unknown field: nope', 'body: an unknown field is refused by name');
  check(errOf(ok({ maxLeads: 100 })) === 'unknown field: maxLeads', 'body: the human field name is refused too');
  check(errOf(ok({ recipientEmail: 'x@y.z' })) === 'unknown field: recipientEmail', 'body: no recipient can be smuggled in');
  check(errOf(ok({ createdByUserId: 'usr_abc' })) === 'unknown field: createdByUserId', 'body: identity cannot come from the body');

  check(!ok({ source: 'store_first' }).ok, 'body: store_first is not commandable');
  check(!ok({ source: 'META' }).ok, 'body: the source is case-sensitive');
  check(!ok({ source: 1 }).ok, 'body: a non-string source is refused');
  check(!ok({ source: undefined }).ok, 'body: a missing source is refused');
  check(!ok({ target_type: 'web' }).ok, 'body: an unknown target_type is refused');
  // ── the source × target matrix (order L-3.3c) ──
  //
  // The defect this replaced: L-3.3a mirrored the STORED source vocabulary and
  // published it as the wire vocabulary, so `google_ads` + `mobile` — the pair a
  // human picks every day, which the form maps to the `store_first` engine — was
  // refused as a combination this app cannot run.
  //
  // Every pair is enumerated below against a literal expectation. The literal is
  // a change-detector, not a second table: editing sourceMatrix.ts without
  // meaning to will fail here rather than silently redefine what the Chief may
  // command.
  const EXPECTED_MATRIX: Array<[string, string, string | null]> = [
    ['google_ads', 'mobile', 'store_first'], // ← the request that started L-3.3c
    ['google_ads', 'cps', 'google_ads'],
    ['meta', 'mobile', 'meta'],
    ['meta', 'cps', 'meta'],
    ['affplus', 'mobile', 'affplus'],
    ['affplus', 'cps', 'affplus'],
    ['appgoblin', 'mobile', 'appgoblin'],
    ['appgoblin', 'cps', null], // the only pair this app genuinely cannot run
  ];
  check(
    EXPECTED_MATRIX.length === UI_SOURCES.length * TARGET_TYPES.length,
    'matrix: every source × target pair is enumerated',
  );
  for (const [src, tgt, stored] of EXPECTED_MATRIX) {
    const extra = src === 'appgoblin' ? { appgoblin_category: 'game_casino' } : {};
    const r = ok({ source: src, target_type: tgt, ...extra });
    check(r.ok === (stored !== null), `matrix: ${src} + ${tgt} is ${stored ? 'accepted' : 'refused'}`);
    if (r.ok) {
      check(r.value.stored_source === stored, `matrix: ${src} + ${tgt} runs the ${stored} engine`);
      // The two views agree: the engine the machine surface picked is one the
      // human route would accept this product type for. This is what makes the
      // two paths unable to disagree silently again.
      check(
        targetsForStoredSource(r.value.stored_source).includes(tgt as ProductType),
        `matrix: the human path accepts ${stored} + ${tgt} too`,
      );
    }
  }

  // The exact request the Chief's first commanded discovery was refused with.
  const theOriginalRequest = validateCreateBody({
    source: 'google_ads',
    target_type: 'mobile',
    countries: ['US'],
    lead_count: 20,
    external_id: 'chief-first-command',
  });
  check(theOriginalRequest.ok, "matrix: the Chief's original google_ads+mobile+US+20 command is accepted");
  check(
    theOriginalRequest.ok && theOriginalRequest.value.stored_source === 'store_first',
    'matrix: and it runs the store-first engine — the one the human UI calls "Google Ads - Mobile"',
  );

  // A still-invalid combination refuses, with a message that states the real
  // supported set for the source the caller named.
  check(
    errOf(ok({ source: 'appgoblin', target_type: 'cps', appgoblin_category: 'x' })) ===
      'source appgoblin supports target_type mobile only',
    'matrix: appgoblin + cps refuses, naming appgoblin’s real supported set',
  );
  check(
    errOf(ok({ source: 'google_ads', target_type: 'mobile' })) === '',
    'matrix: google_ads no longer refuses any target type',
  );
  check(
    ok({ source: 'appgoblin', target_type: 'mobile', appgoblin_category: 'game_casino' }).ok,
    'body: appgoblin + mobile + a category is accepted',
  );
  check(!ok({ source: 'appgoblin', target_type: 'cps', appgoblin_category: 'x' }).ok, 'body: appgoblin + cps is refused');
  check(
    !ok({ source: 'appgoblin', target_type: 'mobile' }).ok,
    'body: appgoblin with no discovery axis is refused, not queued to fail at run time',
  );
  check(
    !ok({ source: 'appgoblin', target_type: 'mobile', appgoblin_category: 'Game Casino' }).ok,
    'body: an appgoblin category with spaces/capitals is refused',
  );
  check(
    ok({ source: 'appgoblin', target_type: 'mobile', appgoblin_ad_network: 'AppsFlyer.com' }).ok,
    'body: an ad-network domain is accepted and lower-cased',
  );
  check(!ok({ appgoblin_category: 'x' }).ok, 'body: an appgoblin axis on a meta job is refused');
  check(ok({ source: 'affplus', target_type: 'cps' }).ok, 'body: affplus takes either target type');

  check(!ok({ countries: [] }).ok, 'body: an empty country list is refused');
  check(!ok({ countries: 'US' }).ok, 'body: a bare string country list is refused');
  check(!ok({ countries: ['US', 'XX'] }).ok, 'body: one unsupported code refuses the whole command');
  // A refusal names the offending value, but never reflects an unbounded one.
  check(
    errOf(ok({ countries: ['x'.repeat(5000)] })).length < 60,
    'body: a huge country string is not reflected back in full',
  );
  check(
    errOf(validateCreateBody({ ...base, ['y'.repeat(5000)]: 1 })).length < 80,
    'body: a huge field name is not reflected back in full',
  );
  check(!ok({ countries: ['US', 1] }).ok, 'body: a non-string country is refused');
  check(!ok({ countries: ['US', 'US'] }).ok, 'body: a duplicate country is refused, not silently merged');
  check(!ok({ countries: ['US', 'us'] }).ok, 'body: a duplicate that differs only in case is refused');
  const upper = ok({ countries: ['us', ' gb '] });
  check(upper.ok && upper.value.countries.join(',') === 'US,GB', 'body: countries are upper-cased for the engine');

  check(!ok({ lead_count: 25 }).ok, 'body: an off-menu lead_count is refused');
  check(!ok({ lead_count: 0 }).ok, 'body: 0 leads is refused');
  check(!ok({ lead_count: null }).ok, 'body: unlimited does not exist for a commanded job');
  check(!ok({ lead_count: undefined }).ok, 'body: lead_count is required');
  check(!ok({ lead_count: '50' }).ok, 'body: a numeric string lead_count is refused');
  check(!ok({ lead_count: 50.5 }).ok, 'body: a fractional lead_count is refused');
  check(ok({ lead_count: 20 }).ok && ok({ lead_count: 100 }).ok, 'body: 20 and 100 are accepted');

  check(!ok({ external_id: '' }).ok, 'body: an empty external_id is refused');
  check(!ok({ external_id: undefined }).ok, 'body: external_id is required');
  check(!ok({ external_id: 123 }).ok, 'body: a numeric external_id is refused');
  check(!ok({ external_id: 'a\nb' }).ok, 'body: a newline in external_id is refused');
  check(!ok({ external_id: 'a\x00b' }).ok, 'body: a NUL in external_id is refused');
  check(ok({ external_id: 'x'.repeat(EXTERNAL_ID_MAX_BYTES) }).ok, 'body: the length cap is inclusive');
  check(!ok({ external_id: 'x'.repeat(EXTERNAL_ID_MAX_BYTES + 1) }).ok, 'body: over-length is refused, never truncated');
  check(
    !ok({ external_id: 'é'.repeat(EXTERNAL_ID_MAX_BYTES) }).ok,
    'body: the cap is BYTES — a 200-char multi-byte key is 400 bytes and is refused',
  );
  const kept = ok({ external_id: '  Mixed Case Key  ' });
  check(
    kept.ok && kept.value.external_id === '  Mixed Case Key  ',
    'body: external_id is stored byte for byte — not trimmed, not case-folded',
  );

  // ── source_params: identical to what a human create writes ──
  // Records a FAILURE rather than casting, so a validator regression is loud
  // instead of type-asserting its way past the assertions below.
  //
  // It deliberately does NOT throw: `check` only collects, so an exception
  // escaping runChiefTests discards every failure already found and the suite
  // reports "0 failed" for a module that is broken. A matrix regression makes
  // exactly these calls fail, which is how that was noticed.
  const valid = (over: Record<string, unknown> = {}): ChiefCreateRequest | null => {
    const r = ok(over);
    if (!r.ok) {
      failures.push(`FAIL: params: expected ${JSON.stringify(over)} to be valid, got: ${r.error}`);
      return null;
    }
    return r.value;
  };
  /** Params for a command, or `{}` when the command did not validate (already
   *  recorded as a failure above — this keeps the comparison below meaningful
   *  rather than throwing on null). */
  const paramsOf = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const v = valid(over);
    return v ? commandedSourceParams(v) : {};
  };
  check(JSON.stringify(paramsOf()) === '{"maxLeads":50}', 'params: meta carries only the lead cap');
  check(
    JSON.stringify(paramsOf({ source: 'google_ads', target_type: 'cps' })) ===
      '{"verticals":null,"languages":null,"maxKeywords":null,"customKeywords":null,"region":null,"maxLeads":50}',
    'params: google_ads writes the same five null keys the human path writes',
  );
  check(
    JSON.stringify(paramsOf({ source: 'appgoblin', target_type: 'mobile', appgoblin_ad_network: 'AppsFlyer.com' })) ===
      '{"category":null,"adNetworkDomain":"appsflyer.com","maxLeads":50}',
    'params: appgoblin writes the axis the pipeline reads, lower-cased',
  );
  // store_first, reached by commanding google_ads + mobile. `markets` is the
  // load-bearing key: the pipeline does NOT read jobs.countries, so an absent
  // list would silently run DEFAULT_ACTIVE_MARKETS instead of what was asked for.
  const sfParams = paramsOf({ source: 'google_ads', target_type: 'mobile', countries: ['BR', 'de'] });
  check(
    JSON.stringify(sfParams) ===
      '{"verticals":null,"markets":["br","de"],"similarMaxAppsPerRun":null,' +
        '"searchTermsLimit":null,"confirmationMaxApiCalls":null,"maxLeads":50}',
    'params: store_first writes the five keys the human path writes, markets from the commanded countries',
  );
  check(
    Array.isArray(sfParams.markets) &&
      (sfParams.markets as string[]).every((m) => (ALL_MARKETS as readonly string[]).includes(m)),
    'params: every market written is one the store pipeline recognises',
  );

  // ── pagination ──
  const pg = (q: Record<string, unknown>) => parsePagination(q);
  const defaults = pg({});
  check(defaults.ok && defaults.offset === 0 && defaults.limit === 50, 'page: defaults are offset 0, limit 50');
  const capped = pg({ limit: '1000' });
  check(capped.ok && capped.limit === LEADS_LIMIT_MAX, 'page: limit is capped at 100, not refused');
  check(!pg({ limit: 'abc' }).ok, 'page: a non-numeric limit is refused, not silently defaulted');
  check(!pg({ limit: '-1' }).ok, 'page: a negative limit is refused');
  check(!pg({ limit: '0' }).ok, 'page: limit 0 is refused (an empty page reads as "no leads")');
  check(!pg({ offset: '-1' }).ok, 'page: a negative offset is refused');
  check(!pg({ offset: '1.5' }).ok, 'page: a fractional offset is refused');
  check(!pg({ offset: ['1', '2'] }).ok, 'page: a repeated offset param is refused, not last-wins');
  check(pg({ offset: '0' }).ok, 'page: offset 0 is valid');
  const big = pg({ offset: String(Number.MAX_SAFE_INTEGER) + '0' });
  check(!big.ok, 'page: an unsafe-integer offset is refused');

  // ── the page builder ──
  const mkResult = (id: number, over: Partial<JobResultRow> = {}): JobResultRow => ({
    id,
    job_id: 'job_x',
    advertiser_name: `Advertiser ${id}`,
    page_url: null,
    landing_url: 'https://example.com/landing',
    classification: 'cps_web',
    store_url: null,
    ad_text: 'x'.repeat(5000), // never serialized — proves ad_text cannot bloat a page
    country: 'US',
    created_at: 1_700_000_000_000,
    app_category: null,
    is_game: null,
    ...over,
  });
  const rows = Array.from({ length: 250 }, (_, i) => mkResult(i + 1));
  const p1 = pageLeads(rows, 0, 50);
  check(p1.leads.length === 50 && p1.leads[0].lead_id === 1, 'page: the first page starts at the first row');
  check(p1.next_offset === 50 && p1.has_more, 'page: next_offset and has_more track the walk');
  const p2 = pageLeads(rows, 50, 50);
  check(p2.leads[0].lead_id === 51, 'page: the second page continues where the first stopped');
  const last = pageLeads(rows, 200, 100);
  check(last.leads.length === 50 && !last.has_more && last.next_offset === 250, 'page: the final page ends the walk');
  check(pageLeads(rows, 250, 50).leads.length === 0, 'page: an offset at the end is an empty page, not an error');
  check(pageLeads(rows, 9_999, 50).next_offset === 250, 'page: an offset past the end does not walk backwards');
  check(pageLeads(rows, 0, 100).bytes < 64 * 1024, 'page: a full 100-lead page fits the 64 KB ceiling');
  check(
    !JSON.stringify(pageLeads(rows, 0, 1).leads[0]).includes('xxxxx'),
    'page: ad_text is not on the wire',
  );
  // Byte budget: 4 KB landing URLs would blow the ceiling at limit=100.
  const fat = Array.from({ length: 100 }, (_, i) =>
    mkResult(i + 1, { landing_url: `https://example.com/${'p'.repeat(4000)}` }),
  );
  const fatPage = pageLeads(fat, 0, 100);
  check(fatPage.leads.length < 100, 'page: the byte budget binds before the limit does');
  check(fatPage.bytes <= LEADS_PAGE_MAX_BYTES, 'page: the budget is respected');
  check(fatPage.has_more && fatPage.next_offset === fatPage.leads.length, 'page: a budget-bound page still advances');
  // One lead bigger than the whole budget still comes back, alone.
  const huge = [mkResult(1, { landing_url: `https://example.com/${'p'.repeat(60_000)}` }), mkResult(2)];
  const hugePage = pageLeads(huge, 0, 100);
  check(hugePage.leads.length === 1 && hugePage.next_offset === 1, 'page: an oversize lead is returned alone, never dropped');

  // ── the wire shapes ──
  const lead = leadToChiefDto(
    mkResult(7, { is_game: 1, app_category: 'GAME_CASINO', store_url: 'https://play.google.com/x' }),
  );
  check(lead.is_game === true, 'lead: is_game 1 becomes true');
  check(leadToChiefDto(mkResult(8, { is_game: 0 })).is_game === false, 'lead: is_game 0 becomes false');
  check(leadToChiefDto(mkResult(9)).is_game === null, 'lead: is_game NULL stays null');
  check(lead.found_at === '2023-11-14T22:13:20.000Z', 'lead: found_at is ISO-8601 UTC');
  check(Object.keys(lead).length === 10, 'lead: the object has exactly the 10 documented fields');

  const mkJob = (over: Partial<JobRow> = {}): JobRow => ({
    id: 'job_abc1234567',
    product_type: 'mobile',
    countries: '["US","GB"]',
    status: 'running',
    csv_path: null,
    error: null,
    created_at: 1_700_000_000_000,
    started_at: 1_700_000_060_000,
    completed_at: null,
    total_ads_scraped: 0,
    total_advertisers: 0,
    recipient_email: null,
    notification_status: null,
    created_by_user_id: CHIEF_PRINCIPAL_ID,
    source: 'meta',
    source_params: '{"maxLeads":50}',
    phase: 'scraping',
    phase_detail: 'US / "casino" (3/40)',
    phase_updated_at: 1_700_000_060_000,
    hq_zip_path: null,
    run_after: null,
    cancel_requested: 0,
    leads_found: 12,
    progress_pct: 37.5,
    ...over,
  });
  const dto = jobToChiefDto(mkJob(), 'chief-1');
  check(dto.state === 'running' && dto.phase === 'scraping', 'job: state and phase are this repo\'s own vocabulary');
  check(dto.step === 'US / "casino" (3/40)', 'job: step is the human UI\'s progress line verbatim');
  check(dto.countries.join(',') === 'US,GB', 'job: countries are parsed out of the stored JSON');
  check(dto.lead_count === 50, 'job: lead_count is read back off source_params');
  check(dto.leads_found === 12 && dto.progress_pct === 37.5, 'job: live progress is carried through');
  check(dto.created_at === '2023-11-14T22:13:20.000Z' && dto.completed_at === null, 'job: timestamps are ISO or null');
  check(dto.final === false, 'job: a running job is not final');
  check(jobToChiefDto(mkJob({ status: 'completed', completed_at: 1 }), null).final, 'job: completed is final');
  check(jobToChiefDto(mkJob({ status: 'failed' }), null).final, 'job: failed is final');
  check(jobToChiefDto(mkJob({ status: 'cancelled' }), null).final, 'job: cancelled is final');
  check(!jobToChiefDto(mkJob({ status: 'pending' }), null).final, 'job: pending is not final');
  check(!jobToChiefDto(mkJob({ status: 'deferred' }), null).final, 'job: deferred is not final — it runs again after midnight');
  check(jobToChiefDto(mkJob(), null).external_id === null, 'job: a missing mapping reports a null external_id');
  check(
    jobToChiefDto(mkJob({ error: 'x'.repeat(5000) }), null).error!.length === 500,
    'job: a pipeline error is bounded on the wire',
  );
  check(jobLeadCount(mkJob({ source_params: null })) === null, 'job: no source_params means no cap');
  check(jobLeadCount(mkJob({ source_params: 'not json' })) === null, 'job: unparseable source_params does not throw');
  check(dto.run_after === null, 'job: a job that was never deferred has a null run_after');
  check(
    jobToChiefDto(mkJob({ status: 'deferred', run_after: 1_700_000_000_000 }), null).run_after ===
      '2023-11-14T22:13:20.000Z',
    'job: a deferred job says when it becomes runnable again',
  );
  check(Object.keys(dto).length === 17, 'job: the object has exactly the 17 documented fields');

  check(isoOrNull(null) === null && isoOrNull(undefined) === null, 'iso: null in, null out');

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('chief.js') || process.argv[1].endsWith('chief.ts'));
if (isMain) {
  const { passed, failed, failures } = runChiefTests();
  console.log(`chief tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
