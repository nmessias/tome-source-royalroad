/**
 * Guards the Cookie header rules.
 *
 * The bug these pin: `cf_clearance` was read back only for authenticated
 * fetches, so anonymous requests — which is what public fiction/chapter/search
 * pages use — sent no cookies at all. The browser context that solved the
 * challenge then discarded its clearance, and every read re-challenged from
 * scratch with no way to bootstrap.
 */
import { describe, expect, test } from "bun:test";
import { buildCookieHeader } from "../src/cookie-header";

describe("buildCookieHeader", () => {
  test("sends the shared clearance for an anonymous request", () => {
    expect(buildCookieHeader(undefined, "shared-clearance")).toBe("cf_clearance=shared-clearance");
  });

  test("sends nothing when there is no user and no clearance", () => {
    expect(buildCookieHeader(undefined, null)).toBe("");
    expect(buildCookieHeader([], "")).toBe("");
  });

  test("sends the user's session alongside the shared clearance", () => {
    const header = buildCookieHeader(
      [{ name: ".AspNetCore.Identity.Application", value: "identity" }],
      "shared"
    );
    expect(header).toBe(".AspNetCore.Identity.Application=identity; cf_clearance=shared");
  });

  // A user's own clearance was earned more recently, so it must not be
  // duplicated or shadowed.
  test("prefers the user's clearance over the shared one", () => {
    const header = buildCookieHeader(
      [{ name: "cf_clearance", value: "mine" }],
      "shared"
    );
    expect(header).toBe("cf_clearance=mine");
    expect(header.match(/cf_clearance=/g)).toHaveLength(1);
  });

  test("skips malformed cookies rather than emitting a bare name", () => {
    const header = buildCookieHeader(
      [{ name: "ok", value: "1" }, { name: "", value: "x" }, { name: "noValue", value: "" }],
      null
    );
    expect(header).toBe("ok=1");
  });
});
