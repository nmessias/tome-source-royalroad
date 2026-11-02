import { describe, expect, test } from "bun:test";
import { IdleLease } from "../src/idle-lease";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("browser idle lease", () => {
  test("fires once after the last lease is released, not while one is held", async () => {
    let fired = 0;
    const lease = new IdleLease(20, () => fired++);
    const a = lease.acquire();
    const b = lease.acquire();
    a();
    a();
    await tick(40);
    expect(fired).toBe(0);
    b();
    await tick(40);
    expect(fired).toBe(1);
  });

  test("a new lease cancels a pending idle close", async () => {
    let fired = 0;
    const lease = new IdleLease(20, () => fired++);
    lease.acquire()();
    const held = lease.acquire();
    await tick(40);
    expect(fired).toBe(0);
    held();
  });

  test("0 disables idle closing", async () => {
    let fired = 0;
    new IdleLease(0, () => fired++).acquire()();
    await tick(20);
    expect(fired).toBe(0);
  });
});
