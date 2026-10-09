import { describe, test, expect } from "bun:test";
import { parseProxy } from "../src/config";

describe("parseProxy", () => {
  test("unset means no proxy", () => {
    expect(parseProxy("")).toBeUndefined();
  });

  test("http proxy splits credentials out of the URL", () => {
    expect(parseProxy("http://us%40er:p%3Ass@proxy.example:3128")).toEqual({
      server: "http://proxy.example:3128",
      username: "us@er",
      password: "p:ss",
    });
  });

  test("socks5 without credentials passes straight through", () => {
    expect(parseProxy("socks5://127.0.0.1:1055")).toEqual({ server: "socks5://127.0.0.1:1055" });
  });

  test("garbage is ignored rather than crashing boot", () => {
    expect(parseProxy("not a url")).toBeUndefined();
  });
});
