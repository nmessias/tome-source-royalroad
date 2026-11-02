import { describe, expect, test } from "bun:test";
import { SaveQueue, parseSyndicationChapterIds, unreadFrom, assertOnline, noteUnreachable, markOnline, isOffline } from "../src/offline";
import { isUnreachable } from "../src/config";

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function harness(opts: { cached?: (id: number) => boolean; fail?: (id: number) => boolean; offline?: () => boolean } = {}) {
  const scheduled: Array<{ fn: () => void; delay: number }> = [];
  const fetched: number[] = [];
  const q = new SaveQueue({
    cached: opts.cached ?? (() => false),
    fetch: async (id) => { fetched.push(id); if (opts.fail?.(id)) throw new Error("challenged"); },
    offline: opts.offline ?? (() => false),
    paceMs: 12_000,
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); },
  });
  const step = async () => { const next = scheduled.shift()!; next.fn(); await settle(); return next.delay; };
  return { q, scheduled, fetched, step };
}

describe("offline save queue", () => {
  test("saves serially at the pace, skipping saved and already-queued chapters", async () => {
    const { q, scheduled, fetched, step } = harness({ cached: (id) => id === 2 });
    expect(q.add(7, [1, 2, 3])).toBe(2);
    expect(q.add(7, [3, 4])).toBe(1);
    expect(q.pending(7)).toBe(3);
    expect(scheduled).toHaveLength(1);
    await step();
    expect(scheduled[0].delay).toBe(12_000);
    await step(); await step();
    expect(fetched).toEqual([1, 3, 4]);
    expect(q.pending(7)).toBe(0);
    expect(scheduled).toHaveLength(0);
  });

  test("a failing chapter is retried twice more, then dropped", async () => {
    const { q, scheduled, fetched, step } = harness({ fail: (id) => id === 1 });
    q.add(7, [1, 2]);
    await step();
    expect(scheduled[0].delay).toBe(120_000);
    await step(); await step();
    await step();
    expect(fetched).toEqual([1, 1, 1, 2]);
  });

  test("offline spells wait without using up retries", async () => {
    let offline = true;
    const { q, scheduled, fetched, step } = harness({ offline: () => offline });
    q.add(7, [1]);
    await step(); await step();
    expect(fetched).toEqual([]);
    expect(scheduled[0].delay).toBe(60_000);
    offline = false;
    await step();
    expect(fetched).toEqual([1]);
  });
});

describe("offline helpers", () => {
  test("RSS chapter ids, oldest first", () => {
    const xml = `<item><link>https://www.royalroad.com/fiction/1/x/chapter/30/c</link></item>
      <item><link>https://www.royalroad.com/fiction/1/x/chapter/20/b</link><guid>/chapter/99</guid></item>`;
    expect(parseSyndicationChapterIds(xml)).toEqual([20, 30]);
  });

  test("unread starts after the last read chapter, else at the resume point", () => {
    expect(unreadFrom([{ id: 1, isRead: true }, { id: 2 }, { id: 3, isRead: true }, { id: 4 }])).toBe(3);
    expect(unreadFrom([{ id: 1 }, { id: 2 }, { id: 3 }], 2)).toBe(1);
    expect(unreadFrom([{ id: 1 }, { id: 2 }])).toBe(0);
  });

  test("offline requests fail fast with an error that serves stale copies", () => {
    noteUnreachable(() => new Promise(() => {}));
    expect(isOffline()).toBe(true);
    let error: unknown;
    try { assertOnline("https://www.royalroad.com/fiction/1"); } catch (e) { error = e; }
    expect(isUnreachable(error)).toBe(true);
    markOnline();
    expect(() => assertOnline("x")).not.toThrow();
  });
});
