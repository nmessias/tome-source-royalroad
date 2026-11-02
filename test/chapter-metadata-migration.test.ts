import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { backfillChapterMetadata } from "../src/chapter-metadata-migration";

test("indexes valid legacy chapters without changing or exposing unrelated rows", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE cache (url TEXT PRIMARY KEY, content TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  const put = db.query("INSERT INTO cache VALUES (?, ?, 9999999999)");
  const content = JSON.stringify({ id: 7, fictionId: 12, fictionTitle: "Example", content: "text" });
  put.run("chapter:7", content);
  put.run("chapter:8", "{invalid");
  put.run("fwn:chapter:7", "untouched");
  backfillChapterMetadata(db);
  backfillChapterMetadata(db);
  const row = db.query("SELECT content FROM cache WHERE url = ?").get("chapter-meta:royalroad:12:7") as { content: string };
  expect(JSON.parse(row.content).cacheKey).toBe("chapter:7");
  expect((db.query("SELECT content FROM cache WHERE url = 'chapter:7'").get() as { content: string }).content).toBe(content);
  expect(db.query("SELECT content FROM cache WHERE url = 'chapter-meta:royalroad:12:8'").get()).toBeNull();
  expect(db.query("SELECT content FROM cache WHERE url = 'fwn:chapter:7'").get()).toBeTruthy();
  expect((db.query("SELECT COUNT(*) AS n FROM royalroad_migrations").get() as { n: number }).n).toBe(1);
  db.close();
});
