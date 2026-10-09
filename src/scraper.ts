/**
 * Hybrid HTTP + Playwright scraper for Royal Road
 * Tries fast HTTP fetch first, falls back to a real browser for Cloudflare challenges
 * Browser fallback can be disabled via ENABLE_BROWSER=false to save resources
 *
 * All HTML parsing lives in ./parsers so it stays pure and testable.
 */
import { parseHTML } from "linkedom";
import { getCache, setCache, deleteCache } from "tome";
import { CACHE_TTL } from "tome";
import {
  getRoyalRoadCookiesForPlaywright,
  hasRoyalRoadSession,
  setRoyalRoadCookie,
  markSessionDead,
  clearSessionState,
  isSessionKnownDead,
} from "./royalroad-credentials";
import { deleteCacheByPrefix } from "./cache";
import {
  ROYAL_ROAD_BASE_URL,
  ROYAL_ROAD_USERNAME,
  ROYAL_ROAD_PASSWORD,
  SCRAPER_TIMEOUT,
  SCRAPER_SELECTOR_TIMEOUT,
  ENABLE_BROWSER,
  BROWSER_ENGINE,
  BROWSER_HEADLESS,
  BROWSER_PROXY,
  isThirdParty,
  CHAPTER_CACHE_TTL,
  SEARCH_CACHE_TTL,
  AUTO_LOGIN_COOLDOWN_MS,
} from "./config";
import { performAutoLogin, ROYAL_ROAD_AUTO_LOGIN_ENABLED } from "./royalroad-auth";
import {
  FICTION_CARD_WAIT_SELECTOR,
  HISTORY_ROW_SELECTOR,
  looksLikeChallenge,
  parseFictionList,
  parseFictionPage,
  parseChapterPage,
  parseCards,
  parseHistoryPage,
  type ParsedCard,
} from "./parsers";

// Playwright types (imported dynamically when ENABLE_BROWSER=true)
type Browser = import("playwright").Browser;
type BrowserContext = import("playwright").BrowserContext;
type Page = import("playwright").Page;
import type { Fiction, FollowedFiction, ChapterContent, ToplistType, HistoryEntry } from "tome";

// Resource types to block for faster page loads (keep images for covers)
// Everything the parser does not need. Images are the big one: a follows page
// references a couple of cover thumbnails per entry and we only ever read the
// src out of the markup, so downloading them just burns the machine's CPU and
// bandwidth (and it makes Cloudflare challenges slower to settle).
const BLOCKED_RESOURCE_TYPES = ['stylesheet', 'font', 'media', 'other', 'image'] as const;

// HTTP fetch user agent (same as Playwright context)
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// How long to sit on a Cloudflare challenge before giving up on it.
//
// The budget is bounded by the reverse proxy, not by patience: Fly cuts a
// request off around 120s, and a request that hangs for two minutes before
// failing is worse than one that fails in thirty. Two attempts at 20s, plus
// navigation, keeps the worst case near a minute.
const CHALLENGE_WAIT_MS = parseInt(process.env.ROYAL_ROAD_CHALLENGE_WAIT_MS || String(20 * 1000), 10);
const CHALLENGE_ATTEMPTS = 2;

/**
 * Caps how many browser fetches run at the same time.
 *
 * A Cloudflare-challenged fetch holds a Chromium page for up to a minute. With
 * the previous unbounded behaviour, a handful of concurrent chapter requests
 * each doing that saturated a 2-CPU machine badly enough that it stopped
 * answering even /health — the app itself, not Royal Road, was the thing that
 * broke.
 */
const MAX_CONCURRENT_BROWSER_FETCHES = parseInt(
  process.env.ROYAL_ROAD_MAX_BROWSER_FETCHES || "4",
  10
);

/** Minimal counting semaphore with an idempotent release. */
class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  /** Resolves once a slot is free; the returned fn frees it again. */
  async acquire(): Promise<() => void> {
    while (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    };
  }
}

const browserSlots = new Semaphore(MAX_CONCURRENT_BROWSER_FETCHES);

// ============ Cache keys ============

/**
 * Core's published `FollowedFiction` (the `tome` package this plugin resolves)
 * lags behind the recency fields Tome's follows card already renders. They are
 * plain optional properties on the same object, so declaring them locally keeps
 * the plugin compiling against any core revision.
 */
export type FollowedFictionWithRecency = FollowedFiction & {
  lastUpdateAgo?: string;
  lastReadAgo?: string;
};

/**
 * Fiction pages are cached per user: they carry the antiforgery token and the
 * reader's own follow/read state, so one user's row must never be served to
 * another. `fiction:<id>:<userId>` also lets a single fiction be invalidated
 * for everyone with a prefix delete.
 */
function fictionCacheKey(id: number | string, userId?: string): string {
  return `fiction:${id}:${userId ?? "anon"}`;
}

// ============ Small helpers ============

async function parallelLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then(() => {
      executing.splice(executing.indexOf(p), 1);
    });
    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

/**
 * Cookies for an HTTP fetch.
 *
 * Note what is deliberately NOT here: a `cf_clearance`. Plain `fetch` from a
 * server is blocked by Cloudflare on its TLS fingerprint, not on its cookies,
 * so re-sending a stored clearance buys nothing — and a clearance that has
 * gone stale makes Cloudflare treat the request as forged. The browser is the
 * only path that gets through, and it earns its own clearance.
 */
