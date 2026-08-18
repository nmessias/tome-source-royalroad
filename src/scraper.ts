/**
 * Hybrid HTTP + Playwright scraper for Royal Road
 * Tries fast HTTP fetch first, falls back to Firefox for Cloudflare challenges
 * Browser fallback can be disabled via ENABLE_BROWSER=false to save resources
 */
import { parseHTML } from "linkedom";
import { getCache, setCache, deleteCache } from "tome";
import { getRoyalRoadCookiesForPlaywright, hasRoyalRoadSession } from "./royalroad-credentials";
import { CACHE_TTL } from "tome";
import { ROYAL_ROAD_BASE_URL, SCRAPER_TIMEOUT, SCRAPER_SELECTOR_TIMEOUT, ENABLE_BROWSER } from "./config";
import { performAutoLogin, ROYAL_ROAD_AUTO_LOGIN_ENABLED } from "./royalroad-auth";

// Playwright types (imported dynamically when ENABLE_BROWSER=true)
type Browser = import("playwright").Browser;
type BrowserContext = import("playwright").BrowserContext;
type Page = import("playwright").Page;
import type { Fiction, FollowedFiction, Chapter, ChapterContent, ToplistType, HistoryEntry } from "tome";

// Resource types to block for faster page loads (keep images for covers)
const BLOCKED_RESOURCE_TYPES = ['stylesheet', 'font', 'media', 'other'] as const;

// Number words for normalization (chapter titles like "Chapter Forty-Seven")
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70",
  eighty: "80", ninety: "90", hundred: "100",
};

/**
 * Normalize text for fuzzy matching:
 * - Lowercase
 * - Convert number words to digits
 * - Remove punctuation
 * - Collapse whitespace
 */
function normalizeText(text: string): string {
  let normalized = text.toLowerCase();
  
  // Convert number words to digits (e.g., "forty-seven" -> "40-7" -> "407")
  // Handle compound numbers like "forty-seven" or "forty seven"
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
  }
  
  // Remove punctuation except spaces
  normalized = normalized.replace(/[^\w\s]/g, ' ');
  
  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();
  
  return normalized;
}

/**
 * Extract the "core" title by stripping common chapter prefixes
 * e.g., "Chapter 47: The Battle Begins" -> "the battle begins"
 * e.g., "Ch. 12 - Awakening" -> "awakening"
 */
function extractCoreTitle(title: string): string {
  const normalized = normalizeText(title);
  
  // Common chapter prefix patterns to strip
  const prefixPatterns = [
    /^chapter\s+\d+\s*[:\-–—]\s*/i,      // "Chapter 47: " or "Chapter 47 - "
    /^chapter\s+\d+\s*/i,                 // "Chapter 47 "
    /^ch\.?\s*\d+\s*[:\-–—]\s*/i,         // "Ch. 12: " or "Ch 12 - "
    /^ch\.?\s*\d+\s*/i,                   // "Ch. 12 "
    /^\d+\s*[:\-–—\.]\s*/i,               // "47: " or "47. " or "47 - "
    /^part\s+\d+\s*[:\-–—]\s*/i,          // "Part 3: "
    /^book\s+\d+\s*[:\-–—]\s*/i,          // "Book 2: "
    /^arc\s+\d+\s*[:\-–—]\s*/i,           // "Arc 1: "
    /^episode\s+\d+\s*[:\-–—]\s*/i,       // "Episode 5: "
    /^prologue\s*[:\-–—]?\s*/i,           // "Prologue: "
    /^epilogue\s*[:\-–—]?\s*/i,           // "Epilogue: "
    /^interlude\s*[:\-–—]?\s*/i,          // "Interlude: "
  ];
  
  let core = normalized;
  for (const pattern of prefixPatterns) {
    core = core.replace(pattern, '');
  }
  
  return core.trim();
}

/**
 * Extract text content from first N block elements or first N characters of HTML
 */
function extractFirstLines(html: string, maxChars: number = 500): string {
  const { document } = parseHTML(`<div>${html}</div>`);
  const root = document.querySelector('div');
  if (!root) return '';
  
  // Get text from first 3 block-level elements
  const blockElements = root.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6');
  let text = '';
  let count = 0;
  
  for (const el of blockElements) {
    if (count >= 3) break;
    const elText = el.textContent?.trim();
    if (elText) {
      text += elText + '\n';
      count++;
    }
  }
  
  // Fallback: if no block elements found, get raw text content
  if (!text.trim()) {
    text = root.textContent || '';
  }
  
  // Limit to maxChars
  return text.slice(0, maxChars);
}

/**
 * Calculate word overlap percentage between two strings
 */
function wordOverlap(str1: string, str2: string): number {
  const words1 = str1.split(/\s+/).filter(w => w.length > 2); // Ignore very short words
  const words2 = str2.split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0) return 0;
  
  let matches = 0;
  for (const word of words1) {
    if (words2.some(w => w.includes(word) || word.includes(w))) {
      matches++;
    }
  }
  
  return matches / words1.length;
}

/**
 * Check if the chapter title (or a significant part of it) already appears
 * in the first few lines of the content
 */
function shouldPrependTitle(title: string, htmlContent: string): boolean {
  if (!title || !htmlContent) return true;
  
  const normalizedTitle = normalizeText(title);
  const coreTitle = extractCoreTitle(title);
  const firstLines = extractFirstLines(htmlContent);
  const normalizedContent = normalizeText(firstLines);
  
  // Check 1: Full title appears as substring
  if (normalizedContent.includes(normalizedTitle)) {
    return false;
  }
  
  // Check 2: Core title appears as substring (if different from full title)
  if (coreTitle && coreTitle !== normalizedTitle && normalizedContent.includes(coreTitle)) {
    return false;
  }
  
  // Check 3: High word overlap (60%+) between core title and content
  if (coreTitle && coreTitle.length > 3) {
    const overlap = wordOverlap(coreTitle, normalizedContent);
    if (overlap >= 0.6) {
      return false;
    }
  }
  
  // Check 4: Chapter number appears at the start of content
  // e.g., title is "Chapter 47" and content starts with "47" or "Chapter 47"
  const chapterNumMatch = normalizedTitle.match(/(?:chapter|ch\.?)\s*(\d+)/i) || normalizedTitle.match(/^(\d+)/);
  if (chapterNumMatch) {
    const chapterNum = chapterNumMatch[1];
    // Check if content starts with this number (with some flexibility)
    const contentStart = normalizedContent.slice(0, 50);
    if (contentStart.match(new RegExp(`^\\s*(?:chapter|ch\\.?)?\\s*${chapterNum}\\b`, 'i'))) {
      return false;
    }
  }
  
  // No match found - should prepend the title
  return true;
}

