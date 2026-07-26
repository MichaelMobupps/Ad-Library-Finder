/**
 * Rate limiter for polite store scraping.
 *
 * Each store publishes a request budget (Play ≈ 1 req/s per stream, iTunes ≈ 10
 * req/min). RateLimiter admits calls at a target rate and caps how many may be
 * in flight at once.
 *
 * Two properties matter and both were wrong in the original serial version:
 *
 *  1. **The gap is start-to-start, not settle-to-start.** The old chain slept
 *     `minIntervalMs` AFTER each call settled, so the fetch's own latency stacked
 *     on top of the interval: a 1000 ms interval plus ~160 ms of Play latency ran
 *     at 1.16 s/request, a silent 14% tax measurable in the job logs (3,210
 *     enrichment requests took 62 min instead of 53). Gating on START makes the
 *     latency overlap the interval, which is what "1 req/s" is supposed to mean.
 *
 *  1b. **What `maxConcurrent` actually buys.** Admission is rate-gated at
 *     `minIntervalMs / maxConcurrent` between STARTS, so the aggregate target
 *     rate is `maxConcurrent` requests per `minIntervalMs`. In-flight count
 *     therefore peaks at `min(maxConcurrent, ceil(latency / gap))`, NOT at
 *     maxConcurrent: with Play's ~345 ms latency and a 200 ms gap, roughly two
 *     requests overlap and the run still lands 5 req/s. The ceiling is headroom
 *     that keeps throughput at target when latency spikes — not a promise that
 *     N requests are always in the air.
 *
 *  2. **Concurrency is a parameter.** The old version was a single promise chain,
 *     i.e. hard-wired to one in-flight request. Store enrichment is a stream of
 *     thousands of independent detail fetches, so serializing them made the
 *     enrichment phase 71% of a 2.5-hour job. `maxConcurrent` lets a stream run N
 *     requests at once; the admission gap is divided by N so the TARGET RATE is
 *     unchanged in aggregate — `new RateLimiter(1000, 5)` is 5 req/s, i.e. five
 *     polite 1-req/s streams, not five times the politeness budget.
 *
 * `maxConcurrent = 1` reproduces the original behaviour exactly (modulo fix 1).
 *
 * `penalize(ms)` is the adaptive-backoff hook: a caller that recognises a 429 /
 * 403 / block page pauses EVERY stream behind this limiter for a while, so one
 * penalty-boxed exit IP throttles the whole harvest instead of hammering on.
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  /** Admission chain — resolves when the next call may START. */
  private gate: Promise<unknown> = Promise.resolve();
  /** In-flight count, bounded by maxConcurrent. */
  private active = 0;
  /** Callers parked waiting for an in-flight slot, FIFO. */
  private readonly waiters: Array<() => void> = [];
  /** Epoch ms until which every call must hold off (adaptive backoff). */
  private penaltyUntil = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxConcurrent: number = 1,
  ) {}

  /** Start-to-start gap. N concurrent streams each honouring minIntervalMs is one
   *  stream admitting a call every minIntervalMs/N — same aggregate rate. */
  private get startGapMs(): number {
    return Math.max(0, Math.floor(this.minIntervalMs / Math.max(1, this.maxConcurrent)));
  }

  /** Take an in-flight slot, parking if the pool is full. */
  private acquireSlot(): void | Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Release an in-flight slot. A parked caller inherits the slot DIRECTLY rather
   *  than going through active--/active++, which would briefly leave the pool
   *  under-occupied and let a fast-path caller over-subscribe it. */
  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }

  /**
   * Queue `fn`. It starts once the admission gap has elapsed AND an in-flight
   * slot is free AND any active penalty has expired. Returns fn's result (or
   * rejection) to THIS caller; a rejection never breaks the chain for others.
   */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const admit = () => this.acquireSlot();
    const admitted = this.gate.then(admit, admit);
    // The NEXT call's gate opens startGapMs after THIS one was admitted.
    const reopen = () => sleep(this.startGapMs);
    this.gate = admitted.then(reopen, reopen);

    return admitted.then(async () => {
      try {
        const hold = this.penaltyUntil - Date.now();
        if (hold > 0) await sleep(hold);
        return await fn();
      } finally {
        this.releaseSlot();
      }
    });
  }

  /**
   * Back off every stream behind this limiter for `ms`. Cumulative in the sense
   * that it only ever extends an existing penalty — two blocks in quick
   * succession must not shorten the first one's hold.
   */
  penalize(ms: number): void {
    if (!(ms > 0)) return;
    this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + ms);
  }

  /** Remaining backoff in ms (0 when clear) — for logging/tests. */
  penaltyRemainingMs(): number {
    return Math.max(0, this.penaltyUntil - Date.now());
  }
}

