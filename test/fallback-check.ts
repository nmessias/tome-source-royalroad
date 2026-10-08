/**
 * Verifies the dead-session fallback: public pages must still render when the
 * stored cookie exists but Royal Road rejects it.
 *
 * Not part of `bun test` — needs the network and a browser. Run:
 *   DISPLAY=:99 ENABLE_BROWSER=true bun run test/fallback-check.ts
 */
import { Database } from "bun:sqlite";

const DB_PATH = "./data/sessions.db";
const db = new Database(DB_PATH);
db.run(`
  CREATE TABLE IF NOT EXISTS user_source_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
    value TEXT NOT NULL, updatedAt INTEGER,
    UNIQUE(userId, source, name)
  )
`);
// A cookie that is syntactically valid but dead: present, so hasSession() is
// true, but rejected upstream.
db.run(
  `INSERT OR REPLACE INTO user_source_credentials (userId, source, name, value, updatedAt)
   VALUES ('test-user', 'royalroad', '.AspNetCore.Identity.Application', 'CfDJ8DEADCOOKIEnotreal', unixepoch())`
);
db.close();

const { isSessionKnownDead } = await import("../src/royalroad-credentials");
const scraper = await import("../src/scraper");
void scraper;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("--- public pages with a dead session cookie present ---");
try {
  const fiction = await scraper.getFiction(192682, "test-user");
  check("fiction still loads", fiction !== null);
  check(
    "fiction is the real page, not a stub",
    !!fiction?.title && !/^Fiction \d+$/.test(fiction.title),
    fiction?.title?.slice(0, 45)
  );
  check("fiction still lists all chapters", (fiction?.chapters?.length ?? 0) === 27, `${fiction?.chapters?.length} chapters`);

  const chapter = await scraper.getChapter(3966586, "test-user");
  check("chapter still loads", chapter !== null);
  check("chapter has content", (chapter?.content?.length ?? 0) > 500, `${chapter?.content?.length} chars`);

  const results = await scraper.searchFictions("hewho", "test-user");
  check("search still returns results", results.length > 0, `${results.length} fictions`);
} catch (e) {
  check("public pages survived the dead session", false, (e as Error).message);
}

console.log("\n--- private pages must fail loudly instead of rendering empty ---");
try {
  await scraper.getFollows("test-user");
  check("follows throws on a dead session", false, "returned without throwing");
} catch (e) {
  check("follows throws on a dead session", true, (e as Error).message.slice(0, 70));
}

// Only a private page can prove the session dead, so the verdict appears here.
check("the dead session is now recorded", isSessionKnownDead("test-user"));

console.log("\n--- after the verdict, public pages skip the auth attempt entirely ---");
try {
  const fiction = await scraper.getFiction(192682, "test-user");
  check("fiction still loads without re-testing auth", !!fiction?.title && !/^Fiction \d+$/.test(fiction.title));
} catch (e) {
  check("fiction still loads without re-testing auth", false, (e as Error).message);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
