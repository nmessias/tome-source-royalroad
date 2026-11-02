/**
 * Playwright scraper for Royal Road.
 *
 * There is deliberately no HTTP fast path. A TLS-impersonating client (impit)
 * used to serve most pages, but Royal Road's Cloudflare now serves it a managed
 * JS challenge no matter the User-Agent, so the browser is the only transport
 * that works. It runs headless with the real Chrome version in the UA and is
 * kept warm: the first fetch pays browser start-up, later ones do not.
 *
 * All HTML parsing lives in ./parsers so it stays pure and testable.
 */
import { parseHTML } from "linkedom";
import { execFileSync } from "node:child_process";
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
  BROWSER_USER_AGENT,
  BROWSER_PROXY,
  isThirdParty,
  isUnreachable,
  CHAPTER_CACHE_TTL,
  SEARCH_CACHE_TTL,
  AUTO_LOGIN_COOLDOWN_MS,
  ROYAL_ROAD_AUTO_LOGIN_ENABLED,
} from "./config";
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

// Resource types to block for faster page loads. Everything the parser does
// not need:
// - images/fonts/media: covers are read out of the markup, never downloaded
// - stylesheets: we parse HTML, so layout is pure cost
// - scripts: Royal Road renders chapter and list pages server-side. Running the
//   site's JS (analytics, ads, live widgets) only burns the single vCPU that the
//   next navigation needs. Cloudflare's own challenge assets are exempt in
//   blockResources, so an interstitial can still solve itself.
const BLOCKED_RESOURCE_TYPES = ['stylesheet', 'font', 'media', 'other', 'image', 'script'] as const;

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
  process.env.ROYAL_ROAD_MAX_BROWSER_FETCHES || "2",
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

// ============ Stale-if-error ============

/** How long the last good copy of a list or page is kept for when a live fetch fails. */
const STALE_TTL = 30 * 24 * 60 * 60;
const staleKey = (key: string) => `stale:${key}`;

/** setCache, plus a long-lived copy that outlives the normal TTL. */
function setCacheWithStale(key: string, value: string, ttl: number): void {
  setCache(key, value, ttl);
  setCache(staleKey(key), value, STALE_TTL);
}

/**
 * Run a live fetch; when Royal Road cannot be reached - e.g. the network or an
 * optional proxy is down - serve the last good copy instead of an error page.
 * Rethrows when there is no such copy or the failure is not a connectivity one.
 */
async function orStale<T>(key: string, live: () => Promise<T>): Promise<T> {
  try {
    return await live();
  } catch (e) {
    const stale = isUnreachable(e) ? getCache(staleKey(key)) : null;
    if (stale === null) throw e;
    console.warn(`[Cache] ${key}: Royal Road unreachable (${String((e as Error).message).split("\n")[0].slice(0, 90)}) - serving the last good copy`);
    return JSON.parse(stale) as T;
  }
}

// ============ Small helpers ============

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Persist cookies learned from a browser visit. Royal Road rotates the
 * session cookie on use, so keeping the freshest copy stops the stored
 * credentials from drifting into "logged out" on a long-lived deployment.
 *
 * A `cf_clearance` is deliberately not saved: it is bound to the IP and browser
 * that earned it, and a stored one makes Cloudflare treat later requests as
 * forged.
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

// ============ Challenge handling ============

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
let browserUserAgent: string | undefined;
let context: BrowserContext | null = null;
let contextUserId: string | null = null;
let anonContext: BrowserContext | null = null;

/**
 * Auth contexts currently owned by an in-flight request. `createContext`
 * replaces the shared slot when credentials change and must not close a context
 * a concurrent request is still reading pages from. Counted rather than a plain
 * set because concurrent requests can share the same persistent context.
 */
const inFlightContexts = new Map<BrowserContext, number>();

function retainContext(ctx: BrowserContext): void {
  inFlightContexts.set(ctx, (inFlightContexts.get(ctx) ?? 0) + 1);
}

function releaseContext(ctx: BrowserContext): void {
  const remaining = (inFlightContexts.get(ctx) ?? 0) - 1;
  if (remaining > 0) inFlightContexts.set(ctx, remaining);
  else inFlightContexts.delete(ctx);
}

function isContextInFlight(ctx: BrowserContext): boolean {
  return inFlightContexts.has(ctx);
}