/**
 * Escape HTML entities in a string
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// HTTP fetch user agent (same as Playwright context)
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Execute async functions with limited concurrency
 * Prevents overwhelming the server with too many parallel requests
 */
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
 * Get cookies formatted as HTTP Cookie header string for a specific user
 */
function getCookiesForFetch(userId: string): string {
  const cookies = getRoyalRoadCookiesForPlaywright(userId);
  return cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Try fetching page via HTTP first (fast path, ~100ms)
 * Returns HTML content if successful, null if Cloudflare blocked or error
 */
async function tryHttpFetch(url: string, userId?: string, alreadyRetriedWithLogin?: boolean): Promise<{ content: string; finalUrl: string } | null> {
  const startTime = Date.now();
  
  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    };
    
    if (userId) {
      const cookieHeader = getCookiesForFetch(userId);
      if (cookieHeader) {
        headers["Cookie"] = cookieHeader;
      }
    }
    
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
    if (html.includes("challenge-running") || html.includes("cf-browser-verification") || html.includes("cf-turnstile")) {
      console.log(`[Scraper] Cloudflare challenge detected in ${Date.now() - startTime}ms, need browser`);
      return null;
    }
    
    // Check for login redirect (cookies not working)
    if (html.includes('action="/account/login"') || response.url.includes("/account/login")) {
      console.warn("[Scraper] HTTP fetch got login page - cookies may be invalid or expired");
      if (userId && !alreadyRetriedWithLogin && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
        console.log("[Scraper] Attempting auto-login before retry...");
        const loggedIn = await performAutoLogin(userId);
        if (loggedIn) {
          return tryHttpFetch(url, userId, true);
        }
      }
      return null;
    }
    
    console.log(`[Scraper] HTTP fetch succeeded in ${Date.now() - startTime}ms`);
    return { content: html, finalUrl: response.url };
  } catch (error) {
    console.error(`[Scraper] HTTP fetch error in ${Date.now() - startTime}ms:`, error);
    return null;
  }
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let anonContext: BrowserContext | null = null;

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

  console.log("Initializing Firefox browser...");
  const startTime = Date.now();
  
  const { firefox } = await import("playwright");
  browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      "browser.cache.disk.enable": false,
      "browser.cache.memory.enable": true,
      "browser.cache.memory.capacity": 32768,
      "browser.sessionhistory.max_entries": 2,
      "browser.sessionstore.max_tabs_undo": 0,
      "media.autoplay.enabled": false,
      "media.peerconnection.enabled": false,
      "dom.webnotifications.enabled": false,
      "geo.enabled": false,
    },
  });
  console.log(`Firefox launched in ${Date.now() - startTime}ms`);

  await createAnonContext();
  console.log("Browser initialized");
}

