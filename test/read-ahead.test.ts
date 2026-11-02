import { describe, expect, test } from "bun:test";
import { ReadAheadQueue } from "../src/read-ahead";

describe("active fiction read-ahead", () => {
  test("warms only the bounded window and skips cached chapters", async () => {
    const scheduled: Array<() => void> = [];
    const fetched: number[] = [];
    const q = new ReadAheadQueue({ cached: (id) => id === 2, fetch: async (id) => { fetched.push(id); }, schedule: (fn) => { scheduled.push(fn); } });
    q.enqueue("u", "f", [2, 3, 4, 5], 3);
    scheduled.shift()!();
    await Promise.resolve(); await Promise.resolve();
    scheduled.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(fetched).toEqual([3, 4]);
  });

  test("switching fiction discards queued work; depth zero disables warming", async () => {
    const scheduled: Array<() => void> = [];
    const fetched: number[] = [];
    const q = new ReadAheadQueue({ cached: () => false, fetch: async (id) => { fetched.push(id); }, schedule: (fn) => { scheduled.push(fn); } });
    q.enqueue("u", "old", [1, 2], 2);
    q.enqueue("u", "new", [9], 1);
    scheduled.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(fetched).toEqual([9]);
    q.enqueue("u", "new", [10], 0);
    expect(scheduled).toHaveLength(0);
  });

  test("failure clears queued work and delays a later retry", async () => {
    const scheduled: Array<{ run: () => void; delay: number }> = [];
    const q = new ReadAheadQueue({ cached: () => false, fetch: async () => { throw new Error("offline"); }, now: () => 1000, schedule: (run, delay) => { scheduled.push({ run, delay }); } });
    q.enqueue("u", "f", [1, 2], 2);
    scheduled.shift()!.run();
    await Promise.resolve(); await Promise.resolve();
    expect(scheduled).toHaveLength(0);
    q.enqueue("u", "f", [1], 1);
    expect(scheduled[0].delay).toBe(120000);
  });

  test("a running fetch finishes before work for a newly selected novel", async () => {
    const scheduled: Array<() => void> = [];
    const fetched: number[] = [];
    let finish!: () => void;
    const q = new ReadAheadQueue({
      cached: () => false,
      fetch: (id) => { fetched.push(id); return new Promise<void>((resolve) => { finish = resolve; }); },
      schedule: (fn) => { scheduled.push(fn); },
    });
    q.enqueue("u", "old", [1, 2], 2);
    scheduled.shift()!();
    q.enqueue("u", "new", [9], 1);
    expect(fetched).toEqual([1]);
    expect(scheduled).toHaveLength(0);
    finish();
    await Promise.resolve(); await Promise.resolve();
    scheduled.shift()!();
    expect(fetched).toEqual([1, 9]);
    finish();
  });
});