async function ensureBrowser(): Promise<void> {
  if (!ENABLE_BROWSER) return;

  // A launch in flight has already assigned `browser` but not yet its contexts,
  // so awaiting here is what makes a concurrent caller safe.
  if (initPromise) {
    await initPromise;
    return;
  }

  if (!browser || !browser.isConnected()) {
    if (browser) {
      console.log("Browser disconnected, reinitializing...");
    }
    browser = null;
    context = null;
    contextUserId = null;
    anonContext = null;
    await initBrowser();
  }
}

/**
 * User-Agent for the installed Chromium build.
 *
 * Cloudflare rejects the `HeadlessChrome` token that Chrome puts in its UA when
 * headless - that token is the *only* thing it dislikes about headless, and
 * overriding it lets the headless browser through while costing ~100MB less
 * than a headful one plus Xvfb. The version must be the real one: a UA naming a
 * different Chrome than the one making the request is a fingerprint mismatch.
 */
function chromeUserAgent(executablePath: string): string | undefined {
  if (BROWSER_USER_AGENT) return BROWSER_USER_AGENT;
  try {
    const out = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    const version = out.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!version) return undefined;
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  } catch (e) {
    console.warn("[Scraper] Could not read the Chromium version for the User-Agent:", (e as Error).message);
    return undefined;
  }
}

/**
 * In-flight launch. Concurrent callers must not start a second Chromium, and -
 * more subtly - must not treat `browser` as ready before its contexts exist:
 * that produced "Browser contexts not initialized" when the startup cache warm
 * raced the feature's own browser init.
 */
let initPromise: Promise<void> | null = null;

export async function initBrowser(): Promise<void> {
  if (!ENABLE_BROWSER) {
    console.log("Browser disabled (ENABLE_BROWSER=false)");
    return;
  }

  if (browser) return;
  if (initPromise) return initPromise;
  initPromise = launchBrowser().finally(() => {
    initPromise = null;
  });
  return initPromise;
}

async function launchBrowser(): Promise<void> {
  if (browser) return;

  console.log(`Initializing ${BROWSER_ENGINE} browser (headless=${BROWSER_HEADLESS}, proxy=${BROWSER_PROXY?.server ?? "none"})...`);
  const startTime = Date.now();

  try {
    // channel "chromium" selects the full browser build; Playwright's default
    // is chromium-headless-shell, which is a different binary with a different
    // fingerprint.
    const { chromium } = await import("playwright");
    browserUserAgent = chromeUserAgent(chromium.executablePath());
    browser = await chromium.launch({
      channel: "chromium",
      headless: BROWSER_HEADLESS,
      proxy: BROWSER_PROXY,
      args: [
        // Makes navigator.webdriver false, so the stealth init script is only
        // belt-and-braces.
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        // 512MB of RAM total on the production box. One renderer shared by the
        // (max 2) concurrent pages, no GPU process, and a hard cap on V8's heap
        // keep the browser from pushing the machine into swap-less thrashing.
        "--renderer-process-limit=1",
        "--disable-site-isolation-trials",
        "--disable-gpu",
        "--js-flags=--max-old-space-size=128",
        // Without this, headless Chrome advertises "HeadlessChrome/<version>"
        // and Cloudflare answers with a managed challenge that never clears.
        ...(browserUserAgent ? [`--user-agent=${browserUserAgent}`] : []),
      ],
    });
    console.log(`Chromium launched in ${Date.now() - startTime}ms (ua=${browserUserAgent ?? "default"})`);
  } catch (error) {
    browser = null;
    console.error(
      `[Scraper] Failed to launch ${BROWSER_ENGINE}: ${(error as Error).message}\n` +
      `  The browser is the only transport Royal Road accepts. Check that the ` +
      `Playwright Chromium build is installed (bunx playwright install chromium).`
    );
    throw error;
  }

  await createAnonContext();
  console.log("Browser initialized");
}