export async function createContext(userId: string): Promise<void> {
  if (!ENABLE_BROWSER || !browser) {
    if (ENABLE_BROWSER) await initBrowser();
    return;
  }

  if (context) {
    await context.close();
  }

  const cookies = getRoyalRoadCookiesForPlaywright(userId);
  console.log(`Creating context with ${cookies.length} cookies: ${cookies.map((c: { name: string }) => c.name).join(", ")}`);
  
  context = await browser.newContext({
    userAgent: USER_AGENT,
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

  anonContext = await browser.newContext({
    userAgent: USER_AGENT,
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

async function getPage(
  url: string,
  waitForSelector?: string,
  userId?: string,
  alreadyRetriedWithLogin?: boolean
): Promise<{ page: Page | null; content: string }> {
  const startTime = Date.now();
  const useAnon = !userId;
  
  if (!useAnon && !hasRoyalRoadSession(userId)) {
    if (ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
      console.log("[Scraper] No session found, attempting auto-login...");
      const loggedIn = await performAutoLogin(userId);
      if (!loggedIn) {
        throw new Error("Auto-login failed. Please configure your Royal Road session manually.");
      }
    } else {
      throw new Error("Session cookies not configured. Please set up your Royal Road cookies first.");
    }
  }

  console.log(`[Scraper] Trying HTTP fetch for ${url} (${useAnon ? 'anon' : 'auth'})`);
  const httpResult = await tryHttpFetch(url, userId);
  if (httpResult) {
    console.log(`[Scraper] HTTP fetch succeeded in ${Date.now() - startTime}ms total`);
    return { page: null, content: httpResult.content };
  }

  if (!ENABLE_BROWSER) {
    throw new Error("HTTP fetch failed and browser fallback is disabled (ENABLE_BROWSER=false). Cloudflare may be blocking requests.");
  }

  console.log(`[Scraper] Falling back to Firefox for ${url}`);
  
  await ensureBrowser();
  
  if (!anonContext) {
    throw new Error("Browser contexts not initialized");
  }
  
  if (!useAnon && userId) {
    await createContext(userId);
    if (!context) {
      throw new Error("Failed to create authenticated browser context");
    }
  }

  const ctx = useAnon ? anonContext : context;
  if (!ctx) {
    throw new Error("No browser context available");
  }
  
  const page = await ctx.newPage();
  
  await page.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.includes(resourceType as any)) {
      route.abort();
    } else {
      route.continue();
    }
  });
  
  try {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      attempts++;
      console.log(`[Scraper] Firefox fetching ${url} (attempt ${attempts})`);
      
      const navStart = Date.now();
      await page.goto(url, { 
        waitUntil: "domcontentloaded",
        timeout: SCRAPER_TIMEOUT 
      });
      console.log(`[Scraper] Firefox navigation completed in ${Date.now() - navStart}ms`);

      const pageContent = await page.content();
      if (pageContent.includes("challenge-running") || pageContent.includes("cf-browser-verification") || pageContent.includes("cf-turnstile")) {
        console.log("[Scraper] Cloudflare challenge detected, waiting 5s...");
        await page.waitForTimeout(5000);
        continue;
      }
      
      if (page.url().includes("/account/login") || pageContent.includes('action="/account/login"')) {
        console.warn("[Scraper] WARNING: Redirected to login page - cookies may be invalid or expired!");
        if (userId && !alreadyRetriedWithLogin && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
          await page.close();
          console.log("[Scraper] Attempting auto-login before retry...");
          const loggedIn = await performAutoLogin(userId);
          if (loggedIn) {
            await createContext(userId);
          }
          continue;
        }
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

      const content = await page.content();
      console.log(`[Scraper] Firefox page fetched in ${Date.now() - startTime}ms total`);
      return { page, content };
    }

    throw new Error("Failed to bypass Cloudflare after multiple attempts");
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * Resolve a redirect URL to get the final URL (used for /chapter/next/ URLs)
 * Uses a lightweight HEAD request instead of opening a browser page
 * Returns the final URL after redirects, or null if failed
 */
async function resolveRedirectUrl(url: string, userId?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
    };
    
    if (userId) {
      headers["Cookie"] = getCookiesForFetch(userId);
    }
    
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
    });
    
    return response.url;
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

// ============ Parsing Helpers ============

/**
 * Parse fiction list from HTML (works for toplists)
 */
function parseFictionList(html: string): Fiction[] {
  const { document } = parseHTML(html);
  const fictions: Fiction[] = [];

  const items = document.querySelectorAll(".fiction-list-item");
  
  for (const item of items) {
    try {
      const titleEl = item.querySelector("h2.fiction-title a, .fiction-title a");
      if (!titleEl) continue;

      const href = titleEl.getAttribute("href") || "";
      const idMatch = href.match(/\/fiction\/(\d+)/);
      if (!idMatch) continue;

      const id = parseInt(idMatch[1], 10);
      const title = titleEl.textContent?.trim() || "";
      
      // Tags (first 3 genre tags)
      const tagEls = item.querySelectorAll(".fiction-tag");
      const tags: string[] = [];
      for (let i = 0; i < Math.min(tagEls.length, 3); i++) {
        const tagText = tagEls[i].textContent?.trim();
        if (tagText) tags.push(tagText);
      }

      // Rating from star span's title attribute (e.g., title="4.75")
      const starEl = item.querySelector(".star[title]");
      const rating = starEl ? parseFloat(starEl.getAttribute("title") || "0") : undefined;

      // Stats from the stats row - parse by icon class
      let followers: number | undefined;
      let pages: number | undefined;
      
      const statsRow = item.querySelector(".row.stats");
      if (statsRow) {
        const statDivs = statsRow.querySelectorAll(".col-sm-6");
        for (const div of statDivs) {
          const text = div.textContent?.trim() || "";
          const icon = div.querySelector("i");
          const iconClass = icon?.getAttribute("class") || "";
          
          // Parse number from text (e.g., "2,857 Followers" -> 2857)
          const numMatch = text.match(/([\d,]+)/);
          const num = numMatch ? parseInt(numMatch[1].replace(/,/g, ""), 10) : undefined;
          
          if (iconClass.includes("fa-users") && num !== undefined) {
            followers = num;
          } else if (iconClass.includes("fa-book") && num !== undefined) {
            pages = num;
          }
        }
      }

      // Description (hidden by default in toplist HTML)
      const descEl = item.querySelector(".hidden-content, .fiction-description, .margin-top-10.col-xs-12, [id^='description-']");
      const description = descEl?.textContent?.trim() || "";

      // Cover
      const coverEl = item.querySelector("img[src*='covers'], img.thumbnail, img[data-type='cover']");
      let coverUrl = coverEl?.getAttribute("src") || undefined;
      if (coverUrl && !coverUrl.startsWith("http")) {
        coverUrl = `https://www.royalroad.com${coverUrl}`;
      }

      fictions.push({
        id,
        title,
        author: "", // Not available in toplist HTML
        url: `${ROYAL_ROAD_BASE_URL}${href}`,
        coverUrl,
        description,
        tags,
        stats: {
          rating,
          followers,
          pages,
        },
      });
    } catch (e) {
      console.error("Error parsing fiction item:", e);
    }
  }

  return fictions;
}

// ============ Scraper Functions ============

export async function getFollows(userId: string, ttl: number = CACHE_TTL.FOLLOWS): Promise<FollowedFiction[]> {
  const cacheKey = `follows:${userId}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log("Returning cached follows");
    return JSON.parse(cached);
  }

  const { page, content } = await getPage(`${ROYAL_ROAD_BASE_URL}/my/follows`, ".fiction-list-item", userId);
  if (page) await page.close();

  const { document } = parseHTML(content);
  const fictions: FollowedFiction[] = [];

  const rows = document.querySelectorAll(".fiction-list-item");
  console.log(`Found ${rows.length} fiction items`);
  
  for (const row of rows) {
    try {
      const titleEl = row.querySelector("h2.fiction-title a");
      if (!titleEl) continue;

      const href = titleEl.getAttribute("href") || "";
      const idMatch = href.match(/\/fiction\/(\d+)/);
      if (!idMatch) continue;

      const id = parseInt(idMatch[1], 10);
      const title = titleEl.textContent?.trim() || "";
      
      // Author
      let author = "";
      const authorEl = row.querySelector("span.author a[href*='/profile/']");
      if (authorEl) {
        author = authorEl.textContent?.trim() || "";
      } else {
        const profileLink = row.querySelector("a[href*='/profile/']");
        if (profileLink) {
          author = profileLink.textContent?.trim() || "";
        }
      }
      
      // Unread indicator
      const hasUnread = !!row.querySelector("i.fa-circle");
      
      // Cover
      const coverEl = row.querySelector("img[src*='covers'], img.thumbnail");
      let coverUrl = coverEl?.getAttribute("src") || undefined;
      if (coverUrl && !coverUrl.startsWith("http")) {
        coverUrl = `https://www.royalroad.com${coverUrl}`;
      }
      
      // Chapter info
      const listItems = row.querySelectorAll("li.list-item");
      let latestChapter = "";
      let latestChapterId: number | undefined;
      let lastReadChapter = "";
      let lastReadChapterId: number | undefined;
      let nextChapterId: number | undefined;
      let nextChapterTitle: string | undefined;
      
      for (const li of listItems) {
        const text = li.textContent || "";
        const chapterLink = li.querySelector("a[href*='/chapter/']");
        const chapterNameEl = li.querySelector("a span.col-xs-8");
        const chapterName = chapterNameEl?.textContent?.trim() || "";
        const chapterHref = chapterLink?.getAttribute("href") || "";
        const chapterIdMatch = chapterHref.match(/\/chapter\/(\d+)/);
        const chapterId = chapterIdMatch ? parseInt(chapterIdMatch[1], 10) : undefined;
        
        if (text.includes("Last Update:")) {
          latestChapter = chapterName;
          latestChapterId = chapterId;
        } else if (text.includes("Last Read Chapter:")) {
          lastReadChapter = chapterName;
          lastReadChapterId = chapterId;
        }
      }
      
      // Read button (next unread chapter)
      // Royal Road uses /chapter/next/{fictionId} which redirects to actual chapter
      let nextChapterUrl: string | undefined;
      const readButton = row.querySelector("a.btn[href*='/chapter/']");
      if (readButton) {
        const readHref = readButton.getAttribute("href") || "";
        // Try direct chapter ID first (e.g., /chapter/123456)
        const directMatch = readHref.match(/\/chapter\/(\d+)$/);
        if (directMatch) {
          nextChapterId = parseInt(directMatch[1], 10);
          nextChapterTitle = readButton.textContent?.trim() || undefined;
        } else if (readHref.includes("/chapter/next/")) {
          // Store the redirect URL to resolve later
          nextChapterUrl = readHref.startsWith("http") ? readHref : `${ROYAL_ROAD_BASE_URL}${readHref}`;
          nextChapterTitle = readButton.textContent?.trim() || undefined;
        }
      }

      fictions.push({
        id,
        title,
        author,
        url: `${ROYAL_ROAD_BASE_URL}${href}`,
        coverUrl,
        hasUnread,
        latestChapter,
        latestChapterId,
        lastRead: lastReadChapter,
        lastReadChapterId,
        nextChapterId,
        nextChapterTitle,
        _nextChapterUrl: nextChapterUrl, // Temporary field for redirect resolution
      } as FollowedFiction & { _nextChapterUrl?: string });
    } catch (e) {
      console.error("Error parsing follow item:", e);
    }
  }

  // Resolve /chapter/next/ redirect URLs to get actual chapter IDs
  // Use parallel requests with concurrency limit to avoid overwhelming the server
  const fictionsNeedingResolution = fictions.filter(
    (f) => (f as FollowedFiction & { _nextChapterUrl?: string })._nextChapterUrl && !f.nextChapterId
  );
  
  if (fictionsNeedingResolution.length > 0) {
    const startTime = Date.now();
    console.log(`Resolving ${fictionsNeedingResolution.length} next chapter redirect URLs (parallel, max 10)...`);
    
    await parallelLimit(fictionsNeedingResolution, 10, async (fiction) => {
      const f = fiction as FollowedFiction & { _nextChapterUrl?: string };
      if (!f._nextChapterUrl) return;
      
      try {
        const finalUrl = await resolveRedirectUrl(f._nextChapterUrl, userId);
        if (finalUrl) {
          const chapterIdMatch = finalUrl.match(/\/chapter\/(\d+)/);
          if (chapterIdMatch) {
            f.nextChapterId = parseInt(chapterIdMatch[1], 10);
          }
        }
      } catch (e) {
        console.error(`Failed to resolve next chapter URL for "${f.title}":`, e);
      }
      
      delete f._nextChapterUrl;
    });
    
    console.log(`Resolved ${fictionsNeedingResolution.length} redirect URLs in ${Date.now() - startTime}ms`);
  }

  if (fictions.length > 0) {
    setCache(cacheKey, JSON.stringify(fictions), ttl);
  }

  return fictions;
}