function getCookiesForFetch(userId?: string): string {
  if (!userId) return "";
  return getRoyalRoadCookiesForPlaywright(userId)
    .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Persist cookies learned from a browser visit. Royal Road rotates the
 * session cookie on use, so keeping the freshest copy stops the fast HTTP
 * path from drifting into "logged out" on a long-lived deployment.
 *
 * The Cloudflare clearance is deliberately not saved: it is bound to this
 * machine's IP, and a stored one is stale by the time anything reads it back.
 */
async function rememberCookiesFromBrowser(ctx: BrowserContext, userId?: string): Promise<void> {
  if (!userId) return;
  try {
    const cookies = await ctx.cookies();
    const identity = cookies.find((c) => c.name === ".AspNetCore.Identity.Application");
    if (identity) setRoyalRoadCookie(userId, identity.name, identity.value);
  } catch (e) {
    console.error("Failed to persist cookies from browser context:", e);
  }
}

/**
 * True when a fetched page is Royal Road's login page — i.e. the session was
 * rejected. Called on the *body* as well as the final URL because the redirect
 * to /account/login is not always visible in `response.url`.
 */
function looksLikeLoginPage(html: string, finalUrl?: string): boolean {
  return (
    !!finalUrl?.includes("/account/login") ||
    html.includes('action="/account/login"') ||
    /<title>\s*Sign In\s*\|/i.test(html)
  );
}

// ============ HTTP fast path ============

/**
 * Try fetching a page via HTTP first (fast path, ~100ms).
 * Returns the HTML if it looks like the real page, null when Cloudflare blocks
 * it or the session was rejected.
 */
async function tryHttpFetch(
  url: string,
  userId?: string,
  alreadyRetriedWithLogin?: boolean
): Promise<{ content: string; finalUrl: string } | null> {
  const startTime = Date.now();

  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    };

    // Sent for anonymous requests too: the shared Cloudflare clearance is not
    // user-bound, and skipping it made every public fetch re-challenge.
    const cookieHeader = getCookiesForFetch(userId);
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
    });

    if (!response.ok) {
      console.log(`[Scraper] HTTP fetch failed: ${response.status} in ${Date.now() - startTime}ms`);
      return null;
    }

    const html = await response.text();

    // Check for Cloudflare challenge
    if (looksLikeChallenge(html)) {
      console.log(`[Scraper] Cloudflare challenge detected in ${Date.now() - startTime}ms, need browser`);
      return null;
    }

    // Check for login redirect (cookies not working)
    if (looksLikeLoginPage(html, response.url)) {
      console.warn("[Scraper] HTTP fetch got login page - cookies may be invalid or expired");
      if (userId && !alreadyRetriedWithLogin && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
        console.log("[Scraper] Attempting auto-login before retry...");
        const loggedIn = await performAutoLogin(userId);
        if (loggedIn) {
          return tryHttpFetch(url, userId, true);
        }
      }
      if (userId) markSessionDead(userId);
      return null;
    }

    console.log(`[Scraper] HTTP fetch succeeded in ${Date.now() - startTime}ms`);
    return { content: html, finalUrl: response.url };
  } catch (error) {
    console.error(`[Scraper] HTTP fetch error in ${Date.now() - startTime}ms:`, error);
    return null;
  }
}

/**
 * `page.content()` that survives a navigation in flight, and never returns a
 * half-parsed document. A chapter URL redirects to its canonical form, and
 * reading the page mid-navigation throws "Unable to retrieve content because the
 * page is navigating" - seen on fast links, where it failed a chapter fetch.
 * Simply retrying is worse than the error: the retry can land on the new
 * document while it is still streaming and return a TRUNCATED chapter (36KB of
 * 125KB, measured), which then gets cached. So wait until the current document
 * has finished parsing - waitForFunction re-runs across the navigation - and
 * only then snapshot it.
 */
async function stableContent(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page
        .waitForFunction(() => document.readyState !== "loading", undefined, { timeout: 15_000 })
        .catch(() => {});
      return await page.content();
    } catch (e) {
      if (!/navigating/i.test(String((e as Error)?.message))) throw e;
    }
  }
  return page.content();
}

// ============ Browser lifecycle ============

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let anonContext: BrowserContext | null = null;

/**
 * Auth contexts currently owned by an in-flight request. `createContext`
 * replaces the shared slot on every call (Settings save, cookie validation,
 * auto-login refresh), and must not close a context a concurrent request is
 * still reading pages from.
 */
const inFlightContexts = new Set<BrowserContext>();

async function ensureBrowser(): Promise<void> {
  if (!ENABLE_BROWSER) return;

  if (!browser || !browser.isConnected()) {
    if (browser) {
      console.log("Browser disconnected, reinitializing...");
    }
    browser = null;
    context = null;
    anonContext = null;
    await initBrowser();
  }
}

export async function initBrowser(): Promise<void> {
  if (!ENABLE_BROWSER) {
    console.log("Browser disabled (ENABLE_BROWSER=false)");
    return;
  }

  if (browser) return;

  console.log(`Initializing ${BROWSER_ENGINE} browser (headless=${BROWSER_HEADLESS}, proxy=${BROWSER_PROXY?.server ?? "none"})...`);
  const startTime = Date.now();

  try {
    if (BROWSER_ENGINE === "chromium") {
      // channel "chromium" selects the full browser build; Playwright's default
      // is chromium-headless-shell, which Cloudflare fingerprints easily.
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        channel: "chromium",
        headless: BROWSER_HEADLESS,
        proxy: BROWSER_PROXY,
        args: [
          // Makes navigator.webdriver false, so the stealth init script is only
          // belt-and-braces.
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
        ],
      });
      console.log(`Chromium launched in ${Date.now() - startTime}ms`);
    } else {
      const { firefox } = await import("playwright");
      browser = await firefox.launch({
        headless: true,
        proxy: BROWSER_PROXY,
        firefoxUserPrefs: {
          "browser.cache.disk.enable": false,
          "browser.cache.memory.enable": true,
          "browser.cache.memory.capacity": 32768,
          "browser.sessionhistory.max_entries": 2,
          "browser.sessionstore.max_tabs_undo": 0,
          "media.autoplay.enable": false,
          "media.peerconnection.enable": false,
          "dom.webnotifications.enable": false,
          "geo.enabled": false,
        },
      });
      console.log(`Firefox launched in ${Date.now() - startTime}ms`);
    }
  } catch (error) {
    browser = null;
    console.error(
      `[Scraper] Failed to launch ${BROWSER_ENGINE}: ${(error as Error).message}\n` +
      `  Cloudflare blocks plain HTTP from datacenter IPs, so without a browser ` +
      `every page needs one. Chromium must run headful (ROYAL_ROAD_HEADLESS is ` +
      `${BROWSER_HEADLESS ? "true" : "false"}), which in a container means Xvfb ` +
      `with DISPLAY set - scripts/start.sh does this automatically.`
    );
    throw error;
  }

  await createAnonContext();
  console.log("Browser initialized");
}

