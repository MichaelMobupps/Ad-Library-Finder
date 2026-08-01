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
 * Bundle 2 makes the prefix live. Every switched value below is guarded on a
 * non-empty PREFIX, so "BASE_PATH unset" remains the identity in all of them:
 * the cookie name, the bare-prefix redirect and the SPA fallback are each
 * structurally inert at the default rather than merely equal to it.
 *
 * HOW THE TWO VARS COMPOSE (Bundle 2)
 * PUBLIC_URL is this app's FULL public base and already contains the prefix —
 * at cutover the pair is set together as
 *   BASE_PATH=/leadfinder  PUBLIC_BASE_URL=https://tools.mobupps.net/leadfinder
 * so an absolute link is PUBLIC_URL + path, NOT PUBLIC_URL + prefix + path.
 * Adding the prefix a second time would email everyone
 * ".../leadfinder/leadfinder/api/jobs/<id>/csv". The two are checked against
 * each other at load (assertPublicUrlCarriesPrefix) so a half-configured
 * deploy fails loudly instead of quietly emitting dead links.
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
 * Build an absolute (or, when PUBLIC_URL is empty, rooted) URL for a rooted path.
 *
 * PUBLIC_URL is the app's full public base and ALREADY carries the prefix (see
 * the header note), so the prefix is applied to exactly one of the two halves:
 *   - PUBLIC_URL set   -> `${PUBLIC_URL}${p}`      (prefix comes from PUBLIC_URL)
 *   - PUBLIC_URL empty -> joinBasePath(prefix, p)  (prefix comes from BASE_PATH)
 *
 * Both branches are byte-identical to the old `${base}${path}` at the default,
 * where prefix is '' and joinBasePath is the identity.
 */
export function buildPublicUrl(publicUrl: string, prefix: string, p: string): string {
  if (publicUrl === '') return joinBasePath(prefix, p);
  if (!p.startsWith('/')) {
    throw new UrlConfigError(`path must be rooted, got ${JSON.stringify(p)}`);
  }
  return `${publicUrl}${p}`;
}

/**
 * Refuse a configuration where a prefix is active but PUBLIC_URL does not name
 * it. Such a deploy serves fine and emails links that 404 — the failure lands
 * days later in someone's inbox, which is the worst place to discover it.
 *
 * Enforced ONLY while a prefix is active, so nothing about today's unprefixed
 * deploy can start failing: whatever PUBLIC_BASE_URL holds now keeps behaving
 * exactly as it does. Empty is allowed and warned about elsewhere — that is the
 * pre-existing O-1 state, and refusing to boot over it would turn a long-
 * standing wart into an outage.
 *
 * Two shapes are refused:
 *   - a non-empty value that is not an absolute http(s) URL. Behind a gateway
 *     there is no such thing as a legitimate relative public base, so this is
 *     always a typo. `https://host%40evil.com/leadfinder` is the motivating
 *     case: the WHATWG host parser rejects it outright (so it can never reach
 *     another origin — but it can never be OPENED either), and every emailed
 *     link would go out silently unclickable.
 *   - an absolute URL whose path is not EXACTLY the prefix — which covers the
 *     missing-prefix mistake, the double-prefix mistake, and the doubled
 *     trailing slash (".../leadfinder//"), whose links resolve to a path no
 *     mount matches and are therefore answered with the SPA page.
 */
