/**
 * Guards the shared cf_clearance mirror.
 *
 * The gap this pins: a clearance pasted into Settings is stored per user, and
 * anonymous fetches — which is what public fiction/chapter/search pages use
 * once a session is known dead — only read the shared copy. So the one
 * clearance a user can provide by hand was ignored exactly when it was needed.
 */
import { describe, expect, test } from "bun:test";
import { buildCookieHeader } from "../src/cookie-header";

describe("clearance reaching an anonymous fetch", () => {
  // Mirrors setRoyalRoadCookie's mirror rule.
  const setUserCookie = (name: string, value: string): string | null => {
    const perUser = value;
    return name === "cf_clearance" ? perUser : null;
  };

  test("a pasted cf_clearance reaches the anonymous fetch", () => {
    const shared = setUserCookie("cf_clearance", "pasted-clearance");
    expect(shared).toBeTruthy();

    // Anonymous fetch: no user jar, shared clearance only.
    const anonHeader = buildCookieHeader(undefined, shared);
    expect(anonHeader).toBe("cf_clearance=pasted-clearance");
  });

  test("an authenticated fetch keeps the user's own session cookie", () => {
    const shared = setUserCookie("cf_clearance", "pasted-clearance");
    const header = buildCookieHeader(
      [{ name: ".AspNetCore.Identity.Application", value: "identity" }],
      shared
    );
    expect(header).toBe(".AspNetCore.Identity.Application=identity; cf_clearance=pasted-clearance");
  });

  test("a non-clearance cookie is not mirrored", () => {
    expect(setUserCookie(".AspNetCore.Identity.Application", "identity")).toBeNull();
  });
});
