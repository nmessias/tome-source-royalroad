import { afterEach, describe, expect, test } from "bun:test";
import { isUnreachable, SCRAPER_TIMEOUT } from "../src/config";
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

describe("Royal Road fetcher transport", () => {
  afterEach(() => {
    delete process.env.ROYAL_ROAD_FETCHER_URL;
    delete process.env.ROYAL_ROAD_FETCHER_TOKEN;
  });

  /** A fake phone service: records requests and answers with `reply`. */
  function fakeFetcher(reply: (body: any) => Response) {
    const seen: { auth: string | null; path: string; body: any }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(r) {
        const body = await r.json();
        seen.push({ auth: r.headers.get("authorization"), path: new URL(r.url).pathname, body });
        return reply(body);
      },
    });
    process.env.ROYAL_ROAD_FETCHER_URL = `http://127.0.0.1:${server.port}/`;
    process.env.ROYAL_ROAD_FETCHER_TOKEN = "s3cret";
    return { seen, server };
  }

  test("posts the request with the bearer token and maps the answer", async () => {
    const { seen, server } = fakeFetcher(() =>
      Response.json({
        status: 302,
        url: "https://www.royalroad.com/home",
        headers: [
          ["Content-Type", "text/html"],
          ["Set-Cookie", ".AspNetCore.Identity.Application=abc; path=/; httponly"],
          ["Set-Cookie", ".AspNetCore.Antiforgery.x=def; path=/"],
          ["cf-mitigated", "challenge"],
        ],
        body: "<title>Hi</title>",
      }),
    );
    try {
      const res = await fetchRoyalRoad("https://www.royalroad.com/account/login", {
        method: "POST",
        headers: { Cookie: "a=b", "Content-Type": "application/x-www-form-urlencoded" },
        body: "x=1",
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.url).toBe("https://www.royalroad.com/home");
      expect(res.headers.get("cf-mitigated")).toBe("challenge");
      expect(res.headers.getSetCookie()).toEqual([
        ".AspNetCore.Identity.Application=abc; path=/; httponly",
        ".AspNetCore.Antiforgery.x=def; path=/",
      ]);
      expect(await res.text()).toBe("<title>Hi</title>");

      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe("/fetch");
      expect(seen[0].auth).toBe("Bearer s3cret");
      expect(seen[0].body.url).toBe("https://www.royalroad.com/account/login");
      expect(seen[0].body.method).toBe("POST");
      expect(seen[0].body.body).toBe("x=1");
      expect(seen[0].body.redirect).toBe("manual");
      expect(seen[0].body.headers).toContainEqual(["cookie", "a=b"]);
      expect(seen[0].body.headers).toContainEqual(["content-type", "application/x-www-form-urlencoded"]);
    } finally {
      server.stop(true);
    }
  });

  test("a plain GET follows redirects by default", async () => {
    const { seen, server } = fakeFetcher(() => Response.json({ status: 200, url: "u", headers: [], body: "" }));
    try {
      await fetchRoyalRoad("https://www.royalroad.com/fiction/1");
      expect(seen[0].body.redirect).toBe("follow");
      expect(seen[0].body.headers).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("an unreachable fetcher keeps impit's error name, so a stale copy may be served", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    process.env.ROYAL_ROAD_FETCHER_URL = `http://127.0.0.1:${port}`;
    process.env.ROYAL_ROAD_FETCHER_TOKEN = "s3cret";
    const error = await fetchRoyalRoad("https://www.royalroad.com/").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isUnreachable(error)).toBe(true);
  });

  test("the phone failing to reach Royal Road is unreachable too", async () => {
    const { server } = fakeFetcher(() => Response.json({ error: "dial tcp: i/o timeout" }, { status: 502 }));
    try {
      const error = await fetchRoyalRoad("https://www.royalroad.com/").catch((e) => e);
      expect(error.message).toContain("dial tcp: i/o timeout");
      expect(isUnreachable(error)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("a rejected token or host is a plain error, not served from a stale copy", async () => {
    for (const [status, message] of [[401, "unauthorized"], [403, "only https royalroad.com URLs are allowed"]] as const) {
      const { server } = fakeFetcher(() => Response.json({ error: message }, { status }));
      try {
        const error = await fetchRoyalRoad("https://www.royalroad.com/").catch((e) => e);
        expect(error.message).toContain(message);
        expect(error.message).not.toContain("s3cret");
        expect(isUnreachable(error)).toBe(false);
      } finally {
        server.stop(true);
      }
    }
  });

  test("without both variables, requests do not go to the fetcher", async () => {
    const { seen, server } = fakeFetcher(() => Response.json({}));
    delete process.env.ROYAL_ROAD_FETCHER_TOKEN;
    const direct = Bun.serve({ port: 0, fetch: () => new Response("direct") });
    try {
      const res = await fetchRoyalRoad(`http://127.0.0.1:${direct.port}/`);
      expect(await res.text()).toBe("direct");
      expect(seen).toHaveLength(0);
    } finally {
      server.stop(true);
      direct.stop(true);
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