export async function createContext(userId: string): Promise<void> {
  if (!ENABLE_BROWSER || !browser) {
    if (ENABLE_BROWSER) await initBrowser();
    return;
  }

  // Close the context this slot held previously, but only when no in-flight
  // request still owns it - otherwise a concurrent page load gets torn down
  // mid-navigation.
  if (context && !inFlightContexts.has(context)) {
    try { await context.close(); } catch {}
  }

  const cookies = getRoyalRoadCookiesForPlaywright(userId)
    // A cf_clearance from another machine is invalid here and poisons the
    // request, so it is dropped rather than loaded.
    .filter((c: { name: string }) => c.name !== "cf_clearance");
  console.log(`Creating context with ${cookies.length} cookies: ${cookies.map((c: { name: string }) => c.name).join(", ")}`);

  // No userAgent override: claiming a Chrome UA from a Firefox build (or from a
  // Chromium whose real version differs) is a fingerprint mismatch that makes
  // Cloudflare reject requests. Let the browser report itself.
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  if (cookies.length > 0) {
    await context.addCookies(cookies);
    console.log(`Loaded ${cookies.length} cookies into auth context`);
  } else {
    console.warn("WARNING: No cookies loaded into auth context!");
  }
}

async function createAnonContext(): Promise<void> {
  if (!ENABLE_BROWSER || !browser) {
    if (ENABLE_BROWSER) await initBrowser();
    return;
  }

  if (anonContext) {
    await anonContext.close();
  }

  // Deliberately cookie-free. A cf_clearance is bound to the IP and browser
  // that solved the challenge; re-sending a stored one makes Cloudflare treat
  // the request as forged and serve a challenge that never clears. The browser
  // earns a fresh clearance on its first successful navigation.
  anonContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  await anonContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  console.log("Anonymous context created (for caching without auth)");
}

// ============ Auto-login ============

let lastBrowserLoginAttempt = 0;
// Cloudflare challenges the login POST and, when it does not clear, the whole
// browser session stays challenged afterwards (even /home times out). Retrying
// on every login redirect therefore makes things worse, so background attempts
// back off. An explicit user action (Settings > Refresh session) passes
// `force` and skips the backoff entirely.
export async function performBrowserLogin(userId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!ENABLE_BROWSER) {
    console.warn("[AutoLogin] Browser login needs ENABLE_BROWSER=true");
    return false;
  }
  if (!ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
    console.error("[AutoLogin] ROYAL_ROAD_USERNAME / ROYAL_ROAD_PASSWORD are not configured");
    return false;
  }
  if (!opts.force && Date.now() - lastBrowserLoginAttempt < AUTO_LOGIN_COOLDOWN_MS) {
    console.warn(
      "[AutoLogin] Skipping browser login (attempted recently). " +
      "A fresh session cookie in Settings is the reliable path."
    );
    return false;
  }
  lastBrowserLoginAttempt = Date.now();

  await ensureBrowser();
  if (!browser) {
    console.error("[AutoLogin] No browser available");
    return false;
  }

  const startTime = Date.now();
  console.log(`[AutoLogin] Logging in to Royal Road via ${BROWSER_ENGINE}...`);

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  const page = await ctx.newPage();
  try {
    await page.goto(`${ROYAL_ROAD_BASE_URL}/account/login?returnurl=%2Fhome`, {
      waitUntil: "domcontentloaded",
      timeout: SCRAPER_TIMEOUT,
    });
    await page.waitForSelector('input[name="Email"]', { timeout: SCRAPER_SELECTOR_TIMEOUT });

    await page.fill('input[name="Email"]', ROYAL_ROAD_USERNAME);
    await page.fill('input[name="Password"]', ROYAL_ROAD_PASSWORD);
    // Scope to the credentials form: the social sign-in buttons are also
    // <button type="submit"> and come first in the DOM, so an unscoped click
    // signs in with Google (or bounces to /account/externallogin).
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: SCRAPER_TIMEOUT }).catch(() => {}),
      page.click('form:has(input[name="Password"]) button[type="submit"]:not([name="provider"])'),
    ]);

    // The submit triggers a navigation (and sometimes a brief Cloudflare
    // interstitial), so poll for the cookie rather than sampling once: right
    // after the click the page is still the login form.
    let identity = null;
    const deadline = Date.now() + SCRAPER_SELECTOR_TIMEOUT;
    while (Date.now() < deadline) {
      identity = (await ctx.cookies()).find((c) => c.name === ".AspNetCore.Identity.Application");
      if (identity) break;
      await page.waitForTimeout(1500);
    }

    if (!identity) {
      const title = await page.title().catch(() => "");
      const stuck = /just a moment/i.test(title);
      console.error(
        stuck
          ? "[AutoLogin] Cloudflare is challenging the login submission and is not clearing it. " +
            "Paste a fresh session cookie in Settings > Royal Road instead."
          : `[AutoLogin] Login did not produce a session cookie (landed on "${title || page.url()}") - ` +
            "check ROYAL_ROAD_USERNAME/PASSWORD"
      );
      return false;
    }

    setRoyalRoadCookie(userId, identity.name, identity.value);
    const clearance = (await ctx.cookies()).find((c) => c.name === "cf_clearance");
    if (clearance) setRoyalRoadCookie(userId, "cf_clearance", clearance.value);
    clearSessionState(userId);

    // Confirm the session actually works: a valid cookie still gets redirected
    // to the login page when the account was logged out or the cookie rejected.
    await page.goto(`${ROYAL_ROAD_BASE_URL}/my/follows`, {
      waitUntil: "domcontentloaded",
      timeout: SCRAPER_TIMEOUT,
    });
    if (page.url().includes("/account/login")) {
      console.error("[AutoLogin] Still redirected to login after signing in - session was not accepted");
      return false;
    }

    console.log(`[AutoLogin] Logged in via ${BROWSER_ENGINE} in ${Date.now() - startTime}ms`);
    return true;
  } catch (e) {
    console.error(`[AutoLogin] Browser login failed after ${Date.now() - startTime}ms:`, e);
    return false;
  } finally {
    try { await ctx.close(); } catch {}
  }
}

