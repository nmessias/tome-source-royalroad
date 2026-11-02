/**
 * HTTP client for Royal Road: the primary transport, with the browser as an
 * optional fallback.
 *
 * `impit` impersonates a browser's TLS/HTTP handshake, ~40MB against
 * Chromium's ~220-330MB. Measured 2026-11-02: its Firefox profile gets real
 * pages from a residential exit (directly, or through the phone exit node from
 * Fly's gru region); its Chrome profile is challenged everywhere. A plain
 * logged-in GET records reading progress like a browser visit does (Royal Road
 * does it server-side). What it cannot do is solve a JS challenge.
 *
 * Exit location matters more than the client: through the same phone exit,
 * requests from Fly's iad region (~200ms behind the exit) were challenged 9/10
 * while gru (~40ms) passed 10/10.
 */
import { Impit, type ImpitOptions, type RequestInit } from "impit";
import { SCRAPER_TIMEOUT } from "./config";

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks4:", "socks5:", "socks5h:"]);

/**
 * ROYAL_ROAD_PROXY as impit needs it, or undefined to go direct. With
 * socks5:// impit resolves hostnames itself and connects by address, which is
 * what tailscaled's SOCKS server needs (it rejects hostnames), so impit can
 * use :1055 directly; only Chromium needs the DNS bridge.
 */
export function parseHttpProxy(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
      console.error(`[Scraper] ROYAL_ROAD_PROXY uses unsupported scheme "${url.protocol}" - ignoring it`);
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
    // Do not override User-Agent or other identifying headers: a mismatch with
    // the impersonated handshake is itself a tell.
    browser: "firefox",
    timeout: SCRAPER_TIMEOUT,
    ...(proxyUrl ? { proxyUrl } : {}),
  };
}

let client: Impit | null = null;

function getClient(): Impit {
  if (!client) {
    const proxyUrl = parseHttpProxy(process.env.ROYAL_ROAD_PROXY);
    client = new Impit(httpClientOptions(proxyUrl));
    console.log(`[Scraper] HTTP client ready (Firefox impersonation, proxy=${proxyUrl ? "configured" : "none"})`);
  }
  return client;
}

/** What callers read from a response; both transports satisfy it. */
export interface RoyalRoadResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  text(): Promise<string>;
}

/**
 * The fetcher (fetcher/ in this repo) runs on the user's phone and makes the
 * request from Android's own network stack, which Cloudflare trusts more than
 * a request relayed through the phone's Tailscale exit node. Both variables
 * must be set to use it; otherwise requests go out directly (or via
 * ROYAL_ROAD_PROXY) with impit.
 */
function fetcherConfig(): { url: string; token: string } | null {
  const url = process.env.ROYAL_ROAD_FETCHER_URL?.trim();
  const token = process.env.ROYAL_ROAD_FETCHER_TOKEN?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function fetchViaFetcher(fetcher: { url: string; token: string }, url: string, init?: RequestInit): Promise<RoyalRoadResponse> {
  if (init?.body != null && typeof init.body !== "string") throw new Error("The Royal Road fetcher only supports string request bodies");
  // Reuses the impit client, so ROYAL_ROAD_PROXY (tailscaled's SOCKS5) carries
  // the call to the phone's tailnet IP. Its transport errors keep impit's
  // names (ConnectError, ReadTimeout, ...), which is what isUnreachable reads.
  const res = await getClient().fetch(`${fetcher.url}/fetch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fetcher.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: init?.method,
      headers: [...new Headers(init?.headers as HeadersInit | undefined)],
      body: init?.body,
      redirect: init?.redirect === "manual" ? "manual" : "follow",
    }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    let detail = text.slice(0, 200);
    try { detail = JSON.parse(text).error ?? detail; } catch { /* not JSON */ }
    const error = new Error(`Royal Road fetcher answered HTTP ${res.status}: ${detail}`);
    // 502/504: the phone could not reach Royal Road. That is "unreachable"
    // (a stale copy may be served). 401/403/400 are our own mistakes: plain errors.
    if (res.status === 502 || res.status === 504) error.name = "ConnectError";
    throw error;
  }
  const out = JSON.parse(text) as { status: number; url: string; headers: [string, string][]; body: string };
  const headers = new Headers();
  for (const [name, value] of out.headers) headers.append(name, value); // keeps every set-cookie
  return { status: out.status, url: out.url, headers, text: async () => out.body };
}

export function fetchRoyalRoad(url: string, init?: RequestInit): Promise<RoyalRoadResponse> {
  const fetcher = fetcherConfig();
  return fetcher ? fetchViaFetcher(fetcher, url, init) : getClient().fetch(url, init);
}

/**
 * Cookie header for an HTTP fetch. `cf_clearance` is dropped: it is bound to
 * the client that earned it, and a stored one makes Cloudflare treat the
 * request as forged.
 */
export function cookieHeaderFor(cookies: { name: string; value: string }[]): string {
  return cookies
    .filter((cookie) => cookie.name !== "cf_clearance")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export type HttpVerdict = "ok" | "challenge" | "login" | "error";

/**
 * What an HTTP response means for the scraper. A logged-in request must come
 * back logged in: a logged-out page passes every content check, so without the
 * logout-link test an expired session silently read pages (and synced
 * progress) anonymously.
 */
export function classifyResponse(
  res: { status: number; html: string; finalUrl: string; cfMitigated: string | null },
  wantAuth: boolean,
): HttpVerdict {
  if (res.cfMitigated === "challenge" || /<title>\s*Just a moment/i.test(res.html)) return "challenge";
  if (res.finalUrl.includes("/account/login") || /<title>\s*Sign In\s*\|/i.test(res.html)) return "login";
  if (res.status === 404) return "ok";
  if (res.status < 200 || res.status >= 300) return "error";
  if (wantAuth && !res.html.includes("account/logout")) return "login";
  return "ok";
}
