import type { Fiction } from 'tome';

/** Read only this user's retained or legacy fiction, and never reuse a saved CSRF token. */
export function readSavedFiction(
  read: (key: string) => string | null,
  key: string,
  id: number,
  userId?: string,
): (Fiction & { cacheStale: true }) | null {
  const legacy = `fiction:${id}:${userId ?? 'anon'}`;
  for (const candidate of [`stale:${key}`, legacy, `stale:${legacy}`]) {
    const raw = read(candidate);
    if (!raw) continue;
    try {
      const fiction = JSON.parse(raw) as Fiction;
      if (fiction.id !== id || typeof fiction.title !== 'string' || !fiction.title) continue;
      return { ...fiction, csrfToken: undefined, cacheStale: true };
    } catch { /* Skip damaged cache rows. */ }
  }
  return null;
}
