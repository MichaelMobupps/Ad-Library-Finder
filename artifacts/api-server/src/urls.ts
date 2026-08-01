/**
 * Single source of truth for this app's own public address and its rooted paths.
 *
 * Every place the server names itself — emailed result links, the OAuth redirect
 * URI, the post-login redirect, the session cookie's Path, the route mounts —
 * resolves through here instead of hardcoding "/" or reading PUBLIC_BASE_URL
 * directly. Centralising it is the whole point of Bundle 1: Bundle 2 flips the
 * two env vars and every dependent surface moves together.
 *
 * ZERO BEHAVIOUR CHANGE CONTRACT
 * With BASE_PATH unset, every value produced here is byte-for-byte what the
 * hardcoded expressions produced before:
 *   - BASE_PATH  -> "/"      and joinBasePath('', p) === p
 *   - PUBLIC_URL -> (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
 *     which is the exact expression notifier.ts and oauth.ts used inline.
 * So publicUrl('/api/jobs/x/csv') === `${base}/api/jobs/x/csv`, unchanged.
 *
 * SECURITY
 * Both env vars are operator-supplied and both end up inside links we email and
 * inside redirect targets. Hostile shapes are refused at module load rather than
 * sanitised, because a half-sanitised authority is exactly how open redirects
 * survive review. Refusals are loud and immediate: the process will not boot.
 * Validation is oracle-based (WHATWG `URL`), never a string-shape guess.
 */

/** Schemes we will ever emit. Anything else is refused. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * A path segment separator that some parsers treat as "/" and others do not.
 * Browsers normalise "\" to "/" in the authority position, which is how
 * "/\evil.com" and "/\/evil.com" become protocol-relative in practice.
 */
const BACKSLASH = /\\/;

/**
 * Allowed shape of one BASE_PATH segment.
 *
 * Deliberately far narrower than "what a URL parser tolerates". The prefix is
 * our own mount point ("/leadfinder"), so an allowlist costs nothing and closes
 * a whole class at once: the parser oracle alone accepts "/a'onmouseover=x",
 * "/a%00b", "/a@b" and "/a:b", and basePath('/') is interpolated into an HTML
 * attribute in auth.ts. Relying on that sink's quoting style to stay double is
 * exactly the coupling that breaks two refactors later.
 */
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export class UrlConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlConfigError';
  }
}

/**
 * Normalise BASE_PATH into an internal prefix.
 *
 * Returns '' for the default ("/" or unset) so that joining is a pure no-op,
 * otherwise a rooted path with no trailing slash, e.g. "/leadfinder".
 *
 * Refuses anything that could escape the prefix or introduce an authority:
 * protocol-relative forms, backslashes, dot segments, control characters,
 * and absolute URLs.
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  if (v === '' || v === '/') return '';

  if (BACKSLASH.test(v)) {
    throw new UrlConfigError(`BASE_PATH may not contain a backslash: ${JSON.stringify(v)}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) {
    throw new UrlConfigError('BASE_PATH may not contain control characters');
  }
  if (!v.startsWith('/')) {
    throw new UrlConfigError(`BASE_PATH must start with "/": ${JSON.stringify(v)}`);
  }
  // "//host" is protocol-relative: the browser reads "host" as an authority.
  if (v.startsWith('//')) {
    throw new UrlConfigError(`BASE_PATH may not start with "//": ${JSON.stringify(v)}`);
  }
  if (/[?#]/.test(v)) {
    throw new UrlConfigError(`BASE_PATH may not contain a query or fragment: ${JSON.stringify(v)}`);
  }

  const trimmed = v.replace(/\/+$/, '');
  if (trimmed === '') {
    throw new UrlConfigError(`BASE_PATH must name a path, got ${JSON.stringify(v)}`);
  }

  // Dot segments would let a prefix walk back out of itself; everything else
  // must satisfy the allowlist above.
  for (const seg of trimmed.slice(1).split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new UrlConfigError(
        `BASE_PATH may not contain empty or dot segments: ${JSON.stringify(v)}`,
      );
    }
    if (!SEGMENT.test(seg)) {
      throw new UrlConfigError(
        `BASE_PATH segment ${JSON.stringify(seg)} is not alphanumeric with . _ - inside`,
      );
    }
  }

  // Oracle check: resolved against a base, the prefix must stay on that origin
  // and must not have been reinterpreted as an authority.
  const probe = new URL(trimmed, 'https://base.invalid/');
  if (probe.origin !== 'https://base.invalid' || probe.pathname !== trimmed) {
    throw new UrlConfigError(`BASE_PATH did not resolve to a plain path: ${JSON.stringify(v)}`);
  }

  return trimmed;
}

/**
 * Normalise PUBLIC_URL (env: PUBLIC_BASE_URL).
 *
 * Today's inline expression was `(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')`
 * — an unvalidated string with one trailing slash removed. That is preserved for
 * every benign value, including the empty default and scheme-less values such as
 * "example.com", which have always produced relative links and still do.
 *
 * What is refused is the set of shapes that turn an emailed link or a redirect
 * into someone else's origin: protocol-relative "//evil.com", backslash variants,
 * and absolute URLs on a scheme we would not emit (javascript:, data:, file:…).
 */
