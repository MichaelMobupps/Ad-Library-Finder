/**
 * Serialized rate limiter for polite store scraping.
 *
 * Each store publishes a request budget (Play ≈ 1 req/s, iTunes ≈ 10 req/min).
 * RateLimiter serializes every call it wraps AND enforces a minimum gap between
 * the end of one call and the start of the next, using a single promise chain so
 * concurrent callers can't race past the throttle. No timers/Date — just awaits.
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly minIntervalMs: number) {}

  /** Queue `fn`; it starts only after the previous queued call settled + the
   *  min interval. Returns fn's result (or rejection) to THIS caller. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn); // run after predecessor settles (either way)
    // The gate for the NEXT queued call opens `minIntervalMs` after this one settles.
    this.tail = run.then(
      () => sleep(this.minIntervalMs),
      () => sleep(this.minIntervalMs),
    );
    return run;
  }
}
