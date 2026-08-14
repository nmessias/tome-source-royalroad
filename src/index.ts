/**
 * tome-source-royalroad — Royal Road source plugin for Tome.
 *
 * Exports a `source` (Source) and a `feature` (Feature). Load with:
 *   bun add tome-source-royalroad
 *   TOME_PLUGINS=tome-source-royalroad
 *
 * Types and shared runtime come from the `tome` package (core).
 */
import type { Feature } from "tome";
import { ENABLE_BROWSER } from "./config";
import { royalroadSource as source } from "./source";
import { startJobs, stopJobs } from "./jobs";
import { migrateRoyalRoad } from "./migrations";
import { initBrowser, closeBrowser } from "./scraper";

const feature: Feature = {
  name: "royalroad",
  migrations: migrateRoyalRoad,
  start() {
    if (ENABLE_BROWSER) {
      initBrowser().catch(console.error);
    }
    startJobs();
  },
  async stop() {
    stopJobs();
    if (ENABLE_BROWSER) {
      await closeBrowser();
    }
  },
};

export { source, feature };