export function assertPublicUrlCarriesPrefix(publicUrl: string, prefix: string): void {
  if (prefix === '' || publicUrl === '') return;

  let parsed: URL | null = null;
  try {
    parsed = new URL(publicUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || !ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new UrlConfigError(
      `PUBLIC_BASE_URL ${JSON.stringify(publicUrl)} is not an absolute http(s) URL, and ` +
        `BASE_PATH ${JSON.stringify(prefix)} is set. Behind a gateway the public base must ` +
        `be absolute or every emailed link is unusable, e.g. "https://tools.example.com${prefix}".`,
    );
  }

  // EXACT equality, on the pathname as the URL parser reports it — no endsWith,
  // and no trailing-slash forgiveness either.
  //
  // endsWith would wave through the mirror-image mistake — a hand-written
  // ".../leadfinder/leadfinder" — which is precisely the double-prefix this
  // check exists to stop.
  //
  // Forgiving a trailing slash HERE was its own hole, because the composition
  // in buildPublicUrl does not forgive one. normalizePublicUrl strips exactly
  // one trailing slash, so ".../leadfinder//" arrives here as ".../leadfinder/"
  // — pathname "/leadfinder/" — and every emitted link becomes
  // ".../leadfinder//api/jobs/<id>/csv". That path does not match the
  // "/leadfinder/api/jobs" mount, so the prefixed SPA fallback answers it with
  // 200 index.html: the user clicks "Download CSV" in their inbox and gets the
  // app page, with no error anywhere and the auth check never reached. Compare
  // what will actually be concatenated, not a tidied-up version of it.
  if (parsed.pathname !== prefix) {
    throw new UrlConfigError(
      `PUBLIC_BASE_URL ${JSON.stringify(publicUrl)} has path ${JSON.stringify(parsed.pathname)} ` +
        `but BASE_PATH is ${JSON.stringify(prefix)}. They are set together at cutover: ` +
        `PUBLIC_BASE_URL is this app's full public base and its path must be exactly the ` +
        `mount — no trailing slash, no extra segment — e.g. "https://tools.example.com${prefix}".`,
    );
  }
}

/**
 * Name of the session cookie for a given prefix.
 *
 * Unprefixed the app keeps the name it has always set. Once mounted under a
 * shared gateway the four tools sit on one origin and one cookie namespace, so
 * a generic name would let whichever tool wrote last clobber the others; the
 * name becomes per-app at the same moment the Path narrows.
 */
export function sessionCookieName(prefix: string): string {
  return prefix === '' ? 'als_session' : 'lf_session';
}

/**
 * Location for the bare-prefix redirect, or null to leave the request alone.
 *
 * "/leadfinder" must reach "/leadfinder/" or the SPA loads with a broken
 * relative asset base. The obvious implementation — registering a route at the
 * bare prefix — is a trap: Express routing is non-strict, so a route at
 * "/leadfinder" ALSO matches "/leadfinder/", and the handler then redirects the
 * trailing-slash form to itself. Three sibling apps took their main page down
 * that way.
 *
 * This compares the full request path for EXACT equality with the prefix, so
 * "/leadfinder/" can never match and the loop is structurally impossible, not
 * merely avoided. `bare(prefix, bare(prefix, x))` is null for every x — a
 * second hop cannot exist. Returns null for the whole default configuration.
 *
 * `search` is the request's raw query string (leading "?", or empty). It is
 * carried across so the redirect loses nothing, and it cannot affect the
 * decision or the origin: the path half is a fixed literal built from the
 * validated prefix, so the result always starts with "/<prefix>/".
 */
export function bareBasePathRedirect(
  prefix: string,
  reqPath: string,
  search = '',
): string | null {
  if (prefix === '') return null;
  if (reqPath !== prefix) return null;
  return `${prefix}/${search}`;
}

/**
 * Whether the prefix-scoped SPA fallback should answer with index.html.
 *
 * `mountRelPath` is the request path with the mount prefix already stripped by
 * Express (so "/leadfinder/api/jobs/x" arrives as "/api/jobs/x").
 *
 *  - Non-GET/HEAD passes through, exactly as today's `app.get('*')` does.
 *  - Anything under /api passes the decision through unchanged, so an unmatched
 *    API path keeps returning what it returns today (the API routers are
 *    mounted first and therefore still win).
 *  - A request whose last segment looks like a file reached this point only
 *    because express.static did not have it. It is a MISSING ASSET: answer 404
 *    rather than 200 index.html, which is how a bad asset path masquerades as a
 *    working page.
 *  - Everything else is a deep link -> index.html.
 */
export function spaFallbackServesIndex(method: string, mountRelPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const isApi = mountRelPath === '/api' || mountRelPath.startsWith('/api/');
  if (!isApi) {
    const last = mountRelPath.slice(mountRelPath.lastIndexOf('/') + 1);
    if (last.includes('.')) return false;
  }
  return true;
}

/** Internal prefix: '' by default, else e.g. '/leadfinder'. */
const PREFIX = normalizeBasePath(process.env.BASE_PATH);

/** True once the app is mounted under a prefix. Every Bundle 2 switch keys off this. */
export const IS_PREFIXED: boolean = PREFIX !== '';

/** The mount prefix as a path. Default '/'. */
export const BASE_PATH: string = PREFIX === '' ? '/' : PREFIX;

/**
 * This app's public address, with any single trailing slash removed.
 * Default '' — exactly what the inline reads produced before this module.
 */
export const PUBLIC_URL: string = normalizePublicUrl(process.env.PUBLIC_BASE_URL);

assertPublicUrlCarriesPrefix(PUBLIC_URL, PREFIX);

/**
 * The env var is PUBLIC_BASE_URL, not PUBLIC_URL — a legacy name Bundle 1 kept
 * deliberately. The migration's own runbook calls it PUBLIC_URL, so an operator
 * setting that name would get silently empty links (open item O-1's failure
 * mode) instead of an error. Say so, loudly, at the only moment it matters.
 */
export const PUBLIC_URL_ENV_MISNAMED: boolean =
  !process.env.PUBLIC_BASE_URL && !!process.env.PUBLIC_URL;

/**
 * Prefixed, but with no public address to build absolute links from. Not fatal
 * — it is exactly the state O-1 describes and predates this bundle — but behind
 * a gateway it means every emailed result link goes out as a bare rooted path.
 */
export const PUBLIC_URL_MISSING_WHILE_PREFIXED: boolean = IS_PREFIXED && PUBLIC_URL === '';

/** Name of the session cookie — per-app once mounted under a prefix. */
export const SESSION_COOKIE_NAME: string = sessionCookieName(PREFIX);

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

  // ---- PUBLIC_URL / BASE_PATH composition: the prefix appears EXACTLY once ----
  // Cutover shape: PUBLIC_BASE_URL already carries the prefix, so buildPublicUrl
  // must not add it a second time.
  check(
    buildPublicUrl('https://g.example.com/leadfinder', '/leadfinder', '/api/jobs/x/csv') ===
      'https://g.example.com/leadfinder/api/jobs/x/csv',
    'prefixed absolute link carries the prefix exactly once',
  );
  check(
    buildPublicUrl('https://g.example.com/leadfinder', '/leadfinder', '/#/jobs/x') ===
      'https://g.example.com/leadfinder/#/jobs/x',
    'prefixed emailed job link carries the prefix exactly once',
  );
  for (const p of ['/api/jobs/x/csv', '/api/jobs/x/hq-zip', '/#/jobs/x', '/api/auth/google/callback']) {
    const link = buildPublicUrl('https://g.example.com/leadfinder', '/leadfinder', p);
    const occurrences = link.split('/leadfinder').length - 1;
    check(occurrences === 1, `${p}: prefix appears once, not ${occurrences} times`);
    check(new URL(link).origin === 'https://g.example.com', `${p}: stays on our origin`);
  }
  // With no PUBLIC_URL the prefix has to come from BASE_PATH instead.
  check(
    buildPublicUrl('', '/leadfinder', '/api/jobs/x/csv') === '/leadfinder/api/jobs/x/csv',
    'empty PUBLIC_URL falls back to a prefixed rooted path',
  );

  // The two vars must agree, or the deploy refuses to boot.
  assertPublicUrlCarriesPrefix('', ''); passed++;
  assertPublicUrlCarriesPrefix('https://g.example.com', ''); passed++;
  assertPublicUrlCarriesPrefix('', '/leadfinder'); passed++;
  assertPublicUrlCarriesPrefix('https://g.example.com/leadfinder', '/leadfinder'); passed++;
  // A trailing slash the operator typed is stripped by normalizePublicUrl BEFORE
  // this check ever sees it, so assert the REAL pipeline rather than the check
  // in isolation — the two disagreeing is what let the doubled slash through.
  assertPublicUrlCarriesPrefix(normalizePublicUrl('https://g.example.com/leadfinder/'), '/leadfinder'); passed++;
  assertPublicUrlCarriesPrefix('example.com', ''); passed++; // unprefixed: untouched, as always
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com/leadfinder/leadfinder', '/leadfinder'),
    'PUBLIC_BASE_URL that already double-prefixes refused',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com/sub/leadfinder', '/leadfinder'),
    'PUBLIC_BASE_URL whose path is deeper than the mount refused',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com', '/leadfinder'),
    'PUBLIC_BASE_URL without the prefix refused while prefixed',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com/other', '/leadfinder'),
    'PUBLIC_BASE_URL naming a different prefix refused',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com/xleadfinder', '/leadfinder'),
    'PUBLIC_BASE_URL whose last segment merely ENDS with the prefix refused',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com/leadfinder/api', '/leadfinder'),
    'PUBLIC_BASE_URL pointing below the mount refused',
  );
  // Behind a gateway there is no legitimate relative public base: a value that
  // will not parse can only be a typo, and it emails links nobody can open.
  throws(
    () => assertPublicUrlCarriesPrefix('example.com', '/leadfinder'),
    'scheme-less PUBLIC_BASE_URL refused while prefixed',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com%40evil.com/leadfinder', '/leadfinder'),
    'PUBLIC_BASE_URL with a percent-encoded @ in the host refused while prefixed',
  );
  // The DOUBLED trailing slash. normalizePublicUrl strips exactly one, so this
  // reaches the check as ".../leadfinder/" and used to pass — after which every
  // emitted link read ".../leadfinder//api/...", matched no mount, and was
  // answered with 200 index.html instead of the file.
  throws(
    () => assertPublicUrlCarriesPrefix(normalizePublicUrl('https://g.example.com/leadfinder//'), '/leadfinder'),
    'PUBLIC_BASE_URL with a doubled trailing slash refused while prefixed',
  );
  throws(
    () => assertPublicUrlCarriesPrefix('https://g.example.com/leadfinder/', '/leadfinder'),
    'a public base whose pathname still ends in "/" is refused — composition would double it',
  );
  throws(
    () => assertPublicUrlCarriesPrefix(normalizePublicUrl('https://g.example.com/leadfinder/.'), '/leadfinder'),
    'PUBLIC_BASE_URL with a dot segment after the mount refused while prefixed',
  );

  // COMPOSITION PROPERTY: every value the boot path accepts must compose to a
  // pathname that is exactly prefix + path. Checked with the URL oracle, on the
  // real pipeline (normalizePublicUrl -> assert -> buildPublicUrl), because the
  // hole was precisely a disagreement between the check and the concatenation.
  for (const raw of [
    'https://g.example.com/leadfinder',
    'https://g.example.com/leadfinder/',
    '  https://g.example.com/leadfinder  ',
    'https://g.example.com:8443/leadfinder',
  ]) {
    const pub = normalizePublicUrl(raw);
    assertPublicUrlCarriesPrefix(pub, '/leadfinder'); passed++;
    for (const p of ['/api/jobs/x/csv', '/api/jobs/x/hq-zip', '/api/auth/google/callback', '/#/jobs/x', '/']) {
      const link = buildPublicUrl(pub, '/leadfinder', p);
      const parsed = new URL(link);
      check(!parsed.pathname.includes('//'), `${raw} + ${p}: no doubled slash in ${link}`);
      check(parsed.pathname.startsWith('/leadfinder/'), `${raw} + ${p}: stays under the mount (${parsed.pathname})`);
      check(parsed.origin === new URL(raw.trim()).origin, `${raw} + ${p}: stays on our origin`);
    }
  }

  // ---- session cookie: name switches with the mount, Path never widens ----
  check(sessionCookieName('') === 'als_session', 'unprefixed cookie name unchanged');
  check(sessionCookieName('/leadfinder') === 'lf_session', 'prefixed cookie name is per-app');
  check(sessionCookieName('/a/b') === 'lf_session', 'nested prefix also renames');
  check(joinBasePath('', '/') === '/', 'unprefixed cookie Path is "/"');
  check(joinBasePath('/leadfinder', '/') === '/leadfinder/', 'prefixed cookie Path is the mount');
  for (const prefix of ['/leadfinder', '/a/b']) {
    const cookiePath = joinBasePath(prefix, '/');
    check(cookiePath.startsWith(prefix), `cookie Path ${cookiePath} is never wider than ${prefix}`);
    check(cookiePath !== '/', `cookie Path ${cookiePath} is not the whole origin`);
    // RFC 6265 §5.1.4 path-match, as the browser applies it. The cookie must
    // reach every path we serve and nothing outside the mount.
    const pathMatches = (reqPath: string) =>
      reqPath === cookiePath ||
      (reqPath.startsWith(cookiePath) &&
        (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/'));
    check(pathMatches(`${prefix}/api/jobs/x/csv`), 'cookie reaches prefixed download URLs');
    check(pathMatches(`${prefix}/api/me`), 'cookie reaches prefixed API calls');
    check(pathMatches(`${prefix}/`), 'cookie reaches the app root');
    check(!pathMatches('/'), 'cookie is NOT sent to the gateway root');
    check(!pathMatches('/other/api/me'), 'cookie is NOT sent to a sibling tool');
    check(!pathMatches(`${prefix}x/api/me`), 'cookie is NOT sent to a prefix-lookalike path');
  }

  // ---- bare-prefix redirect: one hop, and a self-loop is impossible ----
  check(bareBasePathRedirect('', '/') === null, 'unprefixed: root is left alone');
  check(bareBasePathRedirect('', '/leadfinder') === null, 'unprefixed: nothing ever redirects');
  check(bareBasePathRedirect('', '/api/jobs') === null, 'unprefixed: API paths untouched');
  check(
    bareBasePathRedirect('/leadfinder', '/leadfinder') === '/leadfinder/',
    'bare prefix redirects to the trailing-slash form',
  );
  // THE loop guard. A route registered at the bare prefix would match this too.
  check(
    bareBasePathRedirect('/leadfinder', '/leadfinder/') === null,
    'trailing-slash form does NOT redirect (no self-loop)',
  );
  check(
    bareBasePathRedirect('/leadfinder', bareBasePathRedirect('/leadfinder', '/leadfinder')!) === null,
    'the redirect target does not itself redirect — exactly one hop, ever',
  );
  check(bareBasePathRedirect('/leadfinder', '/leadfinder/api/me') === null, 'API paths pass through');
  check(bareBasePathRedirect('/leadfinder', '/leadfinderX') === null, 'prefix-lookalike untouched');
  check(bareBasePathRedirect('/leadfinder', '/') === null, 'origin root is not ours to redirect');
  check(bareBasePathRedirect('/leadfinder', '/other') === null, 'sibling tool path untouched');
  check(
    bareBasePathRedirect('/leadfinder', '/leadfinder', '?a=1') === '/leadfinder/?a=1',
    'the query string survives the redirect',
  );
  {
    // A hostile query may not move the target off our origin, and may not turn
    // the redirect into a second hop.
    const origin = 'https://self.example.com';
    for (const search of [
      '',
      '?a=1',
      '?next=//evil.com',
      '?next=https://evil.com',
      '?a=%2F%2Fevil.com',
      '?a=b#/../..',
    ]) {
      const target = bareBasePathRedirect('/leadfinder', '/leadfinder', search)!;
      check(target.startsWith('/leadfinder/'), `target stays under the mount for ${search || '(none)'}`);
      check(!target.startsWith('//'), `target is not protocol-relative for ${search || '(none)'}`);
      check(!BACKSLASH.test(target), `target has no backslash for ${search || '(none)'}`);
      const resolved = new URL(target, origin);
      check(resolved.origin === origin, `target stays same-origin for ${search || '(none)'}`);
      check(resolved.pathname === '/leadfinder/', `target path is exactly the mount for ${search || '(none)'}`);
      check(
        bareBasePathRedirect('/leadfinder', resolved.pathname) === null,
        `no second hop for ${search || '(none)'}`,
      );
    }
  }

  // ---- SPA fallback: deep links yes, missing assets no, API untouched ----
  check(spaFallbackServesIndex('GET', '/') === true, 'root serves the SPA');
  check(spaFallbackServesIndex('GET', '/jobs/abc') === true, 'deep link serves the SPA');
  check(spaFallbackServesIndex('HEAD', '/jobs/abc') === true, 'HEAD deep link serves the SPA');
  check(spaFallbackServesIndex('GET', '/assets/missing.js') === false, 'missing asset 404s honestly');
  check(spaFallbackServesIndex('GET', '/favicon.ico') === false, 'missing icon 404s honestly');
  check(spaFallbackServesIndex('POST', '/jobs/abc') === false, 'POST falls through, as app.get("*") did');
  check(spaFallbackServesIndex('PUT', '/') === false, 'PUT falls through');
  check(spaFallbackServesIndex('GET', '/api/nope') === true, 'unmatched API path answers as it does today');
  check(spaFallbackServesIndex('GET', '/api') === true, 'bare /api answers as it does today');
  check(spaFallbackServesIndex('GET', '/api/x.y') === true, 'API path with a dot is still API');
  check(spaFallbackServesIndex('GET', '/apiary/x') === true, 'an /api lookalike is a deep link');
  check(spaFallbackServesIndex('GET', '/apiary/x.js') === false, 'an /api lookalike file still 404s');

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