export async function getHistory(userId: string): Promise<HistoryEntry[]> {
  const { page, content } = await getPage(`${ROYAL_ROAD_BASE_URL}/my/history`, ".fiction-list", userId);
  if (page) await page.close();

  const { document } = parseHTML(content);
  const history: HistoryEntry[] = [];

  const rows = document.querySelectorAll(".fiction-list > .row");
  console.log(`Found ${rows.length} history items`);
  
  for (const row of rows) {
    try {
      const links = row.querySelectorAll("a[href*='/fiction/']");
      if (links.length < 2) continue;
      
      const fictionLink = row.querySelector("a[href*='/fiction/']:not([href*='/chapter/'])");
      if (!fictionLink) continue;

      const fictionHref = fictionLink.getAttribute("href") || "";
      const fictionIdMatch = fictionHref.match(/\/fiction\/(\d+)/);
      if (!fictionIdMatch) continue;

      const fictionId = parseInt(fictionIdMatch[1], 10);
      const fictionTitle = fictionLink.textContent?.trim() || "";

      const chapterLink = row.querySelector("a[href*='/chapter/']");
      if (!chapterLink) continue;

      const chapterHref = chapterLink.getAttribute("href") || "";
      const chapterIdMatch = chapterHref.match(/\/chapter\/(\d+)/);
      if (!chapterIdMatch) continue;

      const chapterId = parseInt(chapterIdMatch[1], 10);
      const chapterTitle = chapterLink.textContent?.trim() || "";

      const timeEl = row.querySelector("time");
      const readAt = timeEl?.textContent?.trim() || "";

      history.push({
        fictionId,
        fictionTitle,
        chapterId,
        chapterTitle,
        readAt,
      });
    } catch (e) {
      console.error("Error parsing history item:", e);
    }
  }

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

  const { page, content } = await getPage(`${ROYAL_ROAD_BASE_URL}/my/readlater`, ".fiction-list-item", userId);
  if (page) await page.close();

  const { document } = parseHTML(content);
  const fictions: Fiction[] = [];

  const rows = document.querySelectorAll(".fiction-list-item");
  console.log(`Found ${rows.length} read later items`);

  for (const row of rows) {
    try {
      const titleEl = row.querySelector("h2.fiction-title a");
      if (!titleEl) continue;

      const href = titleEl.getAttribute("href") || "";
      const idMatch = href.match(/\/fiction\/(\d+)/);
      if (!idMatch) continue;

      const id = parseInt(idMatch[1], 10);
      const title = titleEl.textContent?.trim() || "";

      let author = "";
      const authorEl = row.querySelector("span.author a[href*='/profile/']");
      if (authorEl) {
        author = authorEl.textContent?.trim() || "";
      }

      const coverEl = row.querySelector("img[data-type='cover']");
      let coverUrl = coverEl?.getAttribute("src") || undefined;
      if (coverUrl && !coverUrl.startsWith("http")) {
        coverUrl = `https://www.royalroad.com${coverUrl}`;
      }

      let pages: number | undefined;
      const pageCountEl = row.querySelector("span.page-count");
      if (pageCountEl) {
        const text = pageCountEl.textContent?.trim() || "";
        const numMatch = text.match(/([\d,]+)/);
        if (numMatch) {
          pages = parseInt(numMatch[1].replace(/,/g, ""), 10);
        }
      }

      const descEl = row.querySelector(".hidden-content");
      const description = descEl?.textContent?.trim() || "";

      fictions.push({
        id,
        title,
        author,
        url: `${ROYAL_ROAD_BASE_URL}${href}`,
        coverUrl,
        description,
        stats: { pages },
      });
    } catch (e) {
      console.error("Error parsing read later item:", e);
    }
  }

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

  const { page, content } = await getPage(toplist.url, ".fiction-list", userId);
  if (page) await page.close();

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
  const cacheKey = `fiction:${id}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`Returning cached fiction: ${id}`);
    return JSON.parse(cached);
  }

  const url = `${ROYAL_ROAD_BASE_URL}/fiction/${id}`;
  const { page, content } = await getPage(url, ".fic-title", userId);
  
  // Try to get chapters from window.chapters variable (only works with browser)
  let chapters: Chapter[] = [];
  if (page) {
    try {
      const chaptersData = await page.evaluate(() => {
        return (window as any).chapters || [];
      });
      
      chapters = chaptersData.map((c: any) => ({
        id: c.id,
        title: c.title,
        url: `/chapter/${c.id}`,
        date: c.date,
        order: c.order,
      }));
    } catch (e) {
      console.log("Could not get chapters from JS, parsing HTML");
    }
    await page.close();
  }

  const { document } = parseHTML(content);

  // Title
  const titleEl = document.querySelector(".fic-title h1, h1.font-white");
  
  // Author
  let author = "Unknown";
  const authorEl = document.querySelector(".fic-title a[href*='/profile/']");
  if (authorEl) {
    author = authorEl.textContent?.trim() || "Unknown";
  } else {
    const headerProfileLink = document.querySelector(".fic-header a[href*='/profile/']");
    if (headerProfileLink) {
      author = headerProfileLink.textContent?.trim() || "Unknown";
    }
  }
  
  // Description
  const descEl = document.querySelector(".description, .fiction-description");
  
  // Cover
  const coverEl = document.querySelector(".fic-header img[src*='covers'], .cover-art-container img, img.cover-art, .thumbnail img");
  let coverUrl = coverEl?.getAttribute("src") || undefined;
  if (coverUrl && !coverUrl.startsWith("http")) {
    coverUrl = `https://www.royalroad.com${coverUrl}`;
  }
  
  // Stats
  const statsContainer = document.querySelector(".fiction-stats");
  let rating: number | undefined;
  let styleScore: number | undefined;
  let storyScore: number | undefined;
  let grammarScore: number | undefined;
  let characterScore: number | undefined;
  let views: number | undefined;
  let averageViews: number | undefined;
  let followers: number | undefined;
  let favorites: number | undefined;
  let ratings: number | undefined;
  let pages: number | undefined;

  if (statsContainer) {
    // Parse star ratings from data-content attribute (e.g., "4.66 / 5")
    const parseRating = (el: Element | null): number | undefined => {
      if (!el) return undefined;
      const content = el.getAttribute("data-content") || el.getAttribute("aria-label") || "";
      const match = content.match(/([\d.]+)/);
      return match ? parseFloat(match[1]) : undefined;
    };

    // Find ratings by their labels
    const listItems = statsContainer.querySelectorAll("li.list-item, li");
    let currentLabel = "";
    
    for (const li of listItems) {
      const text = li.textContent?.trim() || "";
      const starEl = li.querySelector(".star, [data-content]");
      
      if (text.includes("Overall Score")) {
        currentLabel = "overall";
      } else if (text.includes("Style Score")) {
        currentLabel = "style";
      } else if (text.includes("Story Score")) {
        currentLabel = "story";
      } else if (text.includes("Grammar Score")) {
        currentLabel = "grammar";
      } else if (text.includes("Character Score")) {
        currentLabel = "character";
      } else if (starEl) {
        const score = parseRating(starEl);
        if (currentLabel === "overall") rating = score;
        else if (currentLabel === "style") styleScore = score;
        else if (currentLabel === "story") storyScore = score;
        else if (currentLabel === "grammar") grammarScore = score;
        else if (currentLabel === "character") characterScore = score;
        currentLabel = "";
      }
    }

    // Parse numeric stats from the right column
    const statsListItems = statsContainer.querySelectorAll(".col-sm-6:last-child li, .stats-content li");
    let nextStatType = "";
    
    for (const li of statsListItems) {
      const text = li.textContent?.trim().toUpperCase() || "";
      
      if (text.includes("TOTAL VIEWS")) {
        nextStatType = "views";
      } else if (text.includes("AVERAGE VIEWS")) {
        nextStatType = "avgViews";
      } else if (text.includes("FOLLOWERS")) {
        nextStatType = "followers";
      } else if (text.includes("FAVORITES")) {
        nextStatType = "favorites";
      } else if (text.includes("RATINGS")) {
        nextStatType = "ratings";
      } else if (text.includes("PAGES")) {
        nextStatType = "pages";
      } else if (nextStatType && li.classList.contains("font-red-sunglo")) {
        const num = parseInt(text.replace(/,/g, ""), 10);
        if (!isNaN(num)) {
          if (nextStatType === "views") views = num;
          else if (nextStatType === "avgViews") averageViews = num;
          else if (nextStatType === "followers") followers = num;
          else if (nextStatType === "favorites") favorites = num;
          else if (nextStatType === "ratings") ratings = num;
          else if (nextStatType === "pages") pages = num;
        }
        nextStatType = "";
      }
    }
  } else {
    // Fallback: try to get at least the overall rating
    const ratingEl = document.querySelector(".star[data-content], [data-original-title*='Score']");
    rating = ratingEl ? parseFloat(ratingEl.getAttribute("data-content") || "0") : undefined;
  }

  // Parse chapters from HTML if not from JS
  let lastReadChapterIdx = -1;
  
  if (chapters.length === 0) {
    const chapterRows = document.querySelectorAll("tr[data-url], .chapter-row");
    let idx = 0;
    
    for (const row of chapterRows) {
      const href = row.getAttribute("data-url") || row.querySelector("a")?.getAttribute("href") || "";
      const chapterMatch = href.match(/\/chapter\/(\d+)/);
      if (!chapterMatch) continue;

      const chapterTitle = row.querySelector("a")?.textContent?.trim() || "";
      const dateEl = row.querySelector("time, .chapter-date");
      
      // Check for reading progress indicator (marks last read chapter)
      const hasReadingProgress = !!row.querySelector("i.fa-caret-right[data-original-title*='Reading Progress']");
      if (hasReadingProgress) {
        lastReadChapterIdx = idx;
      }
      
      chapters.push({
        id: parseInt(chapterMatch[1], 10),
        title: chapterTitle,
        url: `/chapter/${chapterMatch[1]}`,
        date: dateEl?.textContent?.trim(),
      });
      idx++;
    }
  }

  // Continue Reading link
  const continueLink = document.querySelector("a.btn[href*='/chapter/'][class*='continue'], a.btn-primary[href*='/chapter/']");
  let continueChapterId: number | undefined;
  if (continueLink) {
    const continueHref = continueLink.getAttribute("href") || "";
    const continueMatch = continueHref.match(/\/chapter\/(\d+)/);
    if (continueMatch) {
      continueChapterId = parseInt(continueMatch[1], 10);
    }
  }

  // Mark chapters as read based on reading progress indicator
  if (lastReadChapterIdx >= 0) {
    // Reading progress icon found - mark all chapters up to and including it as read
    for (let i = 0; i <= lastReadChapterIdx; i++) {
      chapters[i].isRead = true;
    }
  } else if (continueChapterId) {
    // Fallback: use continueChapterId as boundary
    // Chapters before continueChapterId are considered read
    const continueIdx = chapters.findIndex(c => c.id === continueChapterId);
    if (continueIdx > 0) {
      for (let i = 0; i < continueIdx; i++) {
        chapters[i].isRead = true;
      }
    }
  }

  // Parse bookmark state (Follow, Favorite, Read Later buttons)
  const followButton = document.querySelector("#follow-button");
  const favoriteButton = document.querySelector("#favorite-button");
  const rilButton = document.querySelector("#ril-button");
  const isFollowing = followButton?.classList?.contains("active") || false;
  const isFavorite = favoriteButton?.classList?.contains("active") || false;
  const isReadLater = rilButton?.classList?.contains("active") || false;
  
  // Get CSRF token (needed for bookmark actions)
  const csrfInput = document.querySelector('input[name="__RequestVerificationToken"]');
  const csrfToken = csrfInput?.getAttribute("value") || undefined;

  const fiction: Fiction = {
    id,
    title: titleEl?.textContent?.trim() || `Fiction ${id}`,
    author,
    url,
    coverUrl,
    description: descEl?.textContent?.trim(),
    stats: {
      rating,
      styleScore,
      storyScore,
      grammarScore,
      characterScore,
      views,
      averageViews,
      followers,
      favorites,
      ratings,
      pages,
    },
    chapters,
    continueChapterId,
    isFollowing,
    isFavorite,
    isReadLater,
    csrfToken,
  };

  setCache(cacheKey, JSON.stringify(fiction), ttl);
  return fiction;
}

