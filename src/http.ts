/**
 * HTTP client for Royal Road.
 *
 * Royal Road's Cloudflare rules reject Bun's `fetch` from Fly's datacenter IPs
 * on its TLS/HTTP fingerprint, not on cookies. `impit` impersonates a real
 * Chrome handshake, which passes those checks directly, so it is the primary
 * transport. Playwright remains the fallback for a JS challenge or login flow.
 */
import { Impit, type ImpitOptions, type ImpitResponse, type RequestInit } from "impit";
import { SCRAPER_TIMEOUT } from "./config";

/** Proxy schemes impit can speak. */
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks4:", "socks5:"]);

/**
 * Validate ROYAL_ROAD_PROXY before handing it to impit.
 *
 * An invalid proxy must not crash the scraper at import time. Returning
 * undefined means "go direct", which is now the normal path; the warning makes
 * a typo in the optional escape hatch visible.
 */
export function parseHttpProxy(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
      console.error(
        `[Scraper] ROYAL_ROAD_PROXY uses unsupported scheme "${url.protocol}" - ignoring it`
      );
      return undefined;
    }
    return value;
  } catch {
    console.error("[Scraper] ROYAL_ROAD_PROXY is not a valid URL - ignoring it");
    return undefined;
  }
}

/** Options for the shared impit client. Exported so the transport can be tested without a network. */
export function httpClientOptions(proxyUrl: string | undefined): ImpitOptions {
  return {
    // Generic "chrome" rides the newest profile impit ships. Do not override
    // the User-Agent or sec-ch-ua headers: a mismatched pair is itself a tell.
    browser: "chrome",
    timeout: SCRAPER_TIMEOUT,
    ...(proxyUrl ? { proxyUrl } : {}),
  };
}

let client: Impit | null = null;
let loggedConfiguration = false;

function getClient(): Impit {
  if (!client) {
    const proxyUrl = parseHttpProxy(process.env.ROYAL_ROAD_PROXY);
    client = new Impit(httpClientOptions(proxyUrl));
    if (!loggedConfiguration) {
      loggedConfiguration = true;
      console.log(
        `[Scraper] HTTP client ready (Chrome TLS impersonation, proxy=${proxyUrl ? "configured" : "none"})`
      );
    }
  }
  return client;
}

/** Fetch through the shared Chrome-impersonating client. */
export function fetchRoyalRoad(url: string, init?: RequestInit): Promise<ImpitResponse> {
  return getClient().fetch(url, init);
}

/**
 * Cookie header for an HTTP fetch.
 *
 * `cf_clearance` is deliberately dropped: it is bound to the IP and browser
 * that earned it, so a stored one is stale here and makes Cloudflare treat the
 * request as forged. The identity cookie is the part that matters.
 */
export function cookieHeaderFor(cookies: { name: string; value: string }[]): string {
  return cookies
    .filter((cookie) => cookie.name !== "cf_clearance")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
