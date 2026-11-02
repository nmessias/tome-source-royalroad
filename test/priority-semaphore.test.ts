import { describe, expect, test } from "bun:test";
import { PrioritySemaphore } from "../src/priority-semaphore";

describe("browser priority semaphore", () => {
  test("admits waiting foreground before background, and releases once", async () => {
    const slots = new PrioritySemaphore(1);
    const first = await slots.acquire();
    const order: string[] = [];
    const background = slots.acquire(true).then((release) => { order.push("background"); return release; });
    const foreground = slots.acquire().then((release) => { order.push("foreground"); return release; });
    first();
    first();
    const releaseForeground = await foreground;
    expect(order).toEqual(["foreground"]);
    releaseForeground();
    const releaseBackground = await background;
    expect(order).toEqual(["foreground", "background"]);
    releaseBackground();
  });

  test("cancels a queued background request without consuming the slot", async () => {
    const slots = new PrioritySemaphore(1);
    const release = await slots.acquire();
    const controller = new AbortController();
    const pending = slots.acquire(true, controller.signal);
    const rejected = pending.catch((error) => error);
    controller.abort();
    expect((await rejected).message).toContain("cancelled");
    release();
    const next = await slots.acquire();
    next();
  });
});
