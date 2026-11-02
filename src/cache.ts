/**
 * Cache helpers the core `tome` package does not expose.
 *
 * Core offers exact-key deletes plus `clearCacheByType` ("fiction:%" and
 * friends). Fiction pages are cached *per user* — they carry the antiforgery
 * token and the reader's own follow/read state — so invalidating one fiction
 * has to delete `fiction:<id>:*` without touching other fictions, which is a
 * prefix delete on a mid-key segment.
 *
 * Shares the same SQLite file core uses; opened once for the process.
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "tome";

const db = new Database(DB_PATH);

/**
 * Delete every cache row whose key starts with `prefix`.
 * Returns the number of rows removed (0 when nothing matched).
 */
export function deleteCacheByPrefix(prefix: string): number {
  // Escape LIKE wildcards so an odd prefix can never widen the match.
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const result = db.run("DELETE FROM cache WHERE url LIKE ? ESCAPE '\\'", [`${escaped}%`]);
  return result.changes;
}

const now = () => Math.floor(Date.now() / 1000);

/** Keep existing rows for at least `ttlSeconds` more (never shortens one). */
export function extendCache(keys: string[], ttlSeconds: number): void {
  const until = now() + ttlSeconds;
  const extend = db.query("UPDATE cache SET expires_at = MAX(expires_at, ?) WHERE url = ? AND expires_at > ?");
  db.transaction(() => { for (const key of keys) extend.run(until, key, now()); })();
}

/** The chapter ids with a live or stale copy cached, in one query. */
export function savedChapterIds(ids: number[]): Set<number> {
  const rows = db.query(
    `SELECT value AS id FROM json_each(?) WHERE EXISTS (
       SELECT 1 FROM cache WHERE url IN ('chapter:' || value, 'stale:chapter:' || value) AND expires_at > ?)`,
  ).all(JSON.stringify(ids), now()) as { id: number }[];
  return new Set(rows.map((row) => row.id));
}

/** Unexpired rows whose key starts with `prefix`. */
export function getCacheByPrefix(prefix: string): { key: string; value: string }[] {
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db.query("SELECT url AS key, content AS value FROM cache WHERE url LIKE ? ESCAPE '\\' AND expires_at > ?")
    .all(`${escaped}%`, now()) as { key: string; value: string }[];
}
