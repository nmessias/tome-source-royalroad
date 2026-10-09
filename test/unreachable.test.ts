import { describe, test, expect } from "bun:test";
import { isUnreachable } from "../src/config";

describe("isUnreachable (what may be answered from a stale copy)", () => {
  test("exit node / network failures are unreachable", () => {
    expect(isUnreachable(new Error("goto: net::ERR_SOCKS_CONNECTION_FAILED at https://www.royalroad.com/my/follows"))).toBe(true);
    expect(isUnreachable(new Error("goto: net::ERR_PROXY_CONNECTION_FAILED at https://x"))).toBe(true);
    expect(isUnreachable(new Error("goto: net::ERR_TIMED_OUT at https://x"))).toBe(true);
    expect(isUnreachable(new Error("page.goto: Timeout 60000ms exceeded."))).toBe(true);
  });

  test("Cloudflare blocks are unreachable", () => {
    expect(isUnreachable(new Error("Cloudflare would not let the browser through after several attempts."))).toBe(true);
    expect(isUnreachable(new Error("Cloudflare blocked the request for the fiction header"))).toBe(true);
  });

  test("Royal Road saying no must NOT be masked by an old copy", () => {
    expect(isUnreachable(new Error("Royal Road rejected the stored session. Paste a fresh cookie."))).toBe(false);
    expect(isUnreachable(new Error("Session cookies not configured. Please set up your Royal Road cookies first."))).toBe(false);
    expect(isUnreachable(new Error("Auto-login failed. Please configure your Royal Road session manually."))).toBe(false);
    expect(isUnreachable(new Error("Royal Road returned a page without the fiction header (title: Not Found | Royal Road)"))).toBe(false);
  });

  test("non-errors are not unreachable", () => {
    expect(isUnreachable(undefined)).toBe(false);
    expect(isUnreachable("boom")).toBe(false);
  });
});
