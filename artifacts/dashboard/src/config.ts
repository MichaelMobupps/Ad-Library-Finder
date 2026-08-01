/**
 * Single source of truth for the paths this SPA calls on its own origin.
 *
 * Counterpart to api-server/src/urls.ts. Same semantics, same refusals; the two
 * are a MIRROR pair and must be changed together, the same way LEAD_LIMIT_CHOICES
 * and countries.ts are mirrored across the two workspace packages.
 *
 * ZERO BEHAVIOUR CHANGE CONTRACT
 * The prefix comes from Vite's `import.meta.env.BASE_URL`, which is "/" unless
 * `base` is set in vite.config.ts. It is not set today, so normalize() yields ''
 * and apiPath(p) === p for every call site — byte-for-byte what the hardcoded
 * "/api/..." literals produced before.
 *
 * Bundle 2 sets vite `base`, and every fetch, sign-in link and download href in
 * the app moves with it because they all resolve through here.
 *
 * SECURITY
 * A hostile base would send session-authenticated API calls to someone else's
 * origin, so a base that is protocol-relative, backslash-bearing, absolute, or
 * dot-segmented is refused at module load. That throw is deliberately fatal: a
 * blank screen is a safer failure than silently posting the user's data
 * elsewhere. It cannot fire with the default "/".
 */

/** Vite injects import.meta.env; the dashboard has no ambient vite types, so
 *  read it through a narrow cast rather than widen the project's tsconfig. */
const RAW_BASE: string =
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

export class BasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BasePathError';
  }
}

/**
 * Normalise a base into an internal prefix: '' for the default "/", otherwise a
 * rooted path with no trailing slash. MIRROR of normalizeBasePath in
 * api-server/src/urls.ts — keep the two rule sets in step.
 */
export function normalizeBase(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  if (v === '' || v === '/') return '';

  if (/\\/.test(v)) throw new BasePathError(`base may not contain a backslash: ${v}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) throw new BasePathError('base may not contain control characters');
  if (!v.startsWith('/')) throw new BasePathError(`base must start with "/": ${v}`);
  if (v.startsWith('//')) throw new BasePathError(`base may not start with "//": ${v}`);
  if (/[?#]/.test(v)) throw new BasePathError(`base may not contain a query or fragment: ${v}`);

  const trimmed = v.replace(/\/+$/, '');
  if (trimmed === '') throw new BasePathError(`base must name a path: ${v}`);

  for (const seg of trimmed.slice(1).split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new BasePathError(`base may not contain empty or dot segments: ${v}`);
    }
  }

  // Oracle check, same as the server's: resolved against a base the prefix must
  // stay on that origin and must not have been reinterpreted as an authority.
  const probe = new URL(trimmed, 'https://base.invalid/');
  if (probe.origin !== 'https://base.invalid' || probe.pathname !== trimmed) {
    throw new BasePathError(`base did not resolve to a plain path: ${v}`);
  }

  return trimmed;
}

const PREFIX = normalizeBase(RAW_BASE);

/** The app's mount prefix as a path. Default '/'. */
export const BASE_PATH: string = PREFIX === '' ? '/' : PREFIX;

/**
 * A rooted path on this app's origin. With the default prefix this returns `p`
 * unchanged, which is what makes Bundle 1 a no-op.
 */
export function apiPath(p: string): string {
  if (!p.startsWith('/')) throw new BasePathError(`path must be rooted, got ${p}`);
  if (PREFIX === '') return p;
  if (p === '/') return `${PREFIX}/`;
  return `${PREFIX}${p}`;
}