/**
 * A page Royal Road answered but that is not the content we asked for: a
 * Cloudflare interstitial, a redirect still in flight, or a bare error page.
 *
 * Caching one of these is far worse than failing — an empty chapter would be
 * served from cache for days — so the caller throws and the request can simply
 * be retried.
 */
function assertHasContent(label: string, content: string, probe: RegExp): void {
  if (probe.test(content)) return;

  if (looksLikeChallenge(content)) {
    const title = (content.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(
      `Cloudflare blocked the request for ${label}` +
      (title ? ` (page: "${title}")` : "") +
      `. Cloudflare judges the server's IP, so this is not something the plugin ` +
      `can work around — retrying will not help.`
    );
  }

  const title = (content.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, ' ')
    .trim();
  throw new Error(
    `Royal Road returned a page without ${label}` +
    (title ? ` (title: "${title}")` : "") +
    `. The chapter may be removed, or subscriber-only.`
  );
}

/** Probes for the anchor element each page type must contain. */
const CONTENT_PROBE = {
  chapter: /class="[^"]*\bchapter-content\b/,
  fiction: /class="[^"]*\bfic-title\b/,
  list: /class="[^"]*\bfiction-list\b/,
};

/**
 * Background chapter pre-caching, serialised so it never runs concurrently
 * with a live read on the shared browser context.
 */
let preCacheChain: Promise<void> = Promise.resolve();

// ============ Page fetching ============

export interface GetPageOptions {
  /** Set once an auto-login retry has already been attempted. */
  alreadyRetriedWithLogin?: boolean;
  /**
   * True for pages Royal Road serves to logged-out visitors (fiction, chapter,
   * search, toplists). When the stored session is rejected, these fall back to
   * an anonymous fetch instead of returning the login page or throwing.
   * Private pages (follows, read-later, history) leave it false so the caller
   * gets a real error telling the user to re-authenticate.
   */
  allowAnonymous?: boolean;
}

export /**
 * Wait for an in-flight Cloudflare challenge to finish, in place.
 *
 * Re-navigating restarts the challenge and burns an attempt, so the page is
 * left alone and polled until it stops naming a challenge. A managed challenge
 * on a cold browser can take a while to run, so the wait is generous and
 * success is also accepted when the URL leaves the challenge host.
 */
async function waitForChallengeToClear(page: Page, url: string, waitMs: number = CHALLENGE_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  const challengeHost = new URL(url).hostname;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    try {
      // Cloudflare redirects to the real page once the challenge passes.
      if (!page.url().includes("challenges.cloudflare.com") && page.url().includes(challengeHost)) {
        const title = await page.title();
        if (!/just a moment|attention required|checking your browser|cloudflare/i.test(title)) {
          return true;
        }
      }
    } catch {
      // Page navigated underneath us — that is the challenge clearing.
      return true;
    }
  }
  return false;
}

