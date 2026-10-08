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