export async function getChapter(chapterId: number, userId?: string, ttl?: number): Promise<ChapterContent | null> {
  const cacheKey = `chapter:${chapterId}`;
  const isPreCaching = ttl !== undefined;
  
  if (isPreCaching) {
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`Returning cached chapter: ${chapterId}`);
      return JSON.parse(cached);
    }
  }
  
  const { page, content } = await getPage(
    `${ROYAL_ROAD_BASE_URL}/fiction/0/chapter/${chapterId}`, 
    ".chapter-content",
    isPreCaching ? undefined : userId
  );

  // Variables for navigation and fiction info
  let navInfo = { prevUrl: null as string | null, nextUrl: null as string | null };
  let fictionInfo = { fictionId: 0, fictionTitle: "", fictionUrl: "" };

  if (page) {
    // Wait for "Mark as Read" when reading live (only with browser)
    if (!isPreCaching) {
      await page.waitForTimeout(2000);
    }

    // Get navigation info via JS evaluation
    navInfo = await page.evaluate(() => {
      let prevUrl = null;
      let nextUrl = null;
      
      const navButtons = document.querySelector('.nav-buttons');
      if (navButtons) {
        const links = navButtons.querySelectorAll('a.btn[href*="/chapter/"]');
        for (const link of links) {
          const text = link.textContent || '';
          if (text.includes('Previous')) {
            prevUrl = link.getAttribute('href');
          }
          if (text.includes('Next')) {
            nextUrl = link.getAttribute('href');
          }
        }
      }
      
      return { prevUrl, nextUrl };
    });

    // Get fiction info via JS evaluation
    fictionInfo = await page.evaluate(() => {
      const urlMatch = window.location.href.match(/\/fiction\/(\d+)/);
      const fictionIdFromUrl = urlMatch ? parseInt(urlMatch[1], 10) : 0;
      
      const fictionLink = document.querySelector(".fic-title a, a.fic-title, .fiction-title a, .fic-header a[href*='/fiction/']") ||
                          document.querySelector(".row a[href*='/fiction/']:not([href*='/chapter/']):not(.btn)");
      const href = fictionLink?.getAttribute("href") || "";
      const hrefMatch = href.match(/\/fiction\/(\d+)/);
      
      return {
        fictionId: fictionIdFromUrl || (hrefMatch ? parseInt(hrefMatch[1], 10) : 0),
        fictionTitle: fictionLink?.textContent?.trim() || "",
        fictionUrl: href,
      };
    });

    await page.close();
  } else {
    // Parse navigation and fiction info from HTML (HTTP fetch path)
    const { document: doc } = parseHTML(content);
    
    // Navigation links
    const navButtons = doc.querySelector('.nav-buttons');
    if (navButtons) {
      const links = navButtons.querySelectorAll('a.btn[href*="/chapter/"]');
      for (const link of links) {
        const text = link.textContent || '';
        const href = link.getAttribute('href');
        if (text.includes('Previous')) {
          navInfo.prevUrl = href;
        }
        if (text.includes('Next')) {
          navInfo.nextUrl = href;
        }
      }
    }
    
    // Fiction info from link
    const fictionLink = doc.querySelector(".fic-title a, a.fic-title, .fiction-title a, .fic-header a[href*='/fiction/']") ||
                        doc.querySelector(".row a[href*='/fiction/']:not([href*='/chapter/']):not(.btn)");
    if (fictionLink) {
      const href = fictionLink.getAttribute("href") || "";
      const hrefMatch = href.match(/\/fiction\/(\d+)/);
      fictionInfo = {
        fictionId: hrefMatch ? parseInt(hrefMatch[1], 10) : 0,
        fictionTitle: fictionLink.textContent?.trim() || "",
        fictionUrl: href,
      };
    }
  }

  const { document } = parseHTML(content);

  // Chapter title
  const titleEl = document.querySelector("h1.font-white, .chapter-title h1, h1");
  const title = titleEl?.textContent?.trim() || `Chapter ${chapterId}`;

  // Extract clean content
  const contentEl = document.querySelector(".chapter-inner.chapter-content, .chapter-content");
  
  let cleanContent = "";
  if (contentEl) {
    const cloned = contentEl.cloneNode(true) as Element;
    
    // Extract hidden classes (anti-piracy text)
    const hiddenClasses: string[] = [];
    const styleMatches = content.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
    for (const styleBlock of styleMatches) {
      const ruleMatches = styleBlock.matchAll(/\.([a-zA-Z0-9_-]+)\s*\{[^}]*display\s*:\s*none[^}]*\}/gi);
      for (const match of ruleMatches) {
        hiddenClasses.push(match[1]);
      }
    }
    
    if (hiddenClasses.length > 0) {
      console.log(`Found ${hiddenClasses.length} hidden classes to remove (anti-piracy)`);
    }
    for (const className of hiddenClasses) {
      cloned.querySelectorAll(`.${className}`).forEach(el => el.remove());
    }
    
    // Remove unwanted elements
    cloned.querySelectorAll(".author-note, .ad, .portlet, script, .hidden, .ads, iframe, noscript").forEach(el => el.remove());
    
    // Clean obfuscated classes
    cloned.querySelectorAll('[class]').forEach(el => {
      const classList = el.getAttribute('class') || '';
      const cleanClasses = classList.split(' ').filter(c => c.length < 20 && !/^[a-z]{20,}$/i.test(c)).join(' ');
      if (cleanClasses) {
        el.setAttribute('class', cleanClasses);
      } else {
        el.removeAttribute('class');
      }
    });
    
    // Keep only safe styles. width is allowed so tables keep their authored
    // column layout — stripped, RR tables auto-size from content and overflow
    // the reader column (bleeding into the next page on e-ink).
    cloned.querySelectorAll('[style]').forEach(el => {
      const style = el.getAttribute('style') || '';
      const safeStyles: string[] = [];
      
      const textAlign = style.match(/text-align:\s*([^;]+)/i);
      const fontWeight = style.match(/font-weight:\s*([^;]+)/i);
      const fontStyle = style.match(/font-style:\s*([^;]+)/i);
      const width = style.match(/(?:^|;)\s*width:\s*(\d+(?:\.\d+)?%|[0-9]+px)/i);
      
      if (textAlign) safeStyles.push(`text-align: ${textAlign[1].trim()}`);
      if (fontWeight) safeStyles.push(`font-weight: ${fontWeight[1].trim()}`);
      if (fontStyle) safeStyles.push(`font-style: ${fontStyle[1].trim()}`);
      if (width) safeStyles.push(`width: ${width[1]}`);
      
      if (safeStyles.length > 0) {
        el.setAttribute('style', safeStyles.join('; '));
      } else {
        el.removeAttribute('style');
      }
    });
    
    // Mark multi-column tables as responsive. RR's cell widths target desktop
    // layouts; keeping them with a large e-ink font makes useful columns too
    // narrow. The reader's auto layout will size columns from their content.
    cloned.querySelectorAll('table').forEach((table) => {
      const widthRow = [...table.querySelectorAll('tr')].find((row) => {
        const cells = [...row.querySelectorAll(':scope > td, :scope > th')];
        return cells.length > 1 && cells.every((c) =>
          !c.getAttribute('colspan') && /width\s*:\s*\d/.test(c.getAttribute('style') || '')
        );
      });
      if (!widthRow) return;
      const rows = [...table.querySelectorAll('tr')];
      const columnCount = Math.max(0, ...rows.map((row) =>
        [...row.querySelectorAll(':scope > td, :scope > th')]
          .reduce((count, cell) => count + Number(cell.getAttribute('colspan') || 1), 0)
      ));
      const classes = ['responsive-table'];
      if (columnCount >= 4 || rows.length >= 8) classes.push('large-table');
      table.setAttribute('class', `${table.getAttribute('class') || ''} ${classes.join(' ')}`.trim());
      table.querySelectorAll('td, th').forEach((cell) => {
        const style = cell.getAttribute('style') || '';
        const withoutWidth = style
          .replace(/(?:^|;)\s*width\s*:\s*[^;]+;?/i, '')
          .replace(/^\s*;|;\s*$/g, '')
          .trim();
        if (withoutWidth) cell.setAttribute('style', withoutWidth);
        else cell.removeAttribute('style');
      });
    });
    
    cleanContent = cloned.innerHTML;
    
    if (shouldPrependTitle(title, cleanContent)) {
      cleanContent = `<h2 class="chapter-title-prepended">${escapeHtml(title)}</h2>\n${cleanContent}`;
    }
  }

  // Convert nav URLs to proxy URLs
  const prevChapterUrl = navInfo.prevUrl ? navInfo.prevUrl.replace(/.*\/chapter\/(\d+).*/, "/chapter/$1") : undefined;
  const nextChapterUrl = navInfo.nextUrl ? navInfo.nextUrl.replace(/.*\/chapter\/(\d+).*/, "/chapter/$1") : undefined;

  // Extract next chapter ID for pre-caching
  const nextChapterIdMatch = nextChapterUrl?.match(/\/chapter\/(\d+)/);
  const nextChapterId = nextChapterIdMatch ? parseInt(nextChapterIdMatch[1], 10) : undefined;

  const result: ChapterContent = {
    id: chapterId,
    fictionId: fictionInfo.fictionId,
    title,
    content: cleanContent,
    prevChapterUrl,
    nextChapterUrl,
    fictionTitle: fictionInfo.fictionTitle,
    fictionUrl: `/fiction/${fictionInfo.fictionId}`,
  };

  setCache(cacheKey, JSON.stringify(result), CACHE_TTL.CHAPTER);

  if (!isPreCaching && userId) {
    if (fictionInfo.fictionId) {
      const fictionCacheKey = `fiction:${fictionInfo.fictionId}`;
      if (deleteCache(fictionCacheKey)) {
        console.log(`Invalidated fiction cache: ${fictionCacheKey}`);
      }
    }
    const followsCacheKey = `follows:${userId}`;
    if (deleteCache(followsCacheKey)) {
      console.log(`Invalidated follows cache`);
    }
  }

  if (nextChapterId && !isPreCaching) {
    console.log(`Pre-caching next chapter: ${nextChapterId}`);
    setTimeout(async () => {
      try {
        await getChapter(nextChapterId, undefined, CACHE_TTL.CHAPTER);
      } catch (e) {
        console.error(`Failed to pre-cache chapter ${nextChapterId}:`, e);
      }
    }, 100);
  }

  return result;
}

