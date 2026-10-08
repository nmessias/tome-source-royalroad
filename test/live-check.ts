/**
 * Smoke test against live Royal Road. Not part of `bun test` (needs network);
 * run explicitly: `bun run test/live-check.ts`
 *
 * Exercises the public paths end-to-end through the real scraper entry points,
 * so a Cloudflare or markup change is visible before it reaches the app.
 */
import { searchFictions, getToplist, getFiction, getChapter } from "../src/scraper";
import { TOPLISTS } from "../src/config";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const risingStars = TOPLISTS.find((t) => t.slug === "rising-stars")!;

console.log("\n--- toplist (anonymous) ---");
const toplist = await getToplist(risingStars);
check("toplist returns items", toplist.length > 0, `${toplist.length} fictions`);
check("toplist entries have stats", toplist[0]?.stats?.rating !== undefined, `rating=${toplist[0]?.stats?.rating}`);
check("toplist entries have covers", !!toplist[0]?.coverUrl);

console.log("\n--- search (anonymous) ---");
try {
  const results = await searchFictions("hewho");
  check("search returns items", results.length > 0, `${results.length} fictions`);
} catch (e) {
  check("search returns items", false, (e as Error).message);
}

console.log("\n--- fiction page (anonymous) ---");
const target = toplist[0];
try {
  const fiction = await getFiction(target.id);
  check("fiction loads", fiction !== null);
  check("fiction has a title", !!fiction?.title && !/^Fiction \d+$/.test(fiction.title), fiction?.title?.slice(0, 50));
  check("fiction has chapters", (fiction?.chapters?.length ?? 0) > 0, `${fiction?.chapters?.length} chapters`);
  check("fiction has an author", !!fiction?.author && fiction.author !== "Unknown", fiction?.author);
  check("fiction has stats", fiction?.stats?.rating !== undefined, `rating=${fiction?.stats?.rating}`);
  check("fiction has a continue target", fiction?.continueChapterId !== undefined, `ch=${fiction?.continueChapterId}`);

  if (fiction?.chapters?.length) {
    const chapterId = fiction.continueChapterId ?? fiction.chapters[0].id;
    console.log(`\n--- chapter page (anonymous, chapter ${chapterId}) ---`);
    try {
      const chapter = await getChapter(chapterId);
      check("chapter loads", chapter !== null);
      check("chapter has a title", !!chapter?.title, chapter?.title?.slice(0, 50));
      check("chapter has content", (chapter?.content?.length ?? 0) > 500, `${chapter?.content?.length} chars`);
      check("chapter has no anti-piracy text", !/purloined| Report any appearances/i.test(chapter?.content ?? ""));
      check("chapter has a fiction id", (chapter?.fictionId ?? 0) > 0, `fiction=${chapter?.fictionId}`);
      check("chapter has a fiction title", !!chapter?.fictionTitle);
    } catch (e) {
      check("chapter loads", false, (e as Error).message);
    }
  }
} catch (e) {
  check("fiction loads", false, (e as Error).message);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
