import { describe, expect, test } from "bun:test";
import { SCRAPER_TIMEOUT } from "../src/config";
import { classifyResponse, cookieHeaderFor, fetchRoyalRoad, httpClientOptions, parseHttpProxy } from "../src/http";

describe("Royal Road HTTP transport", () => {
  test("uses Firefox impersonation and the scraper timeout", () => {
    expect(httpClientOptions(undefined)).toEqual({ browser: "firefox", timeout: SCRAPER_TIMEOUT });
    expect(httpClientOptions("socks5h://127.0.0.1:1056").proxyUrl).toBe("socks5h://127.0.0.1:1056");
  });

  test("accepted proxy schemes pass through unchanged", () => {
    expect(parseHttpProxy(" socks5://127.0.0.1:1055 ")).toBe("socks5://127.0.0.1:1055");
    expect(parseHttpProxy("http://user:pass@proxy.example:3128")).toBe("http://user:pass@proxy.example:3128");
  });

  test("no, invalid or unsupported proxy means direct", () => {
    for (const raw of [undefined, "", "   ", "not a url", "ftp://proxy.example:21"]) {
      expect(parseHttpProxy(raw)).toBeUndefined();
    }
  });

  test("cf_clearance is never sent on an HTTP request", () => {
    const header = cookieHeaderFor([
      { name: ".AspNetCore.Identity.Application", value: "session" },
      { name: "cf_clearance", value: "stale-and-ip-bound" },
      { name: ".AspNetCore.Antiforgery.x", value: "af" },
    ]);
    expect(header).toBe(".AspNetCore.Identity.Application=session; .AspNetCore.Antiforgery.x=af");
  });

  test("fetchRoyalRoad performs a real request through the native client", async () => {
    const server = Bun.serve({ port: 0, fetch: (r) => new Response(`ok ${new URL(r.url).pathname}`) });
    try {
      const response = await fetchRoyalRoad(`http://127.0.0.1:${server.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok /health");
    } finally {
      server.stop(true);
    }
  });
});

describe("classifyResponse", () => {
  const page = (html: string, status = 200, finalUrl = "https://www.royalroad.com/fiction/1", cfMitigated: string | null = null) =>
    ({ status, html, finalUrl, cfMitigated });
  const loggedIn = '<title>Ch 1 | Royal Road</title><a href="/account/logout">Log Out</a>';
  const loggedOut = "<title>Ch 1 | Royal Road</title><a href=\"/account/login\">Sign in</a>";

  test("a Cloudflare challenge, by header or by page", () => {
    expect(classifyResponse(page("x", 403, undefined, "challenge"), false)).toBe("challenge");
    expect(classifyResponse(page("<title>Just a moment...</title>", 403), true)).toBe("challenge");
  });

  test("a logged-in request must come back logged in", () => {
    expect(classifyResponse(page(loggedIn), true)).toBe("ok");
    expect(classifyResponse(page(loggedOut), true)).toBe("login");
    expect(classifyResponse(page(loggedOut), false)).toBe("ok");
    expect(classifyResponse(page("<title>Sign In | Royal Road</title>", 200, "https://www.royalroad.com/account/login?returnurl=x"), true)).toBe("login");
  });

  test("404 is content (a removed fiction), other failures are errors", () => {
    expect(classifyResponse(page(loggedOut, 404), true)).toBe("ok");
    expect(classifyResponse(page("", 502), false)).toBe("error");
  });
});
