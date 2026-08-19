/**
 * RoyalRoad source adapter
 *
 * Wraps the RoyalRoad scraper services behind the Source contract (ADR-0001).
 * All scraping logic lives in this package (scraper.ts, royalroad-*).
 */
import type { Source, CredentialField } from "tome";
import type { ChapterContent } from "tome";
import { TOPLISTS } from "./config";
import {
  getFollows,
  getHistory,
  getReadLater,
  getToplist,
  getToplistCached,
  getFiction,
  getChapter,
  validateCookies,
  createContext,
  searchFictions,
  setBookmark,
} from "./scraper";
import {
  hasRoyalRoadSession,
  setRoyalRoadCookie,
  clearRoyalRoadCookies,
} from "./royalroad-credentials";
import { performAutoLogin, ROYAL_ROAD_AUTO_LOGIN_ENABLED } from "./royalroad-auth";
import { triggerCacheWarm } from "./jobs";
import { clearCache } from "tome";

const RR = "royalroad";

function parseId(ref: string): number | null {
  const id = parseInt(ref, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeChapter(chapter: ChapterContent, fallbackFictionRef: string): ChapterContent {
  const fictionRef =
    chapter.fictionRef || chapter.fictionSlug || String(chapter.fictionId || fallbackFictionRef);
  return {
    ...chapter,
    ref: chapter.ref ?? String(chapter.id),
    fictionRef,
    prevRef:
      chapter.prevRef ??
      (chapter.prevChapterUrl ? chapter.prevChapterUrl.replace(/^\/chapter\//, "") || null : null),
    nextRef:
      chapter.nextRef ??
      (chapter.nextChapterUrl ? chapter.nextChapterUrl.replace(/^\/chapter\//, "") || null : null),
  };
}

export const royalroadSource: Source = {
  name: RR,
  displayName: "Royal Road",
  description: "Web fiction from royalroad.com",
  capabilities: {
    search: true,
    follows: true,
    history: true,
    toplists: true,
    readLater: true,
    bookmarks: true,
    library: false,
    credentials: true,
  },
  navLinks: [
    { href: `/read/${RR}/search`, label: "Search" },
    { href: `/read/${RR}/follows`, label: "Follows" },
    { href: `/read/${RR}/read-later`, label: "Read Later" },
    { href: `/read/${RR}/history`, label: "History" },
    { href: `/read/${RR}/toplists`, label: "Top Lists" },
  ],
  toplists: TOPLISTS,

  // ---- core trio ----
  async search(query, userId) {
    return searchFictions(query, userId);
  },
  async getFiction(ref, userId) {
    const id = parseId(ref);
    if (id === null) return null;
    return getFiction(id, userId);
  },
  async getChapter(ref, chapterRef, userId) {
    const id = parseId(chapterRef);
    if (id === null) return null;
    const chapter = await getChapter(id, userId);
    if (!chapter) return null;
    return normalizeChapter(chapter, ref);
  },

  // ---- capability ops ----
  getFollows(userId) {
    return getFollows(userId);
  },
  getHistory(userId) {
    return getHistory(userId);
  },
  getReadLater(userId) {
    return getReadLater(userId);
  },
  getToplist(toplist, userId, ttl) {
    return getToplist(toplist, userId, ttl);
  },
  getToplistCached(toplist) {
    return getToplistCached(toplist);
  },
  async setBookmark(userId, fictionRef, type, mark, csrf) {
    const id = parseId(fictionRef);
    if (id === null) return { success: false, error: "Invalid fiction id" };
    return setBookmark(userId, id, type as "follow" | "favorite" | "ril", mark, csrf);
  },
  // RR "marks read" by re-fetching the chapter in an authenticated context
  async updateProgress(userId, _fictionRef, chapterRef) {
    const id = parseId(chapterRef);
    if (id === null) return;
    // Mark-as-read requires a real authenticated upstream fetch (that's how RR
    // records read state); forceLive bypasses the cache-first fast path.
    await getChapter(id, userId, undefined, { forceLive: true });
  },

  // ---- credentials ----
  credentialFields: [
    {
      name: "identity",
      label: ".AspNetCore.Identity.Application",
      placeholder: "Paste your auth cookie value here",
      required: true,
      textarea: true,
      hint: "Find it in your browser's developer tools (F12 → Application → Cookies).",
    },
    {
      name: "cfclearance",
      label: "cf_clearance (optional)",
      placeholder: "Paste if you get Cloudflare errors",
      textarea: true,
      hint: "Only needed if you encounter Cloudflare blocking issues.",
    },
  ] as CredentialField[],
  async saveCredentials(userId, values) {
    const identity = values.identity?.trim();
    if (!identity) {
      return { success: false, error: "The .AspNetCore.Identity.Application cookie is required." };
    }
    setRoyalRoadCookie(userId, ".AspNetCore.Identity.Application", identity);
    if (values.cfclearance?.trim()) {
      setRoyalRoadCookie(userId, "cf_clearance", values.cfclearance.trim());
    }
    await createContext(userId);
    const valid = await validateCookies(userId);
    if (valid) {
      triggerCacheWarm().catch(console.error);
      return { success: true };
    }
    return { success: true, warning: "Cookies saved but validation failed. Check your cookie values." };
  },
  async clearCredentials(userId) {
    clearRoyalRoadCookies(userId);
    clearCache();
    await createContext(userId);
  },
  hasSession(userId) {
    return hasRoyalRoadSession(userId);
  },
  autoLogin: {
    enabled: ROYAL_ROAD_AUTO_LOGIN_ENABLED,
    async refresh(userId) {
      const ok = await performAutoLogin(userId);
      if (!ok) return false;
      await createContext(userId);
      await validateCookies(userId);
      triggerCacheWarm().catch(console.error);
      return true;
    },
  },
};
