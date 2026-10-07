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

// Royal Road
export const ROYAL_ROAD_BASE_URL = "https://www.royalroad.com";
export const ROYAL_ROAD_USERNAME = process.env.ROYAL_ROAD_USERNAME || "";
export const ROYAL_ROAD_PASSWORD = process.env.ROYAL_ROAD_PASSWORD || "";
export const ROYAL_ROAD_AUTO_LOGIN_ENABLED = !!(ROYAL_ROAD_USERNAME && ROYAL_ROAD_PASSWORD);

// Scraper timeouts (hardcoded for reliability - NODE_ENV might not be set)
export const SCRAPER_TIMEOUT = 60000;  // 60 seconds for navigation
export const SCRAPER_SELECTOR_TIMEOUT = 20000;  // 20 seconds for selectors

// Toplists configuration
export const TOPLISTS: ToplistType[] = [
  { slug: 'rising-stars', name: 'Rising Stars', url: `${ROYAL_ROAD_BASE_URL}/fictions/rising-stars` },
  { slug: 'best-rated', name: 'Best Rated', url: `${ROYAL_ROAD_BASE_URL}/fictions/best-rated` },
  { slug: 'weekly-popular', name: 'Weekly Popular', url: `${ROYAL_ROAD_BASE_URL}/fictions/weekly-popular` },
  { slug: 'active-popular', name: 'Active Popular', url: `${ROYAL_ROAD_BASE_URL}/fictions/active-popular` },
];
