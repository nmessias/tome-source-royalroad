import { describe, expect, test } from "bun:test";
import { SingleFlight } from "../src/single-flight";

describe("chapter single-flight", () => {
  test("shares overlapping work for the same key", async () => {
    const flights = new SingleFlight<number, string>();
    let calls = 0;
    let complete!: (value: string) => void;
    const operation = () => { calls++; return new Promise<string>((resolve) => { complete = resolve; }); };
    const first = flights.run(1, operation);
    const second = flights.run(1, operation);
    await Promise.resolve();
    expect(calls).toBe(1);
    complete("chapter");
    expect(await Promise.all([first, second])).toEqual(["chapter", "chapter"]);
  });

  test("separates keys and retries after failure", async () => {
    const flights = new SingleFlight<number, number>();
    const first = flights.run(1, async () => { throw new Error("failed"); });
    expect(await flights.run(2, async () => 2)).toBe(2);
    await expect(first).rejects.toThrow("failed");
    expect(await flights.run(1, async () => 3)).toBe(3);
  });
});
