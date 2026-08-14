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
}

export function hasRoyalRoadSession(userId: string): boolean {
  const identityCookie = getUserCredential(userId, SOURCE, ".AspNetCore.Identity.Application");
  return !!identityCookie;
}

export function clearRoyalRoadCookies(userId: string): void {
  clearUserCredentials(userId, SOURCE);
}

export function hasAnyRoyalRoadCredentials(userId: string): boolean {
  return hasUserCredentials(userId, SOURCE);
}
