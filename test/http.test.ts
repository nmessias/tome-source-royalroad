import { describe, expect, test } from "bun:test";
import { SCRAPER_TIMEOUT } from "../src/config";
import { cookieHeaderFor, fetchRoyalRoad, httpClientOptions, parseHttpProxy } from "../src/http";

describe("Royal Road HTTP transport", () => {
  test("uses Chrome impersonation and the scraper timeout", () => {
    expect(httpClientOptions(undefined)).toEqual({
      browser: "chrome",
      timeout: SCRAPER_TIMEOUT,
    });
  });

  test("an explicit proxy is passed through to impit", () => {
    expect(httpClientOptions("socks5://127.0.0.1:1055")).toEqual({
      browser: "chrome",
      timeout: SCRAPER_TIMEOUT,
      proxyUrl: "socks5://127.0.0.1:1055",
    });
  });

  test("no proxy means direct", () => {
    expect(parseHttpProxy(undefined)).toBeUndefined();
    expect(parseHttpProxy("")).toBeUndefined();
    expect(parseHttpProxy("   ")).toBeUndefined();
  });

  test("accepted proxy schemes are returned unchanged", () => {
    expect(parseHttpProxy("http://user:pass@proxy.example:3128")).toBe("http://user:pass@proxy.example:3128");
    expect(parseHttpProxy(" socks5://127.0.0.1:1055 ")).toBe("socks5://127.0.0.1:1055");
  });

  test("invalid or unsupported proxies are ignored rather than crashing boot", () => {
    expect(parseHttpProxy("not a url")).toBeUndefined();
    expect(parseHttpProxy("ftp://proxy.example:21")).toBeUndefined();
  });

  test("cf_clearance is never sent on an HTTP request", () => {
    const header = cookieHeaderFor([
      { name: ".AspNetCore.Identity.Application", value: "session" },
      { name: "cf_clearance", value: "stale-and-ip-bound" },
      { name: "beta-ui-v2", value: "1" },
    ]);

    expect(header).toBe(".AspNetCore.Identity.Application=session; beta-ui-v2=1");
  });

  test("fetchRoyalRoad performs a real request through the native client", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new Response(`ok ${new URL(request.url).pathname}`);
      },
    });

    try {
      const response = await fetchRoyalRoad(`http://127.0.0.1:${server.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok /health");
    } finally {
      server.stop(true);
    }
  });
});
