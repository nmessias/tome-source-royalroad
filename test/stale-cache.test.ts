import { describe, expect, test } from "bun:test";
import { isUnreachable } from "../src/config";
import { withStale } from "../src/stale-cache";

describe("stale chapter fallback", () => {
  test("uses retained content on a network or Cloudflare failure", async () => {
    const result = await withStale<{ id: number; content: string }>(
      async () => { throw new Error("net::ERR_SOCKS_CONNECTION_FAILED"); },
      () => JSON.stringify({ id: 1, content: "saved chapter" }),
      isUnreachable,
    );
    expect(result).toEqual({ id: 1, content: "saved chapter" });
  });

  test("does not mask rejected content or missing retained content", async () => {
    const missing = new Error("Royal Road returned 404");
    await expect(withStale(async () => { throw missing; }, () => "{}", isUnreachable)).rejects.toBe(missing);
    const offline = new Error("net::ERR_CONNECTION_FAILED");
    await expect(withStale(async () => { throw offline; }, () => null, isUnreachable)).rejects.toBe(offline);
  });
});
