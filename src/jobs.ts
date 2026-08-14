/**
 * Background jobs for cache warming
 */
import { isCached } from "tome";
import { hasRoyalRoadSession } from "./royalroad-credentials";
import { CACHE_TTL } from "tome";
import { TOPLISTS } from "./config";
import { Database } from "bun:sqlite";
import { DB_PATH } from "tome";

let jobsRunning = false;
let followsJobInterval: ReturnType<typeof setInterval> | null = null;
let toplistsJobInterval: ReturnType<typeof setInterval> | null = null;

function getAdminUserId(): string | null {
  const db = new Database(DB_PATH);
  const admin = db.query("SELECT id FROM user WHERE role = 'admin' LIMIT 1").get() as { id: string } | null;
  db.close();
  return admin?.id ?? null;
}

async function getScraperFunctions() {
  const scraper = await import("./scraper");
  return {
    getFollows: scraper.getFollows,
    getToplist: scraper.getToplist,
    getChapter: scraper.getChapter,
    getFiction: scraper.getFiction,
  };
}

/**
 * Warm cache for follows and their next chapters
 */
async function warmFollowsCache(): Promise<void> {
  const adminUserId = getAdminUserId();
  if (!adminUserId) {
    console.log("[Job] Skipping follows cache - no admin user found");
    return;
  }
  
  if (!hasRoyalRoadSession(adminUserId)) {
    console.log("[Job] Skipping follows cache - no session cookies");
    return;
  }

  console.log("[Job] Warming follows cache...");
  
  try {
    const { getFollows, getChapter, getFiction } = await getScraperFunctions();
    
    if (isCached("follows")) {
      console.log("[Job] Follows list already cached, skipping fetch");
    }
    
    const follows = await getFollows(adminUserId);
    console.log(`[Job] Got ${follows.length} followed fictions`);
    
    let cachedChapters = 0;
    let skippedChapters = 0;
    
    for (const fiction of follows) {
      try {
        const fictionCacheKey = `fiction:${fiction.id}`;
        if (!isCached(fictionCacheKey)) {
          const fictionDetails = await getFiction(fiction.id, adminUserId, CACHE_TTL.FICTION);
          if (!fictionDetails?.chapters?.length) continue;
          
          let nextChapterId: number | undefined;
          
          if (fictionDetails.continueChapterId) {
            nextChapterId = fictionDetails.continueChapterId;
          } else if (fiction.lastReadChapterId) {
            const chapters = fictionDetails.chapters;
            const lastReadIdx = chapters.findIndex(c => c.id === fiction.lastReadChapterId);
            if (lastReadIdx !== -1 && lastReadIdx < chapters.length - 1) {
              nextChapterId = chapters[lastReadIdx + 1].id;
            }
          } else if (fictionDetails.chapters[0]) {
            nextChapterId = fictionDetails.chapters[0].id;
          }
          
          if (nextChapterId) {
            const chapterCacheKey = `chapter:${nextChapterId}`;
            if (isCached(chapterCacheKey)) {
              skippedChapters++;
            } else {
              await getChapter(nextChapterId, adminUserId, CACHE_TTL.CHAPTER);
              cachedChapters++;
              console.log(`[Job] Cached next chapter ${nextChapterId} for "${fiction.title}"`);
            }
          }
          
          await new Promise(r => setTimeout(r, 1000));
        } else {
          skippedChapters++;
        }
      } catch (err) {
        console.error(`[Job] Error caching chapter for fiction ${fiction.id}:`, err);
      }
    }
    
    console.log(`[Job] Finished warming follows cache. Cached: ${cachedChapters}, Skipped: ${skippedChapters}`);
  } catch (err) {
    console.error("[Job] Error warming follows cache:", err);
  }
}

/**
 * Warm cache for toplists
 */
async function warmToplistsCache(): Promise<void> {
  console.log("[Job] Warming toplists cache...");
  
  try {
    const { getToplist } = await getScraperFunctions();
    
    let cached = 0;
    let skipped = 0;
    
    for (const toplist of TOPLISTS) {
      try {
        const cacheKey = `toplist:${toplist.slug}`;
        if (isCached(cacheKey)) {
          skipped++;
          console.log(`[Job] Toplist already cached: ${toplist.name}`);
        } else {
          await getToplist(toplist, undefined, CACHE_TTL.TOPLIST);
          cached++;
          console.log(`[Job] Cached toplist: ${toplist.name}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error(`[Job] Error caching toplist ${toplist.slug}:`, err);
      }
    }
    
    console.log(`[Job] Finished warming toplists cache. Cached: ${cached}, Skipped: ${skipped}`);
  } catch (err) {
    console.error("[Job] Error warming toplists cache:", err);
  }
}

/**
 * Start all background jobs
 */
export function startJobs(): void {
  if (jobsRunning) {
    console.log("[Job] Jobs already running");
    return;
  }
  
  jobsRunning = true;
  console.log("[Job] Starting background cache jobs...");
  
  // Run initial cache warming after a delay (give browser time to init)
  // Longer delay in production for low-RAM environments
  const initialDelay = process.env.NODE_ENV === "production" ? 30000 : 10000;
  
  setTimeout(async () => {
    await warmToplistsCache();
    await warmFollowsCache();
  }, initialDelay);
  
  // Schedule follows cache warming every 20 minutes
  followsJobInterval = setInterval(warmFollowsCache, CACHE_TTL.FOLLOWS * 1000);
  
  // Schedule toplists cache warming every 6 hours
  toplistsJobInterval = setInterval(warmToplistsCache, CACHE_TTL.TOPLIST * 1000);
  
  console.log("[Job] Background jobs scheduled");
  console.log(`[Job] - Follows: every ${CACHE_TTL.FOLLOWS / 60} minutes`);
  console.log(`[Job] - Toplists: every ${CACHE_TTL.TOPLIST / 60 / 60} hours`);
}

/**
 * Stop all background jobs
 */
export function stopJobs(): void {
  if (followsJobInterval) {
    clearInterval(followsJobInterval);
    followsJobInterval = null;
  }
  if (toplistsJobInterval) {
    clearInterval(toplistsJobInterval);
    toplistsJobInterval = null;
  }
  jobsRunning = false;
  console.log("[Job] Background jobs stopped");
}

/**
 * Manually trigger cache warming (useful after login)
 */
export async function triggerCacheWarm(): Promise<void> {
  console.log("[Job] Manual cache warm triggered");
  await warmToplistsCache();
  await warmFollowsCache();
}
