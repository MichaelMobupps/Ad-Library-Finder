/**
 * Hard deadlines for awaits that have no native timeout.
 *
 * Why this exists: Playwright's page.evaluate() has NO timeout of any kind —
 * it waits for the renderer's main thread to answer, forever. On 2026-07-29 a
 * mobile scrape opened the (media-heavy) Facebook Ad Library, the page pegged
 * the deploy VM, and the first page.evaluate never returned: the job wedged
 * in-flight for 40+ minutes, unkillable (the Stop flag is only polled BETWEEN
 * steps), while the wedged renderer starved the VM so badly that 20s fetch
 * aborts fired after ~2 minutes, an OAuth token call dangled 9 minutes, and
 * the dashboard stopped loading. Every await inside a scrape step now runs
 * under one of these deadlines, and a breach poisons the shared browser
 * (scraper.ts forceRecycleBrowser) so the wedged renderer is killed rather
 * than trusted again.
 */

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`deadline exceeded: ${label} did not settle within ${ms}ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * Race `promise` against a timer. On breach, rejects with DeadlineError —
 * the underlying operation is NOT cancelled (most have no cancel API); the
 * caller decides whether the resource behind it must be torn down.
 *
 * Promise.race attaches handlers to BOTH branches, so a late settle/reject of
 * the losing promise is observed and can never surface as an unhandledRejection.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    // Don't hold the process open for a pending gate (e.g. during shutdown).
    timer.unref?.();
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ---------- offline self-tests (run-tests.mjs discovers run*Tests) ----------

export async function runDeadlineTests(): Promise<{ passed: number; failed: number; failures: string[] }> {
  let passed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, name: string) => {
    if (cond) passed++;
    else failures.push(`✗ ${name}`);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // In-time resolution passes the value through.
  check((await withDeadline(Promise.resolve(42), 1000, 't')) === 42, 'in-time value passes through');

  // In-time rejection passes the original error through.
  try {
    await withDeadline(Promise.reject(new Error('boom')), 1000, 't');
    check(false, 'in-time rejection propagates');
  } catch (err) {
    check((err as Error).message === 'boom', 'in-time rejection propagates');
    check(!(err instanceof DeadlineError), 'original rejection is not wrapped');
  }

  // Breach rejects with DeadlineError carrying the label.
  try {
    await withDeadline(sleep(200), 20, 'slow-op');
    check(false, 'breach rejects');
  } catch (err) {
    check(err instanceof DeadlineError, 'breach rejects with DeadlineError');
    check((err as Error).message.includes('slow-op'), 'DeadlineError names the operation');
  }

  // A losing promise that later REJECTS must not crash the process
  // (Promise.race observed it). Give it time to fire.
  const lateFail = sleep(30).then(() => {
    throw new Error('late loser rejection');
  });
  try {
    await withDeadline(lateFail, 5, 'late-loser');
  } catch {
    /* expected DeadlineError */
  }
  await sleep(60); // if the loser rejection were unobserved, node would warn/crash here
  check(true, 'late loser rejection is observed (no unhandledRejection)');

  return { passed, failed: failures.length, failures };
}

const isMainDeadline =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('deadline.js') || process.argv[1].endsWith('deadline.ts'));
if (isMainDeadline) {
  const { passed, failed, failures } = await runDeadlineTests();
  console.log(`deadline: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}
