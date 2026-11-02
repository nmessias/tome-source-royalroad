/** Separate authenticated pages from anonymous fallback and old cached rows. */
export function fictionCacheKey(id: number | string, userId?: string, usableSession = false): string {
  return `fiction:${id}:v2:${userId && usableSession ? `user:${userId}` : 'anon'}`;
}