export function normalizePublicUrl(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  if (v === '') return '';

  if (BACKSLASH.test(v)) {
    throw new UrlConfigError(`PUBLIC_BASE_URL may not contain a backslash: ${JSON.stringify(v)}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) {
    throw new UrlConfigError('PUBLIC_BASE_URL may not contain control characters');
  }
  // Protocol-relative: no scheme of our own, authority borrowed from the reader.
  if (v.startsWith('//')) {
    throw new UrlConfigError(
      `PUBLIC_BASE_URL may not be protocol-relative: ${JSON.stringify(v)}`,
    );
  }

  const trimmed = v.replace(/\/$/, '');

  // Oracle check. A value that parses as an absolute URL must be http(s); a value
  // that does not parse absolutely is a relative string and stays as-is, which is
  // what it has always been.
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new UrlConfigError(
        `PUBLIC_BASE_URL must be http(s), got ${JSON.stringify(parsed.protocol)}`,
      );
    }
    if (parsed.search || parsed.hash) {
      throw new UrlConfigError('PUBLIC_BASE_URL may not carry a query or fragment');
    }
    // Userinfo is authority confusion: "https://good.com@evil.com" reads as
    // good.com to a human and resolves to evil.com, which would point every
    // emailed download link at the attacker. It can never be legitimate here.
    if (parsed.username || parsed.password) {
      throw new UrlConfigError('PUBLIC_BASE_URL may not contain userinfo (user:pass@)');
    }
  }

  return trimmed;
}

/**
 * Join a rooted path onto the base-path prefix.
 *
 * `p` is a literal rooted path from our own source ("/api/jobs", "/#/jobs/x").
 * With the default empty prefix this returns `p` unchanged — that identity is
 * what makes Bundle 1 a no-op.
 */
export function joinBasePath(prefix: string, p: string): string {
  if (!p.startsWith('/')) {
    throw new UrlConfigError(`path must be rooted, got ${JSON.stringify(p)}`);
  }
  if (prefix === '') return p;
  if (p === '/') return `${prefix}/`;
  return `${prefix}${p}`;
}

/**
 * Build an absolute (or, when PUBLIC_URL is empty, relative) URL for a rooted path.
 * Mirrors the old `${base}${path}` concatenation exactly.
 */
export function buildPublicUrl(publicUrl: string, prefix: string, p: string): string {
  return `${publicUrl}${joinBasePath(prefix, p)}`;
}

/** Internal prefix: '' by default, else e.g. '/leadfinder'. */
const PREFIX = normalizeBasePath(process.env.BASE_PATH);

/** The mount prefix as a path. Default '/'. */
export const BASE_PATH: string = PREFIX === '' ? '/' : PREFIX;

/**
 * This app's public address, with any single trailing slash removed.
 * Default '' — exactly what the inline reads produced before this module.
 */
export const PUBLIC_URL: string = normalizePublicUrl(process.env.PUBLIC_BASE_URL);

/** Name of the session cookie. Bundle 2 makes this per-app. */
export const SESSION_COOKIE_NAME = 'als_session';

/** Path attribute for the session cookie — scoped to the mount. Default '/'. */
export const COOKIE_PATH: string = joinBasePath(PREFIX, '/');

/** A rooted path under the app's mount prefix. */
export function basePath(p: string): string {
  return joinBasePath(PREFIX, p);
}

/** An absolute link to a rooted path, for emails and OAuth registration. */
export function publicUrl(p: string): string {
  return buildPublicUrl(PUBLIC_URL, PREFIX, p);
}

// ── offline tests (no network, no DB — pure string/URL shaping) ───────────────

export function runUrlsTests(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };
  const throws = (fn: () => unknown, desc: string) => {
    try {
      fn();
      failures.push(`FAIL: ${desc} (expected a throw, got none)`);
    } catch (err) {
      if (err instanceof UrlConfigError) passed++;
      else failures.push(`FAIL: ${desc} (threw ${(err as Error).name}, want UrlConfigError)`);
    }
  };

  // ---- the zero-behaviour-change contract ----
  check(normalizeBasePath(undefined) === '', 'BASE_PATH unset -> empty prefix');
  check(normalizeBasePath('') === '', 'BASE_PATH empty -> empty prefix');
  check(normalizeBasePath('/') === '', 'BASE_PATH "/" -> empty prefix');
  check(joinBasePath('', '/api/jobs') === '/api/jobs', 'default prefix is a join no-op');
  check(joinBasePath('', '/') === '/', 'default prefix keeps root as "/"');
  check(
    buildPublicUrl('', '', '/api/jobs/abc/csv') === '/api/jobs/abc/csv',
    'default public url + default prefix === bare path (old behaviour)',
  );
  check(
    buildPublicUrl('https://app.example.com', '', '/#/jobs/abc') ===
      'https://app.example.com/#/jobs/abc',
    'absolute base concatenates exactly as the old inline expression did',
  );
  check(normalizePublicUrl('https://app.example.com/') === 'https://app.example.com',
    'one trailing slash stripped, as before');
  check(normalizePublicUrl(undefined) === '', 'PUBLIC_BASE_URL unset -> empty string');
  check(normalizePublicUrl('example.com') === 'example.com',
    'scheme-less value passes through unchanged (always produced relative links)');

  // ---- prefixed behaviour (Bundle 2 preview; must be well-formed today) ----
  check(normalizeBasePath('/leadfinder') === '/leadfinder', 'plain prefix');
  check(normalizeBasePath('/leadfinder/') === '/leadfinder', 'trailing slash trimmed');
  check(normalizeBasePath('  /leadfinder  ') === '/leadfinder', 'surrounding space trimmed');
  check(joinBasePath('/leadfinder', '/api/jobs') === '/leadfinder/api/jobs', 'prefixed join');
  check(joinBasePath('/leadfinder', '/') === '/leadfinder/', 'prefixed root keeps a slash');
  check(
    buildPublicUrl('https://g.example.com', '/leadfinder', '/api/jobs/x/csv') ===
      'https://g.example.com/leadfinder/api/jobs/x/csv',
    'prefixed absolute link',
  );

  // ---- security: BASE_PATH cannot introduce an authority or escape itself ----
  throws(() => normalizeBasePath('//evil.com'), 'BASE_PATH protocol-relative refused');
  throws(() => normalizeBasePath('///evil.com'), 'BASE_PATH triple-slash refused');
  throws(() => normalizeBasePath('/\\evil.com'), 'BASE_PATH backslash authority refused');
  throws(() => normalizeBasePath('\\\\evil.com'), 'BASE_PATH UNC-style refused');
  throws(() => normalizeBasePath('/\\/evil.com'), 'BASE_PATH mixed slash/backslash refused');
  throws(() => normalizeBasePath('https://evil.com'), 'BASE_PATH absolute URL refused');
  throws(() => normalizeBasePath('http://evil.com'), 'BASE_PATH absolute http URL refused');
  throws(() => normalizeBasePath('javascript:alert(1)'), 'BASE_PATH javascript: refused');
  throws(() => normalizeBasePath('/../etc'), 'BASE_PATH leading dot-dot refused');
  throws(() => normalizeBasePath('/a/../../b'), 'BASE_PATH interior dot-dot refused');
  throws(() => normalizeBasePath('/a/./b'), 'BASE_PATH single-dot segment refused');
  throws(() => normalizeBasePath('/a//b'), 'BASE_PATH empty interior segment refused');
  throws(() => normalizeBasePath('leadfinder'), 'BASE_PATH without leading slash refused');
  throws(() => normalizeBasePath('/a?b=c'), 'BASE_PATH with query refused');
  throws(() => normalizeBasePath('/a#b'), 'BASE_PATH with fragment refused');
  throws(() => normalizeBasePath('/a\nb'), 'BASE_PATH with newline refused');
  // Segment allowlist. The URL oracle alone accepts all of these; the sink in
  // auth.ts interpolates basePath('/') into an HTML attribute, so they are
  // refused outright rather than trusted to be inert.
  throws(() => normalizeBasePath("/a'onmouseover=alert(1)"), 'BASE_PATH single quote refused');
  throws(() => normalizeBasePath('/a"x'), 'BASE_PATH double quote refused');
  throws(() => normalizeBasePath('/a<script>'), 'BASE_PATH angle brackets refused');
  throws(() => normalizeBasePath('/a%00b'), 'BASE_PATH encoded NUL refused');
  throws(() => normalizeBasePath('/a@b'), 'BASE_PATH at-sign refused');
  throws(() => normalizeBasePath('/a:b'), 'BASE_PATH colon refused');
  throws(() => normalizeBasePath('/a;b'), 'BASE_PATH semicolon refused');
  throws(() => normalizeBasePath('/a b'), 'BASE_PATH space refused');
  throws(() => normalizeBasePath('/-lead'), 'BASE_PATH segment may not start with a hyphen');
  throws(() => normalizeBasePath('/lead-'), 'BASE_PATH segment may not end with a hyphen');
  check(normalizeBasePath('/lead-finder_1.0') === '/lead-finder_1.0',
    'BASE_PATH allows hyphen, underscore and dot inside a segment');
  check(normalizeBasePath('/a/b/c') === '/a/b/c', 'BASE_PATH allows nested segments');

  // ---- security: PUBLIC_URL cannot borrow an origin or a dangerous scheme ----
  throws(() => normalizePublicUrl('//evil.com'), 'PUBLIC_BASE_URL protocol-relative refused');
  throws(() => normalizePublicUrl('///evil.com'), 'PUBLIC_BASE_URL triple-slash refused');
  throws(() => normalizePublicUrl('https:\\\\evil.com'), 'PUBLIC_BASE_URL backslash refused');
  throws(() => normalizePublicUrl('javascript:alert(1)'), 'PUBLIC_BASE_URL javascript: refused');
  throws(() => normalizePublicUrl('data:text/html,x'), 'PUBLIC_BASE_URL data: refused');
  throws(() => normalizePublicUrl('file:///etc/passwd'), 'PUBLIC_BASE_URL file: refused');
  throws(() => normalizePublicUrl('https://e.com?x=1'), 'PUBLIC_BASE_URL with query refused');
  throws(() => normalizePublicUrl('https://e.com#f'), 'PUBLIC_BASE_URL with fragment refused');
  throws(() => normalizePublicUrl('https://e.com\nx'), 'PUBLIC_BASE_URL with newline refused');
  // Authority confusion: reads as good.com, resolves to evil.com.
  throws(() => normalizePublicUrl('https://good.com@evil.com'), 'PUBLIC_BASE_URL userinfo refused');
  throws(() => normalizePublicUrl('https://user:pass@evil.com'), 'PUBLIC_BASE_URL user:pass refused');
  // Preserved-as-today shapes: no normalisation beyond the trailing slash.
  check(normalizePublicUrl('HTTPS://Good.COM') === 'HTTPS://Good.COM',
    'PUBLIC_BASE_URL case is preserved exactly as before');
  check(normalizePublicUrl('https://e.com:8443') === 'https://e.com:8443',
    'PUBLIC_BASE_URL keeps an explicit port');
  check(normalizePublicUrl('https://e.com/leadfinder') === 'https://e.com/leadfinder',
    'PUBLIC_BASE_URL may carry a path');

  // ---- oracle: nothing we emit may parse to an origin other than our own ----
  const SELF = 'https://self.example.com';
  for (const p of [
    '/',
    '/api/health',
    '/api/jobs/abc/csv',
    '/api/jobs/abc/hq-zip',
    '/api/auth/google/callback',
    '/#/jobs/abc',
  ]) {
    for (const prefix of ['', '/leadfinder']) {
      const rooted = joinBasePath(prefix, p);
      const resolved = new URL(rooted, SELF);
      check(resolved.origin === SELF, `joinBasePath(${prefix}, ${p}) stays on our origin`);
      check(!rooted.startsWith('//'), `joinBasePath(${prefix}, ${p}) is not protocol-relative`);
      check(!BACKSLASH.test(rooted), `joinBasePath(${prefix}, ${p}) has no backslash`);

      const abs = buildPublicUrl(SELF, prefix, p);
      const absParsed = new URL(abs);
      check(absParsed.origin === SELF, `buildPublicUrl(${prefix}, ${p}) stays on our origin`);
    }
  }

  // ---- joinBasePath refuses non-rooted input (guards a future caller typo) ----
  throws(() => joinBasePath('', 'api/jobs'), 'joinBasePath refuses a relative path');
  throws(() => joinBasePath('/leadfinder', 'api/jobs'), 'joinBasePath refuses relative under prefix');

  return { passed, failed: failures.length, failures };
}

const isMainUrls =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('urls.js') || process.argv[1].endsWith('urls.ts'));
if (isMainUrls) {
  const { passed, failed, failures } = runUrlsTests();
  console.log(`urls: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
