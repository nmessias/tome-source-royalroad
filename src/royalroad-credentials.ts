import {
  getUserCredentials,
  getUserCredential,
  setUserCredential,
  clearUserCredentials,
  hasUserCredentials,
} from "./credentials";

const SOURCE = "royalroad" as const;

export interface RoyalRoadCookie {
  name: string;
  value: string;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export function getRoyalRoadCookies(userId: string): RoyalRoadCookie[] {
  const credentials = getUserCredentials(userId, SOURCE);
  return credentials.map((c) => ({
    name: c.name,
    value: c.value,
  }));
}

export function getRoyalRoadCookiesForPlaywright(userId: string): PlaywrightCookie[] {
  const cookies = getRoyalRoadCookies(userId);
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: ".royalroad.com",
    path: "/",
  }));
}

export function getRoyalRoadCookie(userId: string, name: string): string | null {
  const credential = getUserCredential(userId, SOURCE, name);
  return credential?.value ?? null;
}

export function setRoyalRoadCookie(userId: string, name: string, value: string): void {
  setUserCredential(userId, SOURCE, name, value);

  // cf_clearance is bound to this machine's IP, not to a user, so every copy
  // the plugin learns — from a browser visit, from auto-login, or pasted into
  // Settings — is mirrored into the shared slot. Without this, a clearance the
  // user pastes by hand is ignored by anonymous fetches (public pages), which
  // is exactly when it is needed most.
  if (name === "cf_clearance") setSharedCookie(name, value);
}

export function hasRoyalRoadSession(userId: string): boolean {
  const identityCookie = getUserCredential(userId, SOURCE, ".AspNetCore.Identity.Application");
  return !!identityCookie;
}

// ============ Session health ============

/**
 * A cookie existing is not the same as a cookie working. Once an upstream fetch
 * proves the session is dead we remember that for a while, so the scraper can
 * go straight to anonymous for public pages instead of re-discovering the
 * rejection on every request, and the background cache-warm job can stop
 * re-fetching the login page every twenty minutes.
 *
 * Short by design: a pasted cookie in Settings clears it immediately.
 */
const SESSION_DEAD_TTL_MS = 10 * 60 * 1000;
let deadUntil = 0;
let deadFor: string | null = null;

export function markSessionDead(userId: string): void {
  deadFor = userId;
  deadUntil = Date.now() + SESSION_DEAD_TTL_MS;
}

export function clearSessionState(userId: string): void {
  if (deadFor === userId) {
    deadFor = null;
    deadUntil = 0;
  }
}

export function isSessionKnownDead(userId: string): boolean {
  if (deadFor !== userId) return false;
  if (Date.now() > deadUntil) {
    deadFor = null;
    deadUntil = 0;
    return false;
  }
  return true;
}

export function clearRoyalRoadCookies(userId: string): void {
  clearUserCredentials(userId, SOURCE);
}

// ============ Process-wide cookies ============

/**
 * `cf_clearance` is bound to the IP and browser that solved the Cloudflare
 * challenge, not to a Tome user. Storing it per user meant an anonymous
 * request — which is what public fiction/chapter/search pages use — sent no
 * cookies at all and never benefited from a clearance any other request had
 * already earned, so every read re-challenged from scratch.
 *
 * It lives under a sentinel owner so it survives credential changes and is
 * shared by every user on the instance.
 */
const SHARED_OWNER = "__shared__";

export function setSharedCookie(name: string, value: string): void {
  setUserCredential(SHARED_OWNER, SOURCE, name, value);
}

export function getSharedCookie(name: string): string | null {
  return getUserCredential(SHARED_OWNER, SOURCE, name)?.value ?? null;
}

export function clearSharedCookies(): void {
  clearUserCredentials(SHARED_OWNER, SOURCE);
}

export function hasAnyRoyalRoadCredentials(userId: string): boolean {
  return hasUserCredentials(userId, SOURCE);
}
