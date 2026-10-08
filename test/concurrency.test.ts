/**
 * Guards the browser-fetch concurrency cap.
 *
 * The bug this pins: a Cloudflare-challenged fetch holds a Chromium page for up
 * to a minute, and with no cap, several concurrent chapter requests each doing
 * that saturated the 2-CPU machine badly enough that it stopped answering even
 * /health. The app itself, not Royal Road, was what broke.
 *
 * The semaphore lives in scraper.ts (it guards the browser lifecycle), so the
 * same class is duplicated here only to the extent needed to check the rules —
 * acquire/release idempotence, ordering, and that a release wakes a waiter.
 */
import { describe, expect, test } from "bun:test";

/** Mirrors the semaphore in src/scraper.ts. */
class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    while (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    return this.makeRelease();
  }

  get inFlight(): number {
    return this.active;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    };
  }
}

describe("browser fetch semaphore", () => {
  test("admits up to the limit and parks the rest", async () => {
    const sem = new Semaphore(3);
    const releases = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
    expect(sem.inFlight).toBe(3);

    let admitted = false;
    const pending = sem.acquire().then((r) => {
      admitted = true;
      return r;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(sem.inFlight).toBe(3);

    releases[0]();
    const fourth = await pending;
    expect(admitted).toBe(true);
    expect(sem.inFlight).toBe(3);

    fourth();
    expect(sem.inFlight).toBe(2);
  });

  // closeOwned can be reached from both the return path and the error path.
  test("release is idempotent", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    release();
    expect(sem.inFlight).toBe(0);
  });

  test("waiters are woken in order", async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire();
    const order: number[] = [];
    const a = sem.acquire().then((r) => { order.push(1); return r; });
    const b = sem.acquire().then((r) => { order.push(2); return r; });

    // Releasing admits the first waiter; the second still has to wait for it.
    first();
    const ra = await a;
    expect(order).toEqual([1]);
    expect(sem.inFlight).toBe(1);

    ra();
    const rb = await b;
    expect(order).toEqual([1, 2]);

    rb();
    expect(sem.inFlight).toBe(0);
  });
});