export async function validateCookies(userId: string): Promise<boolean> {
  try {
    await createContext(userId);
    const { page, content } = await getPage(`${ROYAL_ROAD_BASE_URL}/my/follows`, undefined, userId);
    if (page) await page.close();
    
    const valid = !content.includes('action="/account/login"') && !content.includes("Sign In");
    
    if (!valid && ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
      console.log("[Scraper] Cookie validation failed, attempting auto-login...");
      const loggedIn = await performAutoLogin(userId);
      if (loggedIn) {
        await createContext(userId);
        const { page: retryPage, content: retryContent } = await getPage(`${ROYAL_ROAD_BASE_URL}/my/follows`, undefined, userId, true);
        if (retryPage) await retryPage.close();
        return !retryContent.includes('action="/account/login"') && !retryContent.includes("Sign In");
      }
    }
    
    return valid;
  } catch (e) {
    console.error("Cookie validation failed:", e);
    return false;
  }
}

export async function searchFictions(query: string, userId?: string): Promise<Fiction[]> {
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `${ROYAL_ROAD_BASE_URL}/fictions/search?title=${encodedQuery}`;
  
  const { page, content } = await getPage(searchUrl, ".fiction-list-item", userId);
  if (page) await page.close();
  
  return parseFictionList(content);
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
      
      // Invalidate caches so we get fresh state
      deleteCache(`fiction:${fictionId}`);
      deleteCache(`follows:${userId}`);
      deleteCache(`readlater:${userId}`);
      
      return { success: true };
    }
    
    console.error(`[Scraper] Bookmark failed with status: ${response.status}`);
    return { success: false, error: `Request failed (${response.status})` };
  } catch (error) {
    console.error(`[Scraper] Bookmark error:`, error);
    return { success: false, error: "Network error" };
  }
}
