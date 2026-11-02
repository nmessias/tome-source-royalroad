import { describe, expect, test } from "bun:test";
import { useAuthenticatedContext } from "../src/context-selection";

describe("Royal Road context selection", () => {
  test("uses a session for authenticated progress and private pages", () => {
    expect(useAuthenticatedContext("user", true, false)).toBe(true);
  });
  test("uses a session for public pages while allowing a dead session to fall back", () => {
    expect(useAuthenticatedContext("user", true, true)).toBe(true);
    expect(useAuthenticatedContext("user", true, true, true)).toBe(false);
    expect(useAuthenticatedContext("user", true, false, true)).toBe(true);
    expect(useAuthenticatedContext(undefined, false, true)).toBe(false);
    expect(useAuthenticatedContext("user", false, false)).toBe(false);
  });
});
