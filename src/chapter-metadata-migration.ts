import type { Database } from "bun:sqlite";

/** Index recognizable legacy chapter rows without altering their contents. */
export function backfillChapterMetadata(db: Database): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache'").get()) return;
  db.run("CREATE TABLE IF NOT EXISTS royalroad_migrations (name TEXT PRIMARY KEY)");
  const marker = "chapter-metadata-v1";
  if (db.query("SELECT 1 FROM royalroad_migrations WHERE name = ?").get(marker)) return;

  const now = Math.floor(Date.now() / 1000);
  const rows = db.query("SELECT url, content, expires_at FROM cache WHERE url GLOB 'chapter:[0-9]*' AND expires_at > ?");
  const insert = db.query("INSERT OR IGNORE INTO cache (url, content, expires_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const row of rows.iterate(now) as Iterable<{ url: string; content: string; expires_at: number }>) {
      const match = /^chapter:([1-9]\d*)$/.exec(row.url);
      if (!match) continue;
      try {
        const chapter = JSON.parse(row.content);
        if (String(chapter.id) !== match[1] || !Number.isSafeInteger(chapter.fictionId) || chapter.fictionId <= 0) continue;
        const fictionRef = String(chapter.fictionId);
        const chapterRef = match[1];
        const meta = {
          source: "royalroad",
          fictionRef,
          chapterRef,
          fictionTitle: typeof chapter.fictionTitle === "string" ? chapter.fictionTitle : "",
          cacheKey: row.url,
          lastAccessedAt: 0,
        };
        insert.run(`chapter-meta:royalroad:${fictionRef}:${chapterRef}`, JSON.stringify(meta), row.expires_at);
      } catch {
        // Old or unrelated cache rows remain untouched.
      }
    }
    db.run("INSERT INTO royalroad_migrations (name) VALUES (?)", [marker]);
  })();
}