// ── offline self-tests (no network) ──────────────────────────────────────────

export async function runStoreThrottleTests(): Promise<{ passed: number; failed: number; failures: string[] }> {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, desc: string) => {
    if (cond) passed++;
    else failures.push(`FAIL: ${desc}`);
  };

  // Concurrency is respected, and observed peak reaches the cap.
  {
    const lim = new RateLimiter(40, 4);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        lim.schedule(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(25);
          inFlight--;
        }),
      ),
    );
    check(peak <= 4, `concurrency never exceeds the cap (peak ${peak})`);
    check(peak > 1, `concurrency actually parallelises (peak ${peak})`);
    check(inFlight === 0, 'every slot released');
  }

  // The ceiling is REACHABLE when latency outlasts the admission gap — and only
  // then. Both halves matter: the first proves maxConcurrent is not dead config,
  // the second (above) proves the rate gate still binds when work is quick.
  {
    const lim = new RateLimiter(20, 4); // gap = 5ms
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 16 }, () =>
        lim.schedule(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(60); // 60ms >> 5ms gap, so the ceiling binds
          inFlight--;
        }),
      ),
    );
    check(peak === 4, `ceiling reached when latency outlasts the gap (peak ${peak})`);
    check(inFlight === 0, 'ceiling test released every slot');
  }

  // Saturation with interleaved rejections must not deadlock or leak slots —
  // a wedged Play limiter would hang every store_first job indefinitely.
  {
    const lim = new RateLimiter(4, 4);
    let settled = 0;
    let inFlight = 0;
    const tasks = Array.from({ length: 80 }, (_, i) =>
      lim
        .schedule(async () => {
          inFlight++;
          await sleep(i % 3);
          inFlight--;
          if (i % 5 === 0) throw new Error('synthetic');
        })
        .then(
          () => settled++,
          () => settled++,
        ),
    );
    const raced = await Promise.race([Promise.all(tasks).then(() => 'drained'), sleep(15_000).then(() => 'TIMEOUT')]);
    check(raced === 'drained', 'saturation + rejections drain without deadlock');
    check(settled === 80, `every task settled (${settled}/80)`);
    check(inFlight === 0, 'no slot leaked across 16 rejections');
    check((await lim.schedule(async () => 'alive')) === 'alive', 'limiter still usable after saturation');
  }

  // maxConcurrent = 1 is strictly serial (the original contract).
  {
    const lim = new RateLimiter(5, 1);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        lim.schedule(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(5);
          inFlight--;
        }),
      ),
    );
    check(peak === 1, `maxConcurrent=1 stays serial (peak ${peak})`);
  }

  // A rejection is delivered to its own caller and does not wedge the limiter.
  {
    const lim = new RateLimiter(1, 2);
    let caught = false;
    await lim.schedule(async () => {
      throw new Error('boom');
    }).catch(() => {
      caught = true;
    });
    const after = await lim.schedule(async () => 'ok');
    check(caught, 'rejection reaches its own caller');
    check(after === 'ok', 'limiter still works after a rejection');
  }

  // Start-to-start pacing: 4 calls at a 30ms gap take >= ~90ms even though the
  // work itself is instant (the old settle-based chain would also have added the
  // work latency on top — this asserts the gap exists at all).
  {
    const lim = new RateLimiter(30, 1);
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await lim.schedule(async () => undefined);
    const elapsed = Date.now() - t0;
    check(elapsed >= 60, `admission gap enforced (${elapsed}ms for 4 calls at 30ms)`);
  }

  // penalize() holds subsequent calls and only ever extends.
  {
    const lim = new RateLimiter(1, 1);
    lim.penalize(60);
    const rem = lim.penaltyRemainingMs();
    check(rem > 0 && rem <= 60, `penalty registered (${rem}ms)`);
    lim.penalize(10); // shorter — must not shrink the hold
    check(lim.penaltyRemainingMs() >= rem - 5, 'a shorter penalty never shortens the hold');
    const t0 = Date.now();
    await lim.schedule(async () => undefined);
    check(Date.now() - t0 >= 30, 'a penalised call actually waits');
    lim.penalize(0);
    check(true, 'penalize(0) is a no-op');
  }

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('storeThrottle.js') || process.argv[1].endsWith('storeThrottle.ts'));
if (isMain) {
  void runStoreThrottleTests().then(({ passed, failed, failures }) => {
    console.log(`storeThrottle tests: ${passed} passed, ${failed} failed`);
    for (const f of failures) console.log('  ' + f);
    process.exit(failed === 0 ? 0 : 1);
  });
}