export async function createContext(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<BrowserContext | null> {
  if (!ENABLE_BROWSER || !browser) {
    if (ENABLE_BROWSER) await initBrowser();
    return null;
  }

  // Keep the context (and the Cloudflare clearance it earned) for the same
  // user. Recreating it on every request forced a fresh JS challenge on every
  // authenticated page. Credential changes and auto-login pass force=true.
  if (!opts.force && context && contextUserId === userId) {
    return context;
  }

  // Close the context this slot held previously, but only when no in-flight
  // request still owns it - otherwise a concurrent page load gets torn down
  // mid-navigation. A replaced in-flight context is closed when its request
  // releases it (see releaseRequestContext in getPage).
  if (context && !isContextInFlight(context)) {
    try { await context.close(); } catch {}
  }
  contextUserId = null;

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
  contextUserId = userId;

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

  return context;
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
      `. The browser fallback could not clear the challenge either.`
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
    if (ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
      console.log("[Scraper] No session found, attempting auto-login...");
      if (!ENABLE_BROWSER) {
        throw new Error("Auto-login needs the browser (ENABLE_BROWSER=true).");
      }
      if (!(await performBrowserLogin(userId))) {
        throw new Error("Auto-login failed. Please configure your Royal Road session manually.");
      }
    } else {
      throw new Error("Session cookies not configured. Please set up your Royal Road cookies first.");
    }
  }

  // With a public page and no usable session, go straight to anonymous: there
  // is nothing an authenticated fetch would add.
  const wantAuth = !!userId && hasSession && !(allowAnonymous && isSessionKnownDead(userId));

  if (!ENABLE_BROWSER) {
    throw new Error("Browser is disabled (ENABLE_BROWSER=false). It is the only transport Royal Road accepts.");
  }

  console.log(`[Scraper] Fetching ${url} (${wantAuth ? 'auth' : 'anon'})`);

  await ensureBrowser();

  if (!anonContext) {
    throw new Error("Browser contexts not initialized");
  }

  // The anonymous context serves both anonymous requests and the fallback for
  // a rejected session, so a public page never depends on auth at all.
  let useAnon = !wantAuth || allowAnonymous;
  let ctx: BrowserContext | null = useAnon ? anonContext : context;

  if (!useAnon && userId) {
    const authContext = await createContext(userId);
    if (!authContext) {
      throw new Error("Failed to create authenticated browser context");
    }
    ctx = authContext;
  }

  if (!ctx) {
    throw new Error("No browser context available");
  }

  // This request holds a claim on its context. Shared contexts stay warm (and
  // keep their Cloudflare clearance); only a context that was replaced while
  // this request was in flight is closed when the request releases it.
  let requestContext: BrowserContext | null = null;

  const releaseRequestContext = async () => {
    if (!requestContext) return;
    const c = requestContext;
    requestContext = null;
    releaseContext(c);
    if (c !== context && c !== anonContext) {
      try { await c.close(); } catch {}
    }
  };

  const claimContext = async (c: BrowserContext) => {
    if (requestContext === c) return;
    await releaseRequestContext();
    requestContext = c;
    retainContext(c);
  };

  await claimContext(ctx);

  const blockResources = (p: Page) => p.route('**/*', (route) => {
    const request = route.request();
    // The page's own navigation is never blocked, whatever host a redirect lands
    // on; ad iframes are sub-frame navigations and stay blocked.
    const pageNavigation = request.isNavigationRequest() && request.frame() === p.mainFrame();
    // A Cloudflare challenge needs its own scripts and XHRs. Blocking those
    // made the interstitial impossible to clear, so every challenge turned
    // into a full retry loop.
    const challengeAsset = /challenges\.cloudflare\.com|cdn-cgi\/challenge-platform/.test(request.url());
    if (
      !challengeAsset &&
      (BLOCKED_RESOURCE_TYPES.includes(request.resourceType() as any) ||
        (!pageNavigation && isThirdParty(request.url())))
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
    await releaseRequestContext();
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
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: SCRAPER_TIMEOUT
      });
      const navMs = Date.now() - navStart;

      // Cloudflare's current interstitial is a bare "Just a moment..." shell
      // that loads its challenge in JS, so content markers alone match nothing
      // and a content snapshot taken right after domcontentloaded can catch the
      // pre-redirect page. Ask the live DOM instead, then let the challenge
      // finish in place - a fresh goto would restart it and burn an attempt.
      const firstLook = await pageIsChallengeShell(page);
      if (firstLook.challenged) {
        console.log(
          `[Scraper] Cloudflare challenge on ${url} (attempt ${attempts}, ${firstLook.reason}), waiting for it to clear...`
        );
        // Wait in place: re-navigating restarts the challenge. On the direct
        // path the shared context keeps the clearance it earns here, which is
        // what makes every later page fast. Clearing cookies after a short
        // wait used to throw that clearance away and force a fresh challenge
        // on every request. Only a configured proxy can move the exit IP
        // mid-session, so only then is a cookie reset worth trying.
        await waitForChallengeToClear(page, url, CHALLENGE_WAIT_MS);
        const secondLook = await pageIsChallengeShell(page);
        if (secondLook.challenged) {
          console.log(`[Scraper] Challenge still there after ${CHALLENGE_WAIT_MS}ms (${secondLook.reason})`);
          if (attempts >= maxAttempts) break;
          if (useAnon && BROWSER_PROXY) {
            await ctx.clearCookies().catch(() => {});
            sessionReset = true;
          }
          continue;
        }
      }
      if (sessionReset) {
        console.log(`[Scraper] ${url} cleared after resetting the proxy session's cookies`);
        sessionReset = false;
      }

      // Same reasoning as the challenge probe: ask the live DOM instead of
      // serialising it, so a dead session is still caught before the selector
      // timeout rather than after.
      if (await pageIsLoginShell(page)) {
        console.warn("[Scraper] WARNING: Redirected to login page - cookies may be invalid or expired!");
        if (userId && !opts.alreadyRetriedWithLogin && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
          markSessionDead(userId);
          await page.close();
          console.log("[Scraper] Attempting auto-login before retry...");
          const loggedIn = await performBrowserLogin(userId);
          // Always rebuild the page: it was just closed above, so retrying on
          // it fails with "Target page, context or browser has been closed".
          if (!loggedIn) {
            if (allowAnonymous) {
              // A public page still renders for a logged-out visitor, which is
              // far better than an error page - just without personal state.
              console.warn(`[Scraper] Could not restore the session; serving ${url} anonymously`);
              useAnon = true;
              await releaseRequestContext();
              ctx = anonContext;
              await claimContext(ctx);
              page = await ctx.newPage();
              await blockResources(page);
              continue;
            }
            throw new Error(
              "Royal Road rejected the stored session and auto-login could not restore it. " +
              "Paste a fresh .AspNetCore.Identity.Application cookie in Settings > Royal Road."
            );
          }
          const authContext = await createContext(userId, { force: true });
          if (!authContext) {
            throw new Error("Failed to recreate authenticated browser context after login");
          }
          ctx = authContext;
          await releaseRequestContext();
          await claimContext(ctx);
          page = await ctx.newPage();
          await blockResources(page);
          continue;
        }

        if (allowAnonymous) {
          console.warn(`[Scraper] Login redirect on a public page - serving ${url} anonymously`);
          try { await page.close(); } catch {}
          useAnon = true;
          await releaseRequestContext();
          ctx = anonContext;
          await claimContext(ctx);
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

      // A 404 (a removed fiction or chapter) will never grow the selector, so waiting
      // the full timeout for it only made every visit - and every cache-warming run
      // over a followed fiction that was taken down - cost 20s for nothing.
      if (waitForSelector && response?.status() !== 404) {
        try {
          const selectorStart = Date.now();
          await page.waitForSelector(waitForSelector, { timeout: SCRAPER_SELECTOR_TIMEOUT });
          console.log(`[Scraper] Selector "${waitForSelector}" found in ${Date.now() - selectorStart}ms`);
        } catch {
          console.log(`[Scraper] Selector "${waitForSelector}" not found, continuing anyway`);
        }
      }

      const content = await stableContent(page);
      console.log(
        `[Scraper] Browser page fetched in ${Date.now() - startTime}ms total ` +
        `(nav ${navMs}ms, ${content.length} bytes)`
      );      await rememberCookiesFromBrowser(ctx, wantAuth ? userId : undefined);
      const release = async () => {
        try { await page.close(); } catch {}
        await closeOwned();
      };
      return { page, content, release };
    }

    throw new Error(
      "Cloudflare would not let the browser through after several attempts. " +
      "The HTTP path already uses Chrome TLS impersonation, so this is either a " +
      "new challenge type or a network/proxy problem."
    );
  } catch (error) {
    try { await page.close(); } catch {}
    await closeOwned();
    throw error;
  }
}

/**
 * Is the current document Cloudflare's interstitial rather than the page?
 *
 * This deliberately does not serialise the DOM: `page.content()` on a
 * still-loading Royal Road page costs seconds on a 1 vCPU box, and doing it
 * twice per fetch (once to look for a challenge, once for the result) was a
 * large part of the old 20s+ fetch times. Title plus a handful of selectors is
 * enough and costs milliseconds.
 */
async function pageIsChallengeShell(page: Page): Promise<{ challenged: boolean; reason?: string }> {
  try {
    const title = await page.title();
    if (/just a moment|attention required|checking your browser|cloudflare/i.test(title)) {
      return { challenged: true, reason: `title "${title}"` };
    }
    const marker = await page.evaluate(() => {
      const el = document.querySelector(
        "#challenge-form, #challenge-running, .cf-browser-verification, #cf-turnstile, " +
        "script[src*='challenges.cloudflare.com']"
      );
      if (!el) return null;
      return el.id ? `#${el.id}` : el.className ? `.${el.className}` : el.tagName.toLowerCase();
    });
    return marker ? { challenged: true, reason: marker } : { challenged: false };
  } catch {
    // Mid-navigation or a closed page: let the next step report the real error.
    return { challenged: false };
  }
}

/**
 * Is the current document Royal Road's login page, i.e. was the session
 * rejected? Same cheap-probe reasoning as `pageIsChallengeShell`, and the same
 * two signals the HTML check used: the redirect target and the sign-in form.
 */
async function pageIsLoginShell(page: Page): Promise<boolean> {
  if (page.url().includes("/account/login")) return true;
  try {
    return await page.evaluate(() => {
      if (/^\s*Sign In\s*\|/i.test(document.title)) return true;
      return !!document.querySelector('form[action="/account/login"]');
    });
  } catch {
    return false;
  }
}

async function resolveRedirects(page: Page, urls: string[]): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  await ensureBrowser();
  const ctx = page.context();
  const out = new Map<string, string>();

  await mapLimit(urls, MAX_CONCURRENT_BROWSER_FETCHES, async (url) => {
    // Each redirect is a 302 to the actual next chapter, so `commit` (first byte
    // of the response) is all we need: `page.url()` is already the final URL and
    // no body is downloaded or rendered. A full `getPage` here used to load 43
    // chapter pages per follows warm.
    const releaseSlot = await browserSlots.acquire();
    let p: Page | null = null;
    try {
      p = await ctx.newPage();
      await p.route("**/*", (route) => {
        if (route.request().resourceType() === "document") route.continue();
        else route.abort();
      });
      const navStart = Date.now();
      await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
      const finalUrl = p.url();
      console.log(`[Scraper] Resolved ${url} -> ${finalUrl} in ${Date.now() - navStart}ms`);
      if (finalUrl && finalUrl !== url && finalUrl !== `${url}/`) out.set(url, finalUrl);
    } catch (e) {
      console.warn(`[Scraper] Failed to resolve ${url}: ${(e as Error).message.slice(0, 80)}`);
    } finally {
      try { await p?.close(); } catch {}
      releaseSlot();
    }
  });

  return out;
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
    contextUserId = null;
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

export function getFollows(userId: string, ttl: number = CACHE_TTL.FOLLOWS): Promise<FollowedFiction[]> {
  return orStale(`follows:${userId}`, () => getFollowsLive(userId, ttl));
}

async function getFollowsLive(userId: string, ttl: number): Promise<FollowedFiction[]> {
  const cacheKey = `follows:${userId}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log("Returning cached follows");
    return JSON.parse(cached);
  }

  const { page, content, release } = await getPage(
    `${ROYAL_ROAD_BASE_URL}/my/follows`,
    FICTION_CARD_WAIT_SELECTOR,
    userId,
  );

  try {
    const cards = parseCards(content);
    console.log(`Found ${cards.length} fiction cards`);

    // Carry the unresolved redirect target alongside each row so the resolver
    // below can find it without a second parse.
    const fictions = cards.map((card) => ({
      ...toFollowedFiction(card),
      ...(card.nextChapterResolveUrl ? { __resolveUrl: card.nextChapterResolveUrl } : {}),
    })) as (FollowedFiction & { __resolveUrl?: string })[];

    // Resolve /chapter/next/ redirect URLs to get actual chapter IDs. These run
    // inside the follows page we already have open: no extra navigations.
    const needing = fictions.filter((f) => !!f.__resolveUrl && !f.nextChapterId);

    if (needing.length > 0) {
      if (!page) {
        console.warn(`Cannot resolve ${needing.length} next chapter URLs without a browser page`);
      } else {
        const startTime = Date.now();
        console.log(`Resolving ${needing.length} next chapter redirect URLs...`);
        const resolved = await resolveRedirects(
          page,
          needing.map((f) => f.__resolveUrl!)
        );
        console.log(
          `Resolved ${resolved.size}/${needing.length} redirect URLs in ${Date.now() - startTime}ms`
        );

        for (const fiction of needing) {
          const resolve = fiction.__resolveUrl;
          if (!resolve) continue;

          const finalUrl = resolved.get(resolve);
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
        }
      }
    }

    if (fictions.length > 0) {
      setCacheWithStale(cacheKey, JSON.stringify(fictions), ttl);
    }

    return fictions;
  } finally {
    await release();
  }
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

export function getReadLater(userId: string, ttl: number = CACHE_TTL.FOLLOWS): Promise<Fiction[]> {
  return orStale(`readlater:${userId}`, () => getReadLaterLive(userId, ttl));
}

async function getReadLaterLive(userId: string, ttl: number): Promise<Fiction[]> {
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
    setCacheWithStale(cacheKey, JSON.stringify(fictions), ttl);
  }

  return fictions;
}

export function getToplist(toplist: ToplistType, userId?: string, ttl: number = CACHE_TTL.TOPLIST): Promise<Fiction[]> {
  return orStale(`toplist:${toplist.slug}`, () => getToplistLive(toplist, userId, ttl));
}

async function getToplistLive(toplist: ToplistType, userId: string | undefined, ttl: number): Promise<Fiction[]> {
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
    setCacheWithStale(cacheKey, JSON.stringify(fictions), ttl);
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

export function getFiction(id: number, userId?: string, ttl: number = CACHE_TTL.FICTION): Promise<Fiction | null> {
  return orStale(fictionCacheKey(id, userId), () => getFictionLive(id, userId, ttl));
}

async function getFictionLive(id: number, userId: string | undefined, ttl: number): Promise<Fiction | null> {
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

  setCacheWithStale(cacheKey, JSON.stringify(parsed.fiction), ttl);
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
        const loggedIn = await performBrowserLogin(userId);
        if (loggedIn) {
          clearSessionState(userId);
          await createContext(userId, { force: true });
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

  try {
    console.log(`[Scraper] Setting bookmark: fiction=${fictionId}, type=${type}, mark=${mark}`);

    // The context's request client shares the browser's cookie jar, so this POST
    // carries the same session (and network path) as a page visit. A plain
    // server-side fetch cannot: Cloudflare blocks non-browser clients outright.
    const ctx = await createContext(userId);
    if (!ctx) throw new Error("No browser context available for bookmark");

    const response = await ctx.request.post(url, {
      form: {
        type,
        mark: mark ? "True" : "False",
        __RequestVerificationToken: csrfToken,
      },
      maxRedirects: 0,  // A 302 is success, not something to follow
      failOnStatusCode: false,
    });
    const status = response.status();

    // Success is typically 200 or 302 redirect
    if (status >= 200 && status < 400) {
      console.log(`[Scraper] Bookmark set successfully`);

      // Invalidate caches so we get fresh state. Fiction rows are per user, so
      // drop every user's copy of this fiction — the antiforgery token and the
      // follow state are both stale now.
      deleteCacheByPrefix(`fiction:${fictionId}:`);
      deleteCache(`follows:${userId}`);
      deleteCache(`readlater:${userId}`);

      return { success: true };
    }

    if (status === 400 || status === 403) {
      console.error(`[Scraper] Bookmark rejected (${status}) - stale antiforgery token or session`);
      markSessionDead(userId);
      return {
        success: false,
        error: "Royal Road rejected the request. Re-open the fiction page to refresh your session.",
      };
    }

    console.error(`[Scraper] Bookmark failed with status: ${status}`);
    return { success: false, error: `Request failed (${status})` };
  } catch (error) {
    console.error(`[Scraper] Bookmark error:`, error);
    return { success: false, error: "Network error" };
  }
}