export async function getPage(
  url: string,
  waitForSelector?: string,
  userId?: string,
  opts: GetPageOptions = {}
): Promise<{ page: Page | null; content: string; release: () => Promise<void> }> {
  const startTime = Date.now();
  const allowAnonymous = opts.allowAnonymous === true;
  const hasSession = userId ? hasRoyalRoadSession(userId) : false;

  if (userId && !hasSession && !allowAnonymous) {
    // Prefer the browser login: the HTTP login cannot get past Cloudflare.
    if (ENABLE_BROWSER && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
      console.log("[Scraper] No session found, attempting auto-login...");
      if (!(await performBrowserLogin(userId))) {
        throw new Error("Auto-login failed. Please configure your Royal Road session manually.");
      }
    } else if (ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
      const loggedIn = await performAutoLogin(userId);
      if (!loggedIn) {
        throw new Error("Auto-login failed. Please configure your Royal Road session manually.");
      }
    } else {
      throw new Error("Session cookies not configured. Please set up your Royal Road cookies first.");
    }
  }

  // With a public page and no usable session, go straight to anonymous: there
  // is nothing an authenticated fetch would add. The shared Cloudflare
  // clearance still goes out (see getCookiesForFetch).
  const wantAuth = !!userId && hasSession && !(allowAnonymous && isSessionKnownDead(userId));
  console.log(`[Scraper] Trying HTTP fetch for ${url} (${wantAuth ? 'auth' : 'anon'})`);

  const httpResult = await tryHttpFetch(url, wantAuth ? userId : undefined);
  if (httpResult) {
    if (wantAuth && looksLikeLoginPage(httpResult.content, httpResult.finalUrl)) {
      // Rejected after an auto-login retry already failed inside tryHttpFetch.
      if (allowAnonymous) {
        console.warn(`[Scraper] Session rejected for ${url} - retrying anonymously`);
      } else {
        throw new Error(
          "Royal Road rejected the stored session. " +
          "Paste a fresh .AspNetCore.Identity.Application cookie in Settings > Royal Road."
        );
      }
    } else {
      if (wantAuth) clearSessionState(userId);
      console.log(`[Scraper] HTTP fetch succeeded in ${Date.now() - startTime}ms total`);
      return { page: null, content: httpResult.content, release: async () => {} };
    }
  }

  if (!ENABLE_BROWSER) {
    throw new Error("HTTP fetch failed and browser fallback is disabled (ENABLE_BROWSER=false). Cloudflare may be blocking requests.");
  }

  console.log(`[Scraper] Falling back to the browser for ${url}`);

  await ensureBrowser();

  if (!anonContext) {
    throw new Error("Browser contexts not initialized");
  }

  // The anonymous context serves both anonymous requests and the fallback for
  // a rejected session, so a public page never depends on auth at all.
  let useAnon = !wantAuth || allowAnonymous;
  let ctx: BrowserContext | null = useAnon ? anonContext : context;

  if (!useAnon && userId) {
    await createContext(userId);
    if (!context) {
      throw new Error("Failed to create authenticated browser context");
    }
    ctx = context;
  }

  if (!ctx) {
    throw new Error("No browser context available");
  }

  // This request owns every auth context it creates; close them all when it
  // returns/throws so concurrent requests never close each other's context.
  const requestContexts: BrowserContext[] = [];
  if (!useAnon && ctx) {
    inFlightContexts.add(ctx);
    requestContexts.push(ctx);
  }

  const blockResources = (p: Page) => p.route('**/*', (route) => {
    const request = route.request();
    // The page's own navigation is never blocked, whatever host a redirect lands
    // on; ad iframes are sub-frame navigations and stay blocked.
    const pageNavigation = request.isNavigationRequest() && request.frame() === p.mainFrame();
    if (
      BLOCKED_RESOURCE_TYPES.includes(request.resourceType() as any) ||
      (!pageNavigation && isThirdParty(request.url()))
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // Hold a slot for as long as this request owns a page. Released from
  // closeOwned, which every return and error path funnels through.
  const releaseSlot = await browserSlots.acquire();

  const closeOwned = async () => {
    releaseSlot();
    for (const c of requestContexts) {
      inFlightContexts.delete(c);
      try { await c.close(); } catch {}
    }
  };

  let page = await ctx.newPage();
  await blockResources(page);

  try {
    let attempts = 0;
    let sessionReset = false;
    const maxAttempts = CHALLENGE_ATTEMPTS;

    while (attempts < maxAttempts) {
      attempts++;
      console.log(`[Scraper] Browser fetching ${url} (attempt ${attempts})`);

      const navStart = Date.now();
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: SCRAPER_TIMEOUT
      });
      console.log(`[Scraper] Navigation completed in ${Date.now() - navStart}ms`);

      let pageContent = await stableContent(page);

      // Cloudflare's current interstitial is a bare "Just a moment..." shell
      // that loads its challenge in JS, so the old markers above match nothing
      // and a content snapshot taken right after domcontentloaded can catch the
      // pre-redirect page. Let the challenge finish in place, then re-read —
      // a fresh goto would restart it and burn an attempt.
      if (looksLikeChallenge(pageContent)) {
        console.log(`[Scraper] Cloudflare challenge on ${url} (attempt ${attempts}), waiting for it to clear...`);
        // The shared anonymous context keeps Cloudflare cookies bound to the exit
        // IP that earned them. Behind an exit node whose IP moves (a phone hopping
        // between Wi-Fi and mobile data) Cloudflare then challenges that stale
        // session for good, so a long first wait is wasted: give it a short one,
        // drop the cookies and retry clean.
        const canResetSession = useAnon && attempts < maxAttempts;
        await waitForChallengeToClear(page, url, canResetSession ? Math.min(CHALLENGE_WAIT_MS, 8000) : CHALLENGE_WAIT_MS);
        pageContent = await stableContent(page);

        if (looksLikeChallenge(pageContent)) {
          if (attempts >= maxAttempts) break;
          if (canResetSession) {
            await ctx.clearCookies().catch(() => {});
            sessionReset = true;
          }
          continue;
        }
      }
      if (sessionReset) {
        console.log(`[Scraper] ${url} cleared after dropping the shared session's cookies - the exit IP most likely changed`);
        sessionReset = false;
      }

      if (looksLikeLoginPage(pageContent, page.url())) {
        console.warn("[Scraper] WARNING: Redirected to login page - cookies may be invalid or expired!");
        if (userId && !opts.alreadyRetriedWithLogin && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
          markSessionDead(userId);
          await page.close();
          console.log("[Scraper] Attempting auto-login before retry...");
          const loggedIn = ENABLE_BROWSER
            ? await performBrowserLogin(userId)
            : await performAutoLogin(userId);
          // Always rebuild the page: it was just closed above, so retrying on
          // it fails with "Target page, context or browser has been closed".
          if (!loggedIn) {
            if (allowAnonymous) {
              // A public page still renders for a logged-out visitor, which is
              // far better than an error page - just without personal state.
              console.warn(`[Scraper] Could not restore the session; serving ${url} anonymously`);
              useAnon = true;
              ctx = anonContext;
              await closeOwned();
              page = await ctx.newPage();
              await blockResources(page);
              continue;
            }
            throw new Error(
              "Royal Road rejected the stored session and auto-login could not restore it. " +
              "Paste a fresh .AspNetCore.Identity.Application cookie in Settings > Royal Road."
            );
          }
          await createContext(userId);
          ctx = context!;
          await closeOwned();
          inFlightContexts.add(ctx);
          requestContexts.push(ctx);
          page = await ctx.newPage();
          await blockResources(page);
          continue;
        }

        if (allowAnonymous) {
          console.warn(`[Scraper] Login redirect on a public page - serving ${url} anonymously`);
          useAnon = true;
          ctx = anonContext;
          await closeOwned();
          page = await ctx.newPage();
          await blockResources(page);
          continue;
        }

        if (userId) markSessionDead(userId);
        throw new Error(
          "Royal Road rejected the stored session. " +
          "Paste a fresh .AspNetCore.Identity.Application cookie in Settings > Royal Road."
        );
      }

      if (waitForSelector) {
        try {
          const selectorStart = Date.now();
          await page.waitForSelector(waitForSelector, { timeout: SCRAPER_SELECTOR_TIMEOUT });
          console.log(`[Scraper] Selector "${waitForSelector}" found in ${Date.now() - selectorStart}ms`);
        } catch {
          console.log(`[Scraper] Selector "${waitForSelector}" not found, continuing anyway`);
        }
      }

      const content = await stableContent(page);
      console.log(`[Scraper] Browser page fetched in ${Date.now() - startTime}ms total`);
      await rememberCookiesFromBrowser(ctx, wantAuth ? userId : undefined);
      const release = async () => {
        try { await page.close(); } catch {}
        await closeOwned();
      };
      return { page, content, release };
    }

    throw new Error(
      "Cloudflare would not let the browser through after several attempts. " +
      "Cloudflare is judging the server's IP address, so waiting longer will not " +
      "help — this needs a network Cloudflare trusts, not a code change."
    );
  } catch (error) {
    try { await page.close(); } catch {}
    await closeOwned();
    throw error;
  }
}

/**
 * Resolve a redirect URL to get the final URL (used for /chapter/next/ URLs).
 *
 * Uses `redirect: "manual"` and reads the Location header rather than following
 * the redirect, because `response.url` silently returns the *requested* URL when
 * the server refuses the request (Cloudflare answering 403, or a 405 for HEAD).
 * That used to make `/chapter/next/192682` resolve to chapter id 192682 - the
 * fiction id - which pointed the Follows "read next" button at a chapter that
 * does not exist.
 */
async function resolveRedirectUrl(url: string, userId?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    const cookieHeader = getCookiesForFetch(userId);
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const response = await fetch(url, { method: "GET", redirect: "manual", headers });

    const location = response.headers.get("location");
    if (location) {
      return new URL(location, url).toString();
    }

    // Some servers answer the redirect without a Location; fall back to the
    // final URL, but only trust it when it actually moved.
    if (response.url && response.url !== url && response.url !== `${url}/`) {
      return response.url;
    }
    return null;
  } catch (error) {
    console.error(`Failed to resolve redirect for ${url}:`, error);
    return null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (!ENABLE_BROWSER) return;

  if (anonContext) {
    await anonContext.close();
    anonContext = null;
  }
  if (context) {
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
}

if (ENABLE_BROWSER) {
  process.on("exit", () => {
    closeBrowser();
  });
}

// ============ Scraper Functions ============

/** Map a parsed card onto the shared FollowedFiction shape. */
function toFollowedFiction(card: ParsedCard): FollowedFictionWithRecency {
  return {
    id: card.id,
    title: card.title,
    author: card.author,
    url: card.href,
    coverUrl: card.coverUrl,
    hasUnread: card.hasUnread,
    latestChapter: card.latestChapter,
    latestChapterId: card.latestChapterId,
    lastRead: card.lastRead,
    lastReadChapterId: card.lastReadChapterId,
    nextChapterId: card.nextChapterId,
    nextChapterTitle: card.nextChapterTitle,
    lastUpdateAgo: card.lastUpdateAgo,
    lastReadAgo: card.lastReadAgo,
  };
}

export async function getFollows(userId: string, ttl: number = CACHE_TTL.FOLLOWS): Promise<FollowedFiction[]> {
  const cacheKey = `follows:${userId}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log("Returning cached follows");
    return JSON.parse(cached);
  }

  const { content, release } = await getPage(
    `${ROYAL_ROAD_BASE_URL}/my/follows`,
    FICTION_CARD_WAIT_SELECTOR,
    userId,
  );
  await release();

  const cards = parseCards(content);
  console.log(`Found ${cards.length} fiction cards`);

  // Carry the unresolved redirect target alongside each row so the parallel
  // resolver below can find it without a second parse.
  const fictions = cards.map((card) => ({
    ...toFollowedFiction(card),
    ...(card.nextChapterResolveUrl ? { __resolveUrl: card.nextChapterResolveUrl } : {}),
  })) as (FollowedFiction & { __resolveUrl?: string })[];

  // Resolve /chapter/next/ redirect URLs to get actual chapter IDs
  const needing = fictions.filter((f) => !!f.__resolveUrl && !f.nextChapterId);

  if (needing.length > 0) {
    const startTime = Date.now();
    console.log(`Resolving ${needing.length} next chapter redirect URLs (parallel, max 10)...`);

    await parallelLimit(needing, 10, async (fiction) => {
      const resolve = fiction.__resolveUrl;
      if (!resolve) return;

      try {
        const finalUrl = await resolveRedirectUrl(resolve, userId);
        const chapterId = finalUrl ? finalUrl.match(/\/chapter\/(\d+)/)?.[1] : undefined;

        // The redirect target must be a chapter *other than* the fiction id
        // that was in the /chapter/next/<id> path. Anything else means the
        // redirect never resolved (challenge, 405, ...) and the id we read is
        // the fiction's own, which would link to a chapter that does not exist.
        const requestedFictionId = resolve.match(/\/chapter\/next\/(\d+)/)?.[1];
        if (chapterId && chapterId !== requestedFictionId) {
          fiction.nextChapterId = parseInt(chapterId, 10);
        } else if (chapterId) {
          console.warn(
            `[Scraper] Next-chapter redirect for "${fiction.title}" did not resolve ` +
            `(got ${chapterId}, same as the fiction id) - leaving the read link unset`
          );
        }
      } catch (e) {
        console.error(`Failed to resolve next chapter URL for "${fiction.title}":`, e);
      }
    });

    console.log(`Resolved ${needing.length} redirect URLs in ${Date.now() - startTime}ms`);
  }

  if (fictions.length > 0) {
    setCache(cacheKey, JSON.stringify(fictions), ttl);
  }

  return fictions;
}

export async function getHistory(userId: string): Promise<HistoryEntry[]> {
  const { content, release } = await getPage(
    `${ROYAL_ROAD_BASE_URL}/my/history`,
    HISTORY_ROW_SELECTOR,
    userId,
  );
  await release();

  const history = parseHistoryPage(content);
  console.log(`Found ${history.length} history items`);
  console.log(`Parsed ${history.length} history entries`);
  return history;
}

export async function getReadLater(userId: string, ttl: number = CACHE_TTL.FOLLOWS): Promise<Fiction[]> {
  const cacheKey = `readlater:${userId}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log("Returning cached read later");
    return JSON.parse(cached);
  }

  const { content, release } = await getPage(
    `${ROYAL_ROAD_BASE_URL}/my/readlater`,
    FICTION_CARD_WAIT_SELECTOR,
    userId,
  );
  await release();

  const cards = parseCards(content);
  console.log(`Found ${cards.length} read later items`);

  const fictions: Fiction[] = cards.map((card) => ({
    id: card.id,
    title: card.title,
    author: card.author,
    url: card.href,
    coverUrl: card.coverUrl,
    description: card.description,
    stats: card.pageCount ? { pages: card.pageCount } : undefined,
  }));

  if (fictions.length > 0) {
    setCache(cacheKey, JSON.stringify(fictions), ttl);
  }

  return fictions;
}

export async function getToplist(toplist: ToplistType, userId?: string, ttl: number = CACHE_TTL.TOPLIST): Promise<Fiction[]> {
  const cacheKey = `toplist:${toplist.slug}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`Returning cached toplist: ${toplist.slug}`);
    return JSON.parse(cached);
  }

  const { content, release } = await getPage(toplist.url, ".fiction-list", userId);
  await release();

  assertHasContent("the fiction list", content, CONTENT_PROBE.list);
  const fictions = parseFictionList(content);

  if (fictions.length > 0) {
    setCache(cacheKey, JSON.stringify(fictions), ttl);
  }

  return fictions;
}

export function getToplistCached(toplist: ToplistType): Fiction[] | null {
  const cacheKey = `toplist:${toplist.slug}`;
  const cached = getCache(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  return null;
}

export async function getFiction(id: number, userId?: string, ttl: number = CACHE_TTL.FICTION): Promise<Fiction | null> {
  const cacheKey = fictionCacheKey(id, userId);
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`Returning cached fiction: ${id}`);
    return JSON.parse(cached);
  }

  const url = `${ROYAL_ROAD_BASE_URL}/fiction/${id}`;
  const { content, release } = await getPage(url, ".fic-title", userId, { allowAnonymous: true });
  await release();

  assertHasContent("the fiction header", content, CONTENT_PROBE.fiction);

  // Chapters come from the window.chapters script array, which the parser
  // reads out of the HTML. There is deliberately no page.evaluate() here: it
  // needs the browser page alive, and the HTTP fast path has none, so the two
  // paths used to disagree on the chapter list.
  const parsed = parseFictionPage(content, id, url);

  setCache(cacheKey, JSON.stringify(parsed.fiction), ttl);
  return parsed.fiction;
}

export async function getChapter(
  chapterId: number,
  userId?: string,
  ttl?: number,
  opts?: { forceLive?: boolean }
): Promise<ChapterContent | null> {
  const cacheKey = `chapter:${chapterId}`;
  const isPreCaching = ttl !== undefined;

  // Cache-first on every path. The reader's live GETs used to skip the cache
  // entirely (only pre-caching consulted it), so every chapter read re-scraped
  // Royal Road from scratch and never reused the cached row. Only the
  // mark-as-read path (forceLive) must hit upstream — that's how RR records
  // read state.
  if (!opts?.forceLive) {
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`Returning cached chapter: ${chapterId}`);
      return JSON.parse(cached);
    }
  }

  const { page, content, release } = await getPage(
    `${ROYAL_ROAD_BASE_URL}/fiction/0/chapter/${chapterId}`,
    ".chapter-content",
    userId,
    { allowAnonymous: true },
  );

  // Royal Road records a chapter as read from a short-lived AJAX call fired
  // once the page has loaded, so on the browser path give it a moment before
  // tearing the page down. Skipped when pre-caching: marking a chapter read
  // because the warmer visited it would be wrong.
  if (page && !isPreCaching) {
    await page.waitForTimeout(2000);
  }
  await release();

  assertHasContent("chapter content", content, CONTENT_PROBE.chapter);

  const parsed = parseChapterPage(content, chapterId);
  const navInfo = { prevUrl: parsed.prevChapterUrl ?? null, nextUrl: parsed.nextChapterUrl ?? null };
  const fictionInfo = {
    fictionId: parsed.fictionId,
    fictionTitle: parsed.fictionTitle,
    fictionUrl: parsed.fictionId ? `/fiction/${parsed.fictionId}` : "",
  };

  // Convert nav URLs to proxy URLs
  const prevChapterUrl = navInfo.prevUrl ? navInfo.prevUrl.replace(/.*\/chapter\/(\d+).*/, "/chapter/$1") : undefined;
  const nextChapterUrl = navInfo.nextUrl ? navInfo.nextUrl.replace(/.*\/chapter\/(\d+).*/, "/chapter/$1") : undefined;

  // Extract next chapter ID for pre-caching
  const nextChapterIdMatch = nextChapterUrl?.match(/\/chapter\/(\d+)/);
  const nextChapterId = nextChapterIdMatch ? parseInt(nextChapterIdMatch[1], 10) : undefined;

  const result: ChapterContent = {
    id: chapterId,
    fictionId: fictionInfo.fictionId,
    title: parsed.title,
    content: parsed.content,
    prevChapterUrl,
    nextChapterUrl,
    fictionTitle: fictionInfo.fictionTitle,
    fictionUrl: `/fiction/${fictionInfo.fictionId}`,
  };

  setCache(cacheKey, JSON.stringify(result), ttl ?? CHAPTER_CACHE_TTL);

  if (!isPreCaching && userId) {
    // Invalidate this user's fiction row so the fiction page shows fresh
    // read/continue state. Scoped by prefix: only this fiction, only this user.
    if (fictionInfo.fictionId) {
      const staleFictionKey = fictionCacheKey(fictionInfo.fictionId, userId);
      if (deleteCache(staleFictionKey)) {
        console.log(`Invalidated fiction cache: ${staleFictionKey}`);
      }
    }
    const followsCacheKey = `follows:${userId}`;
    if (deleteCache(followsCacheKey)) {
      console.log(`Invalidated follows cache`);
    }
  }

  if (nextChapterId && !isPreCaching) {
    console.log(`Pre-caching next chapter: ${nextChapterId}`);
    // Serialised: the warmer shares the anonymous browser context with live
    // reads, and concurrent pages on it stall behind each other's navigations.
    preCacheChain = preCacheChain
      .then(async () => {
        await getChapter(nextChapterId, userId, CHAPTER_CACHE_TTL);
      })
      .catch((e) => console.error(`Failed to pre-cache chapter ${nextChapterId}:`, e));
  }

  return result;
}

export async function validateCookies(userId: string): Promise<boolean> {
  try {
    await createContext(userId);
    const { content, release } = await getPage(`${ROYAL_ROAD_BASE_URL}/my/follows`, undefined, userId);
    await release();

    // A rejected session lands on the login page, whose title is "Sign In".
    const valid = !looksLikeLoginPage(content) && !content.includes("Sign In");

    if (!valid) {
      markSessionDead(userId);
      if (ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
        console.log("[Scraper] Cookie validation failed, attempting auto-login...");
        const loggedIn = await performAutoLogin(userId);
        if (loggedIn) {
          clearSessionState(userId);
          await createContext(userId);
          const { content: retryContent, release: retryRelease } = await getPage(
            `${ROYAL_ROAD_BASE_URL}/my/follows`,
            undefined,
            userId,
            { alreadyRetriedWithLogin: true },
          );
          await retryRelease();
          const retryValid = !looksLikeLoginPage(retryContent) && !retryContent.includes("Sign In");
          if (!retryValid) markSessionDead(userId);
          return retryValid;
        }
      }
    } else {
      clearSessionState(userId);
    }

    return valid;
  } catch (e) {
    console.error("Cookie validation failed:", e);
    return false;
  }
}

export async function searchFictions(query: string, userId?: string): Promise<Fiction[]> {
  const encodedQuery = encodeURIComponent(query);
  const cacheKey = `search:${query.trim().toLowerCase()}`;

  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`Returning cached search: ${query}`);
    return JSON.parse(cached);
  }

  const searchUrl = `${ROYAL_ROAD_BASE_URL}/fictions/search?title=${encodedQuery}`;

  const { content, release } = await getPage(searchUrl, ".fiction-list-item", userId, { allowAnonymous: true });
  await release();

  const fictions = parseFictionList(content);

  if (fictions.length > 0) {
    // Cache the empty result too, otherwise a no-hit search re-scrapes forever.
    setCache(cacheKey, JSON.stringify(fictions), SEARCH_CACHE_TTL);
  }

  return fictions;
}

export async function setBookmark(
  userId: string,
  fictionId: number,
  type: "follow" | "favorite" | "ril",
  mark: boolean,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  const url = `${ROYAL_ROAD_BASE_URL}/fictions/setbookmark/${fictionId}`;

  const formData = new URLSearchParams();
  formData.append("type", type);
  formData.append("mark", mark ? "True" : "False");
  formData.append("__RequestVerificationToken", csrfToken);

  try {
    console.log(`[Scraper] Setting bookmark: fiction=${fictionId}, type=${type}, mark=${mark}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": getCookiesForFetch(userId),
        "User-Agent": USER_AGENT,
      },
      body: formData.toString(),
      redirect: "manual",  // Don't follow redirects automatically
    });

    // Success is typically 200 or 302 redirect
    if (response.ok || response.status === 302) {
      console.log(`[Scraper] Bookmark set successfully`);

      // Invalidate caches so we get fresh state. Fiction rows are per user, so
      // drop every user's copy of this fiction — the antiforgery token and the
      // follow state are both stale now.
      deleteCacheByPrefix(`fiction:${fictionId}:`);
      deleteCache(`follows:${userId}`);
      deleteCache(`readlater:${userId}`);

      return { success: true };
    }

    if (response.status === 400 || response.status === 403) {
      console.error(`[Scraper] Bookmark rejected (${response.status}) - stale antiforgery token or session`);
      markSessionDead(userId);
      return {
        success: false,
        error: "Royal Road rejected the request. Re-open the fiction page to refresh your session.",
      };
    }

    console.error(`[Scraper] Bookmark failed with status: ${response.status}`);
    return { success: false, error: `Request failed (${response.status})` };
  } catch (error) {
    console.error(`[Scraper] Bookmark error:`, error);
    return { success: false, error: "Network error" };
  }
}
