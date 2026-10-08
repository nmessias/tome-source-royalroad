/**
 * Parser regression suite.
 *
 * Royal Road reskins the site without warning, and this plugin's entire value
 * is a handful of selectors — so the parsing rules are pinned here against real
 * captured markup. `test/build-fixtures.ts` regenerates the fixtures from a
 * fresh capture; it needs the network, the tests do not.
 *
 * The synthetic cases (redesign cards, history cards, next-chapter redirects)
 * encode the layouts Royal Road's own bundle registers but that an
 * unauthenticated fetch cannot reach. They are asserted separately so a
 * regression in the real markup and a gap in speculative markup are
 * distinguishable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseFictionList,
  parseFictionPage,
  parseChapterPage,
  parseCards,
  parseHistoryPage,
  shouldPrependTitle,
  extractHiddenClasses,
  stripAntiPiracy,
  cleanObfuscatedClasses,
  normalizeText,
  extractCoreTitle,
} from "../src/parsers";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ============ normalizeText / extractCoreTitle ============

describe("normalizeText", () => {
  test("converts number words to digits", () => {
    expect(normalizeText("Chapter Forty-Seven")).toBe("chapter 40 7");
  });

  test("strips punctuation and collapses whitespace", () => {
    expect(normalizeText("  Chapter 47: The Battle—Begins! ")).toBe("chapter 47 the battle begins");
  });
});

describe("extractCoreTitle", () => {
  test("strips chapter prefixes", () => {
    expect(extractCoreTitle("Chapter 47: The Battle Begins")).toBe("the battle begins");
    expect(extractCoreTitle("Ch. 12 - Awakening")).toBe("awakening");
    expect(extractCoreTitle("Prologue")).toBe("");
  });

  test("strips spelled-out numbers so Chapter One matches Chapter 01", () => {
    expect(extractCoreTitle("Chapter One: Awakening")).toBe("awakening");
    expect(extractCoreTitle("Chapter 01: Awakening")).toBe("awakening");
  });
});

// ============ shouldPrependTitle ============

describe("shouldPrependTitle", () => {
  test("prepends when the content does not open with the title", () => {
    expect(shouldPrependTitle("Chapter 1: The Start", "<p>It was a dark night.</p>")).toBe(true);
  });

  test("suppresses when the content restates the full title", () => {
    expect(
      shouldPrependTitle("Chapter 1: The Start", "<p>Chapter 1: The Start</p><p>It was dark.</p>")
    ).toBe(false);
  });

  test("suppresses when the content restates the core title", () => {
    expect(
      shouldPrependTitle("Chapter 1: The Start", "<p>The Start</p><p>It was dark.</p>")
    ).toBe(false);
  });

  // Regression: RR chapters commonly open with the title split across the
  // first two paragraphs, and only the first block used to be inspected.
  test("suppresses when the title is split across the first two blocks", () => {
    expect(
      shouldPrependTitle(
        "Chapter 01: Buying New Shoes and Dying?!",
        "<p>Chapter One</p><p>Buying New Shoes and Dying?!</p><p>Alice watched.</p>"
      )
    ).toBe(false);
  });

  test("suppresses a bare spelled-out number fragment", () => {
    expect(
      shouldPrependTitle("Chapter One", "<p>Chapter One</p><p>It was dark.</p>")
    ).toBe(false);
  });

  // Guard against over-suppression: prose that merely shares the title's
  // opening words must still get a heading.
  test("still prepends when a long opening paragraph shares the title words", () => {
    expect(
      shouldPrependTitle(
        "The Start",
        "<p>The Start of it all was nothing like she had imagined, and it went on for a while.</p>"
      )
    ).toBe(true);
  });

  test("prepends when there is no title or no content", () => {
    expect(shouldPrependTitle("", "<p>x</p>")).toBe(true);
    expect(shouldPrependTitle("Title", "")).toBe(true);
  });
});

// ============ Anti-piracy ============

describe("extractHiddenClasses", () => {
  test("recovers class names hidden by display:none", () => {
    const html = "<style>.cjABC123{ display: none; speak: never; }</style>";
    expect(extractHiddenClasses(html)).toEqual(["cjABC123"]);
  });

  test("accepts the other hiding techniques RR has used", () => {
    expect(extractHiddenClasses("<style>.a{visibility:hidden}</style>")).toEqual(["a"]);
    expect(extractHiddenClasses("<style>.b{font-size:0}</style>")).toEqual(["b"]);
    expect(extractHiddenClasses("<style>.c{height:0}</style>")).toEqual(["c"]);
    expect(extractHiddenClasses("<style>.d{text-indent:-9999px}</style>")).toEqual(["d"]);
  });

  test("ignores visible rules", () => {
    expect(extractHiddenClasses("<style>.e{color:red}</style>")).toEqual([]);
  });
});

describe("stripAntiPiracy", () => {
  const { parseHTML } = require("linkedom");

  test("removes elements carrying a hidden class", () => {
    const { document } = parseHTML('<div><span class="cjXYZ">stolen</span><p>real</p></div>');
    const removed = stripAntiPiracy(document.querySelector("div")!, ["cjXYZ"]);
    expect(removed).toBe(1);
    expect(document.querySelector("div")!.innerHTML).toBe("<p>real</p>");
  });

  // Safety net: the class name is not the only way to recognise the notice.
  test("removes a known anti-piracy notice with no hidden class at all", () => {
    const html = "<div><p>real text</p><p>This narrative has been purloined without the author's approval.</p></div>";
    const { document } = parseHTML(html);
    stripAntiPiracy(document.querySelector("div")!, []);
    expect(document.querySelector("div")!.innerHTML).not.toContain("purloined");
    expect(document.querySelector("div")!.innerHTML).toContain("real text");
  });

  test("keeps a paragraph that merely mentions Amazon", () => {
    const html = "<div><p>She ordered it on Amazon and waited.</p></div>";
    const { document } = parseHTML(html);
    stripAntiPiracy(document.querySelector("div")!, []);
    expect(document.querySelector("div")!.textContent).toContain("Amazon");
  });
});

describe("cleanObfuscatedClasses", () => {
  const { parseHTML } = require("linkedom");

  test("strips Royal Road's cn/cj obfuscation names", () => {
    const { document } = parseHTML('<div><p class="cn' + "A".repeat(30) + '">x</p></div>');
    cleanObfuscatedClasses(document.querySelector("div")!);
    expect(document.querySelector("p")!.hasAttribute("class")).toBe(false);
  });

  // An author's own long class name is not noise.
  test("keeps long classes that are not RR obfuscation", () => {
    const { document } = parseHTML('<div><p class="my-own-very-long-class-name">x</p></div>');
    cleanObfuscatedClasses(document.querySelector("div")!);
    expect(document.querySelector("p")!.getAttribute("class")).toBe("my-own-very-long-class-name");
  });
});

// ============ Real captured markup ============

describe("parseFictionList (real toplist fixture)", () => {
  const fictions = parseFictionList(fixture("toplist.html"));

  test("finds every item", () => {
    expect(fictions.length).toBeGreaterThan(0);
  });

  test("extracts title, id and url", () => {
    const first = fictions[0];
    expect(first.id).toBeGreaterThan(0);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.url).toContain(`/fiction/${first.id}`);
  });

  test("extracts rating, followers and pages", () => {
    const withRating = fictions.find((f) => f.stats?.rating !== undefined);
    expect(withRating?.stats?.rating).toBeGreaterThan(0);
    expect(withRating?.stats?.followers).toBeGreaterThan(0);
    expect(withRating?.stats?.pages).toBeGreaterThan(0);
  });

  test("extracts tags and a description", () => {
    const first = fictions[0];
    expect(first.tags?.length).toBeGreaterThan(0);
    expect(first.description?.length).toBeGreaterThan(0);
  });
});

describe("parseFictionPage (real fiction fixture)", () => {
  const { fiction, chapterIds } = parseFictionPage(fixture("fiction.html"), 192682, "https://www.royalroad.com/fiction/192682");

  test("extracts title, author and description", () => {
    expect(fiction.title).toContain("Reborn as a Demonic Rock");
    expect(fiction.author).toBe("Roobit");
    expect(fiction.description?.length).toBeGreaterThan(0);
  });

  test("extracts the cover", () => {
    expect(fiction.coverUrl).toContain("covers-large");
  });

  test("extracts every stat, including the five scores", () => {
    expect(fiction.stats?.rating).toBeCloseTo(4.52, 2);
    expect(fiction.stats?.styleScore).toBe(4.8);
    expect(fiction.stats?.storyScore).toBe(4.7);
    expect(fiction.stats?.grammarScore).toBe(4.9);
    expect(fiction.stats?.characterScore).toBe(4.9);
    expect(fiction.stats?.views).toBe(216070);
    expect(fiction.stats?.averageViews).toBe(8003);
    expect(fiction.stats?.followers).toBe(3303);
    expect(fiction.stats?.favorites).toBe(565);
    expect(fiction.stats?.ratings).toBe(273);
    expect(fiction.stats?.pages).toBe(258);
  });

  test("extracts all chapters in order", () => {
    expect(fiction.chapters?.length).toBe(27);
    expect(chapterIds[0]).toBe(3966586);
    expect(fiction.chapters?.[0].title).toContain("Buying New Shoes");
    expect(fiction.chapters?.[0].date).toBeTruthy();
  });

  // Royal Road paginated the visible chapter table on 2026-10-08: the table
  // renders ~20 rows however many chapters exist, while window.chapters still
  // carries all of them. Reading the table alone silently truncated the list.
  test("takes the chapter list from window.chapters, not the paginated table", () => {
    const html = `
      <html><body>
        <div class="fic-header"><div class="fic-title"><h1 class="font-white">T</h1></div></div>
        <table id="chapters">
          <tr class="chapter-row" data-url="/fiction/1/chapter/100/c1"><td><a>C1</a></td></tr>
          <tr class="chapter-row" data-url="/fiction/1/chapter/101/c2"><td><a>C2</a></td></tr>
        </table>
        <script>window.chapters = ${JSON.stringify([
          { id: 100, title: "C1", date: "2026-01-01T00:00:00Z", order: 0 },
          { id: 101, title: "C2", date: "2026-01-02T00:00:00Z", order: 1 },
          { id: 102, title: "C3", date: "2026-01-03T00:00:00Z", order: 2 },
        ])};</script>
      </body></html>`;
    const parsed = parseFictionPage(html, 1, "https://www.royalroad.com/fiction/1");
    expect(parsed.fiction.chapters?.map((c) => c.id)).toEqual([100, 101, 102]);
    expect(parsed.fiction.chapters?.[2].title).toBe("C3");
  });

  test("falls back to the table when there is no script array", () => {
    const html = `
      <html><body>
        <table id="chapters">
          <tr class="chapter-row" data-url="/fiction/1/chapter/100/c1"><td><a>C1</a></td></tr>
          <tr class="chapter-row" data-url="/fiction/1/chapter/101/c2"><td><a>C2</a></td></tr>
        </table>
      </body></html>`;
    const parsed = parseFictionPage(html, 1, "u");
    expect(parsed.fiction.chapters?.map((c) => c.id)).toEqual([100, 101]);
  });

  test("applies read state from the table to the full script list", () => {
    const html = `
      <html><body>
        <table id="chapters">
          <tr class="chapter-row" data-url="/fiction/1/chapter/100/c1"><td><a>C1</a></td></tr>
          <tr class="chapter-row" data-url="/fiction/1/chapter/101/c2">
            <td><a>C2</a><i class="fa-caret-right" data-original-title="Reading Progress"></i></td>
          </tr>
        </table>
        <script>window.chapters = ${JSON.stringify([
          { id: 100, title: "C1", order: 0 },
          { id: 101, title: "C2", order: 1 },
          { id: 102, title: "C3", order: 2 },
        ])};</script>
      </body></html>`;
    const parsed = parseFictionPage(html, 1, "u");
    expect(parsed.fiction.chapters?.[0].isRead).toBe(true);
    expect(parsed.fiction.chapters?.[1].isRead).toBe(true);
    expect(parsed.fiction.chapters?.[2].isRead).toBeUndefined();
  });

  test("extracts the continue-reading target", () => {
    expect(fiction.continueChapterId).toBe(3966586);
  });

  test("extracts bookmark state and an antiforgery token", () => {
    expect(fiction.csrfToken).toBeTruthy();
    expect(fiction.isFollowing).toBe(false);
  });
});

describe("parseChapterPage (real chapter fixture)", () => {
  const parsed = parseChapterPage(fixture("chapter.html"), 3966586);

  test("extracts the title", () => {
    expect(parsed.title).toBe("Chapter 01: Buying New Shoes and Dying?!");
  });

  test("extracts fiction id and title from the header", () => {
    expect(parsed.fictionId).toBe(192682);
    expect(parsed.fictionTitle).toContain("Reborn as a Demonic Rock");
  });

  test("extracts next navigation and no previous on chapter one", () => {
    expect(parsed.nextChapterUrl).toContain("/chapter/3966591");
    expect(parsed.prevChapterUrl ?? null).toBeNull();
  });

  test("keeps the story text", () => {
    expect(parsed.content).toContain("Alice watched the hand slap her across the face.");
    expect(parsed.content.length).toBeGreaterThan(1000);
  });

  test("removes the anti-piracy notice", () => {
    expect(parsed.content).not.toContain("purloined");
    expect(parsed.content).not.toContain("Report any appearances");
  });

  // Authors restate the title in the body; the reader must not show it twice.
  test("does not duplicate a title the body already states", () => {
    expect(parsed.content).not.toContain("chapter-title-prepended");
  });

  test("strips the obfuscated paragraph classes", () => {
    expect(parsed.content).not.toMatch(/class="cn[A-Za-z0-9]{16,}"/);
  });

  test("keeps inline formatting the reader needs", () => {
    expect(parsed.content).toContain("<strong>");
    expect(parsed.content).toContain("<em>");
  });

  test("keeps table width styles", () => {
    // Fixture has no table; assert the style filter keeps what it should.
    const { parseHTML } = require("linkedom");
    const { document } = parseHTML('<div class="chapter-content"><table><tr><td style="width: 40%; text-align: right">x</td></tr></table></div>');
    const out = parseChapterPage(document.toString(), 1);
    expect(out.content).toContain("width: 40%");
    expect(out.content).toContain("text-align: right");
  });
});

// ============ Redesign / speculative layouts ============

// Royal Road's own bundle registers these card families; an unauthenticated
// fetch cannot reach the pages that use them, so they are asserted here.
const REDESIGN_FOLLOWS_CARD = (opts: { withAttr?: boolean } = {}) => `
<div class="fiction-card-vertical" ${opts.withAttr ? 'data-rr-expanded-fic-card=""' : ""}>
  <a data-vt-trigger href="/fiction/111/example-fiction">
    <h2>Example Fiction</h2>
  </a>
  <span class="author"><a href="/profile/222">An Author</a></span>
  <img data-type="cover" src="/covers/111.jpg">
  <i class="fa-circle"></i>
  <ul>
    <li><a href="/fiction/111/chapter/900/last-up">Chapter 900: Last Update</a><span>Last Update:</span><time>2 hours </time> ago</li>
    <li><a href="/fiction/111/chapter/901/last-read">Chapter 901: Last Read</a><span>Last read:</span><time>1 day </time> ago</li>
  </ul>
  <a class="btn" href="/chapter/next/111">Read</a>
</div>`;

describe("parseCards (redesign card families)", () => {
  test("parses the attribute hook", () => {
    const cards = parseCards(`<html><body>${REDESIGN_FOLLOWS_CARD({ withAttr: true })}</body></html>`);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 111,
      title: "Example Fiction",
      author: "An Author",
      latestChapter: "Chapter 900: Last Update",
      lastRead: "Chapter 901: Last Read",
      hasUnread: true,
    });
  });

  test("parses the .fiction-card-vertical layout without the attribute", () => {
    const cards = parseCards(`<html><body>${REDESIGN_FOLLOWS_CARD()}</body></html>`);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(111);
  });

  test("parses the horizontal card family", () => {
    const html = `<div class="fiction-card-horizontal"><a href="/fiction/333/x"><h2>Horizontal</h2></a></div>`;
    expect(parseCards(html).map((c) => c.id)).toEqual([333]);
  });

  test("parses the update-card family", () => {
    const html = `<div class="fiction-update-card"><a href="/fiction/444/x"><h2>Update</h2></a></div>`;
    expect(parseCards(html).map((c) => c.id)).toEqual([444]);
  });

  test("reads the read button's next-chapter href", () => {
    const cards = parseCards(`<html><body>${REDESIGN_FOLLOWS_CARD()}</body></html>`);
    expect(cards[0].nextChapterResolveUrl).toBe("https://www.royalroad.com/chapter/next/111");
  });

  test("exposes the recency strings the follows card renders", () => {
    const cards = parseCards(`<html><body>${REDESIGN_FOLLOWS_CARD()}</body></html>`);
    expect(cards[0].lastUpdateAgo).toBe("2 hours ago");
    expect(cards[0].lastReadAgo).toBe("1 day ago");
  });

  // Regression guard for the original bug: classification reads the row's
  // *label*, never the whole row, so a chapter whose title contains "Last
  // Read" sitting in a "Last Update" row is not mistaken for the read row.
  test("does not read a chapter title as a row label", () => {
    const html = `
      <div data-rr-expanded-fic-card>
        <a href="/fiction/1/x"><h2>F</h2></a>
        <ul>
          <li><a href="/fiction/1/chapter/900/l">Last Read It All</a> Last Update: <time>2 hours </time> ago</li>
          <li><a href="/fiction/1/chapter/901/r">A Normal Title</a> Last read: <time>1 day </time> ago</li>
        </ul>
      </div>`;
    const cards = parseCards(html);
    expect(cards[0].latestChapter).toBe("Last Read It All");
    expect(cards[0].latestChapterId).toBe(900);
    expect(cards[0].lastRead).toBe("A Normal Title");
    expect(cards[0].lastReadChapterId).toBe(901);
  });

  // A single row carrying both labels fills in both sides.
  test("lets one combined row fill in last update and last read", () => {
    const html = `
      <div data-rr-expanded-fic-card>
        <a href="/fiction/1/x"><h2>F</h2></a>
        <ul>
          <li><a href="/fiction/1/chapter/5/only">The Only Chapter</a> Last Update &amp; Last Read: <time>3 hours </time> ago</li>
        </ul>
      </div>`;
    const cards = parseCards(html);
    expect(cards[0].latestChapter).toBe("The Only Chapter");
    expect(cards[0].lastRead).toBe("The Only Chapter");
  });
});

describe("parseHistoryPage (history card families)", () => {
  test("parses the .fiction-card-history layout", () => {
    const html = `
      <div class="fiction-card-history">
        <a href="/fiction/555/history-fic">History Fiction</a>
        <a href="/fiction/555/chapter/12/ch">Chapter 12: Read</a>
        <time>3 hours </time> ago
      </div>`;
    const history = parseHistoryPage(html);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fictionId: 555, chapterId: 12 });
    expect(history[0].fictionTitle).toBe("History Fiction");
  });

  test("parses the legacy .fiction-list > .row layout", () => {
    const html = `
      <div class="fiction-list">
        <div class="row">
          <a href="/fiction/556/x">Legacy Fiction</a>
          <a href="/fiction/556/chapter/3/c">Chapter 3</a>
          <time>1 hour </time> ago
        </div>
      </div>`;
    const history = parseHistoryPage(html);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fictionId: 556, chapterId: 3 });
  });

  test("skips a row with no chapter link", () => {
    const html = `<div class="fiction-card-history"><a href="/fiction/1/x">F</a></div>`;
    expect(parseHistoryPage(html)).toEqual([]);
  });
});
