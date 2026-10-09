/**
 * Royal Road plugin config — source-specific environment (was core config).
 */
import type { ToplistType } from "tome";

// Browser/Playwright (disabled by default for smaller image, set ENABLE_BROWSER=true to enable)
export const ENABLE_BROWSER = process.env.ENABLE_BROWSER === "true";

// Which Playwright engine to drive. Chromium is the default because Cloudflare
// treats it far more leniently: it rejects the Royal Road login POST outright
// when the browser is Firefox (or when Chromium runs headless), which breaks
// auto-login.
export const BROWSER_ENGINE = (process.env.ROYAL_ROAD_BROWSER || "chromium") as "chromium" | "firefox";

// Headless is detected by Cloudflare (the login page never renders), so the
// default is a real browser window. In a container that means running Xvfb and
// pointing DISPLAY at it - see scripts/start.sh in the Tome repo.
export const BROWSER_HEADLESS = process.env.ROYAL_ROAD_HEADLESS === "true";

// Egress proxy for the scraper browser (ROYAL_ROAD_PROXY), e.g.
// http://user:pass@host:3128 or socks5://127.0.0.1:1055.
//
// Cloudflare judges the IP, not the browser: the same Chromium config clears in
// ~2s from a home connection and never clears from a datacenter range such as
// Fly's. Route the browser out through an IP Cloudflare trusts. cf_clearance is
// bound to the exit IP, so the proxy needs a stable one. Chromium cannot do
// SOCKS5 with credentials - use an http:// proxy for those.
export function parseProxy(raw: string): { server: string; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      ...(u.username && { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }),
    };
  } catch {
    // Traffic would silently go out direct and get challenged, so say so loudly.
    console.error("[Config] ROYAL_ROAD_PROXY is not a valid URL - ignoring it");
    return undefined;
  }
}
export const BROWSER_PROXY = parseProxy(process.env.ROYAL_ROAD_PROXY || "");

// Only royalroad.com itself and Cloudflare (its challenge loads from
// challenges.cloudflare.com) need to load in the scraper browser. Every other
// host on a page is ad and analytics traffic - about 50 of the ~125 requests per
// page, measured - that does nothing for a scraper but crowd the exit node's
// link. Blocking it halves the requests and cuts network-idle time from ~6s to
// ~2s with the parsed content unchanged; over a phone's tunnel the saving is
// far bigger.
const FIRST_PARTY_HOST = /(^|\.)(royalroad\.com|cloudflare\.com)$/;

/** True for an http(s) request to a host that is neither Royal Road nor Cloudflare. */
export function isThirdParty(requestUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(requestUrl);
    // data:/blob: (e.g. the challenge's workers) are local, never third parties.
    return (protocol === "http:" || protocol === "https:") && !FIRST_PARTY_HOST.test(hostname);
  } catch {
    return false;
  }
}

// Royal Road
export const ROYAL_ROAD_BASE_URL = "https://www.royalroad.com";
export const ROYAL_ROAD_USERNAME = process.env.ROYAL_ROAD_USERNAME || "";
export const ROYAL_ROAD_PASSWORD = process.env.ROYAL_ROAD_PASSWORD || "";
export const ROYAL_ROAD_AUTO_LOGIN_ENABLED = !!(ROYAL_ROAD_USERNAME && ROYAL_ROAD_PASSWORD);

// Scraper timeouts (hardcoded for reliability - NODE_ENV might not be set)
export const SCRAPER_TIMEOUT = 60000;  // 60 seconds for navigation
export const SCRAPER_SELECTOR_TIMEOUT = 20000;  // 20 seconds for selectors

// Chapter content cache. Royal Road authors edit published chapters, and the
// core default of 30 days makes a corrected chapter invisible for a month, so
// the plugin uses its own shorter window. Override in days via env.
const CHAPTER_CACHE_DAYS = parseInt(process.env.ROYAL_ROAD_CHAPTER_TTL_DAYS || "7", 10);
export const CHAPTER_CACHE_TTL = Math.max(1, CHAPTER_CACHE_DAYS) * 24 * 60 * 60;

// Search results are public and change slowly; caching them keeps a search
// from costing a Playwright navigation every time the form is submitted.
export const SEARCH_CACHE_TTL = 5 * 60;

// How long a failed *automatic* login suppresses further attempts. Cloudflare
// challenging one login POST poisons the browser session for a while, so a
// background retry storm makes things worse. An explicit user action (the
// Settings > Refresh session button) bypasses this entirely.
export const AUTO_LOGIN_COOLDOWN_MS = parseInt(process.env.ROYAL_ROAD_LOGIN_COOLDOWN_MS || String(5 * 60 * 1000), 10);

// Toplists configuration
export const TOPLISTS: ToplistType[] = [
  { slug: 'rising-stars', name: 'Rising Stars', url: `${ROYAL_ROAD_BASE_URL}/fictions/rising-stars` },
  { slug: 'best-rated', name: 'Best Rated', url: `${ROYAL_ROAD_BASE_URL}/fictions/best-rated` },
  { slug: 'weekly-popular', name: 'Weekly Popular', url: `${ROYAL_ROAD_BASE_URL}/fictions/weekly-popular` },
  { slug: 'active-popular', name: 'Active Popular', url: `${ROYAL_ROAD_BASE_URL}/fictions/active-popular` },
];
