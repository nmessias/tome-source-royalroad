/**
 * Pure HTML → domain parsers for Royal Road.
 *
 * Everything in this file is a pure function of the HTML string it is given:
 * no fetching, no browser, no cache, no SQLite. That is deliberate — these are
 * the only parts of the plugin that break when Royal Road reskins the site, so
 * they are kept free of I/O and covered by fixture tests in parsers.test.ts.
 *
 * Royal Road currently ships two front ends behind the same URLs:
 *
 *   - "Legacy"   — Bootstrap markup (.fiction-list-item, .fic-header, ...)
 *   - "Redesign" — a Tailwind front end gated on `window.royalroad.design ===
 *                  "TailwindRedesign"` / `sitePresentationMode === 0`, toggled
 *                  by the `beta-ui-v2` cookie.
 *
 * The selectors below deliberately accept several card families rather than a
 * single attribute, because Royal Road has already renamed its follows /
 * read-later / history card hooks twice (`.fiction-list-item` →
 * `[data-rr-expanded-fic-card]` → the `.fiction-card-*` family). A card family
 * we do not know yet yields zero rows instead of an error, so every parser is
 * expected to be told which families it supports.
 */
import { parseHTML } from "linkedom";
import type {
  Chapter,
  Fiction,
  FollowedFiction,
  HistoryEntry,
} from "tome";

// ============ Card / row selector families ============

/**
 * Every layout Royal Road uses for "a fiction card" on the bookmark pages.
 * `[data-rr-expanded-fic-card]` is the current attribute hook; the
 * `.fiction-card-*` classes are the ones its own bundle registers
 * (`.fiction-card-vertical`, `.fiction-update-card`, `.fiction-card-horizontal`,
 * `.fiction-card-history`).
 */
export const FICTION_CARD_SELECTOR = [
  "[data-rr-expanded-fic-card]",
  ".fiction-card-vertical",
  ".fiction-card-horizontal",
  ".fiction-update-card",
  ".fiction-list-item",
].join(", ");

/** Row/card layouts used by /my/history. `.fiction-card-history` is the current one. */
export const HISTORY_ROW_SELECTOR = [
  ".fiction-card-history",
  "[data-rr-expanded-fic-card]",
  ".fiction-card-horizontal",
  ".fiction-update-card",
  ".fiction-list > .row",
].join(", ");

/** Selector mean to be passed to `page.waitForSelector` — present on every layout. */
export const FICTION_CARD_WAIT_SELECTOR = "[data-rr-expanded-fic-card], .fiction-card-vertical, .fiction-card-horizontal, .fiction-update-card, .fiction-list-item";

// ============ Text helpers ============

// Number words for normalization (chapter titles like "Chapter Forty-Seven")
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70",
  eighty: "80", ninety: "90", hundred: "100",
};

/**
 * Normalize text for fuzzy matching:
 * - Lowercase
 * - Convert number words to digits
 * - Remove punctuation
 * - Collapse whitespace
 */
export function normalizeText(text: string): string {
  let normalized = text.toLowerCase();

  // Convert number words to digits (e.g., "forty-seven" -> "40-7" -> "407")
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
  }

  // Remove punctuation except spaces
  normalized = normalized.replace(/[^\w\s]/g, ' ');

  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * Strip a leading chapter/volume designator: "Chapter 47: ", "Ch. 12 - ",
 * "Chapter One ", "Prologue: ", "Book 2 — ". Handles spelled-out numbers so
 * "Chapter One" and "Chapter 01" reduce to the same remainder.
 *
 * The bare forms (prologue/epilogue/interlude, with no number) must strip the
 * word entirely — otherwise "Prologue" keeps the word and a chapter whose
 * whole title is "Prologue" never matches a body that opens with it.
 */
const PREFIX_PATTERN =
  /^(?:prologue|epilogue|interlude)\s*[.:\-–—]?\s*|^(?:chapter|chap|ch|part|book|arc|episode)\s*[.:\-–—]?\s*(?:[a-z0-9]+|[ivxlcdm]+)\s*[.:\-–—]?\s*/i;

export function stripChapterPrefix(title: string): string {
  return title.replace(PREFIX_PATTERN, '').trim();
}

/**
 * Extract the "core" title by stripping common chapter prefixes
 * e.g., "Chapter 47: The Battle Begins" -> "the battle begins"
 */
export function extractCoreTitle(title: string): string {
  return stripChapterPrefix(normalizeText(title));
}

/**
 * Escape HTML entities in a string
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** True when `text` opens with `title` — identical, or the title followed by a space. */
function startsWithTitle(text: string, title: string): boolean {
  if (!title) return false;
  return text === title || text.startsWith(title + ' ');
}

/**
 * The opening block-level elements of a chapter body, normalised.
 *
 * Authors routinely open a chapter by restating the title across two
 * paragraphs ("Chapter One" / "Buying New Shoes and Dying?!"), so a parser that
 * reads only the first block sees a fragment and adds a duplicate heading on
 * top of the author's own. Collection stops at the first block long enough to
 * be prose, so a real opening paragraph is never smeared into the comparison.
 */
function leadingBlocks(html: string, maxBlocks = 3, proseLength = 60): string[] {
  const { document } = parseHTML(`<div>${html}</div>`);
  const root = document.querySelector('div');
  if (!root) return [];

  const blocks: string[] = [];
  for (const block of Array.from(root.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6'))) {
    const text = normalizeText(block.textContent || '');
    if (!text) continue;
    blocks.push(text);
    if (text.length > proseLength) break;
    if (blocks.length >= maxBlocks) break;
  }
  return blocks;
}

/**
 * Decide whether to prepend a title heading into the chapter body.
 *
 * Suppress ONLY when the content already opens with a restatement of the title,
 * in either its full form or its "Chapter N"-stripped core. The restatement
 * must also be short: prose that merely begins with the title's opening words
 * still gets a heading.
 */
export function shouldPrependTitle(title: string, htmlContent: string): boolean {
  if (!title || !htmlContent) return true;

  const blocks = leadingBlocks(htmlContent);
  if (blocks.length === 0) return true;

  const first = blocks[0];
  const joined = blocks.join(' ');
  const normalizedTitle = normalizeText(title);
  const titleCore = extractCoreTitle(title);

  const restates =
    startsWithTitle(first, normalizedTitle) ||
    startsWithTitle(joined, normalizedTitle) ||
    (!!titleCore && startsWithTitle(stripChapterPrefix(joined), titleCore));

  if (!restates) return true;

  // A genuine restatement is never much longer than the title itself.
  const tolerance = Math.max(12, Math.ceil(normalizedTitle.length * 1.5));
  return first.length > tolerance;
}

// ============ Anti-piracy ============

/**
 * Phrases Royal Road injects beside the story text to poison copies.
 * Matched case-insensitively against element text.
 */
const ANTI_PIRACY_PATTERNS: RegExp[] = [
  /purloined without the author'?s approval/i,
  /this (?:narrative|story) has been (?:purloined|stolen)/i,
  /report (?:the violation|any appearances)/i,
  /if you (?:discover|find) this (?:narrative|story) on amazon/i,
  /posted elsewhere by the author/i,
  /reading the authentic version/i,
  /been stolen\.?\s*please report/i,
];

/**
 * Royal Road hides its anti-piracy notice behind a randomly named class
 * (`.cj<base64>`) declared in an inline `<style>` block, so the class name has
 * to be recovered from the stylesheet before the element can be removed.
 *
 * Several hiding techniques are accepted, not just `display: none`, because the
 * platform has varied it.
 */
const HIDING_RULES =
  /\.([A-Za-z0-9_-]+)\s*\{[^}]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|height\s*:\s*0|text-indent\s*:\s*-\d|clip\s*:\s*rect\(\s*0)/i;

export function extractHiddenClasses(html: string): string[] {
  const classes: string[] = [];
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  for (const block of styleBlocks) {
    for (const match of block.matchAll(
      new RegExp(HIDING_RULES.source, 'gi')
    )) {
      classes.push(match[1]);
    }
  }
  return classes;
}

/**
 * Drop the elements Royal Road uses to watermark copied text.
 *
 * Two independent passes: remove elements carrying a class the stylesheet
 * hides, then remove any short element whose own text is a known anti-piracy
 * notice. The second pass is the safety net — if the hiding mechanism changes
 * again, the notice is still recognised by what it says.
 */
export function stripAntiPiracy(root: Element, hiddenClasses: string[]): number {
  let removed = 0;

  for (const className of hiddenClasses) {
    for (const el of Array.from(root.querySelectorAll(`.${className}`))) {
      el.remove();
      removed++;
    }
  }

  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!el.parentNode) continue; // already removed with a parent
    const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // Only short, self-contained elements: a paragraph that merely mentions
    // Amazon is story text and must survive.
    if (!own || own.length > 240) continue;
    if (ANTI_PIRACY_PATTERNS.some((pattern) => pattern.test(own))) {
      el.remove();
      removed++;
    }
  }

  return removed;
}

/**
 * Royal Road gives chapter paragraphs randomly generated class names
 * (`cn<base64>`) purely to make scraping harder. They are stripped so the
 * reader is not shipping ~40 bytes of noise per paragraph, but only names that
 * actually look like Royal Road's obfuscation are removed — a class is dropped
 * for its shape, not for being long, so an author's own long class names
 * survive.
 */
const OBFUSCATED_CLASS = /^(?:cn|cj)[A-Za-z0-9]{16,}$/;

export function cleanObfuscatedClasses(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    const classes = (el.getAttribute('class') || '')
      .split(' ')
      .filter((c) => c && !OBFUSCATED_CLASS.test(c));
    if (classes.length) el.setAttribute('class', classes.join(' '));
    else el.removeAttribute('class');
  }
}

// ============ Generic card/row helpers ============

/** Pull an integer id out of a Royal Road `/fiction/<id>` or `/chapter/<id>` href. */
function idFromHref(href: string, kind: 'fiction' | 'chapter'): number | null {
  const match = href.match(new RegExp(`\\/${kind}\\/(\\d+)`));
  return match ? parseInt(match[1], 10) : null;
}

/** Text of `el` with every link removed, so link text can't be read as a label. */
function labelWithoutLinks(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('a').forEach((a) => a.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * How long ago a row's chapter was touched, as Royal Road words it ("32
 * minutes ago"). It renders the number inside a `<time>` element and the unit
 * as a bare text node after it, so read the `<time>` plus its trailing text
 * siblings — reading the whole wrapper instead would pull in the row label
 * ("Last read: 32 minutes ago").
 */
function agoFromRow(row: Element): string | undefined {
  const time = row.querySelector('time');
  if (!time) return undefined;

  const parts: string[] = [];
  const push = (value: string | null | undefined) => {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  };

  push(time.textContent);
  for (let node = time.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === 3) push(node.textContent);
    else if (node.nodeType === 1) break; // an element ends the recency run
  }

  const out = parts.join(' ').trim();
  return out || undefined;
}

/**
 * The tightest ancestor of `link` (inside `card`) that owns exactly this one
 * chapter link. That element is the row the link lives in, whatever the
 * markup calls it — `li`, `tr`, `div.row`, ...
 */
function rowOwningLink(link: Element, card: Element): Element | null {
  let node: Element | null = link.parentElement;
  while (node && node !== card) {
    const siblings = Array.from(node.querySelectorAll("a[href*='/chapter/']"));
    if (siblings.length === 1 && siblings[0] === link) return node;
    node = node.parentElement;
  }
  return null;
}

export interface ChapterRef {
  link: Element;
  id: number;
  title: string;
  /** The row's label text, links stripped: "Last Update:", "Last read:", ... */
  label: string;
  ago?: string;
}

/**
 * Every chapter link on a card, paired with the row it sits in and that row's
 * label. `skip` lets callers exclude the card's action button so it is not
 * mistaken for a chapter row.
 */
export function chapterRefs(card: Element, skip?: Element | null): ChapterRef[] {
  const seen = new Set<Element>();
  const refs: ChapterRef[] = [];

  for (const link of Array.from(card.querySelectorAll("a[href*='/chapter/']"))) {
    if (skip && (link === skip || skip.contains(link))) continue;
    const row = rowOwningLink(link, card);
    if (!row || seen.has(row)) continue;
    seen.add(row);

    const href = link.getAttribute('href') || '';
    const id = idFromHref(href, 'chapter');
    if (id === null) continue;

    // The chapter title is the link's text. On layouts that wrap it in a span,
    // the span is the precise source — the anchor can also carry an icon or a
    // "new" badge whose text would otherwise leak into the title.
    const nestedTitle = link.querySelector("span.col-xs-8, span.flex-1");
    const title = (nestedTitle?.textContent || link.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    refs.push({ link, id, title, label: labelWithoutLinks(row), ago: agoFromRow(row) });
  }

  return refs;
}

// ============ Fiction lists (toplists, search) ============

/**
 * Parse a fiction list page — toplists and search results share the same
 * `.fiction-list-item` markup.
 *
 * Known limitation: the list markup carries no author link, so `author` is
 * always empty and the UI renders "Unknown". Getting the author requires a
 * per-fiction page fetch, which is not worth the cost for a 50-row list.
 */
export function parseFictionList(html: string): Fiction[] {
  const { document } = parseHTML(html);
  const fictions: Fiction[] = [];

  const items = document.querySelectorAll(".fiction-list-item");

  for (const item of items) {
    try {
      const titleEl = item.querySelector("h2.fiction-title a, .fiction-title a");
      if (!titleEl) continue;

      const href = titleEl.getAttribute("href") || "";
      const id = idFromHref(href, 'fiction');
      if (id === null) continue;

      const title = titleEl.textContent?.trim() || "";

      // Tags (first 3 genre tags)
      const tagEls = item.querySelectorAll(".fiction-tag");
      const tags: string[] = [];
      for (let i = 0; i < Math.min(tagEls.length, 3); i++) {
        const tagText = tagEls[i].textContent?.trim();
        if (tagText) tags.push(tagText);
      }

      // Rating from star span's title attribute (e.g., title="4.75")
      const starEl = item.querySelector(".star[title]");
      const rating = starEl ? parseFloat(starEl.getAttribute("title") || "0") : undefined;

      // Stats from the stats row - parse by icon class
      let followers: number | undefined;
      let pages: number | undefined;

      const statsRow = item.querySelector(".row.stats");
      if (statsRow) {
        const statDivs = statsRow.querySelectorAll(".col-sm-6");
        for (const div of statDivs) {
          const text = div.textContent?.trim() || "";
          const icon = div.querySelector("i");
          const iconClass = icon?.getAttribute("class") || "";

          const numMatch = text.match(/([\d,]+)/);
          const num = numMatch ? parseInt(numMatch[1].replace(/,/g, ""), 10) : undefined;

          if (iconClass.includes("fa-users") && num !== undefined) {
            followers = num;
          } else if (iconClass.includes("fa-book") && num !== undefined) {
            pages = num;
          }
        }
      }

      const descEl = item.querySelector(".hidden-content, .fiction-description, [id^='description-']");
      const description = descEl?.textContent?.trim() || "";

      const coverEl = item.querySelector("img[src*='covers'], img.thumbnail, img[data-type='cover']");
      let coverUrl = coverEl?.getAttribute("src") || undefined;
      if (coverUrl && !coverUrl.startsWith("http")) {
        coverUrl = `https://www.royalroad.com${coverUrl}`;
      }

      fictions.push({
        id,
        title,
        author: "", // Not available in list markup (see the note above)
        url: `https://www.royalroad.com${href}`,
        coverUrl,
        description,
        tags,
        stats: { rating, followers, pages },
      });
    } catch (e) {
      console.error("Error parsing fiction item:", e);
    }
  }

  return fictions;
}

// ============ Fiction page ============

/**
 * The authoritative chapter list Royal Road embeds in the page as
 * `window.chapters`.
 *
 * This is the only complete source. The visible `<table>` is paginated — it
 * renders roughly the first 20 rows however many chapters exist — so parsing
 * the table alone silently truncates the chapter list. Reading the script
 * array keeps the HTTP path and the browser path identical, which they were
 * not when only `page.evaluate` could reach it.
 */
export function chaptersFromScript(html: string): Chapter[] | null {
  const match = html.match(/window\.chapters\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return null;

  let data: any[];
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  return data
    .filter((c) => c && typeof c.id === "number")
    .map((c) => ({
      id: c.id,
      title: String(c.title ?? ""),
      url: `/chapter/${c.id}`,
      date: typeof c.date === "string" ? c.date : undefined,
      order: typeof c.order === "number" ? c.order : undefined,
    }));
}

/**
 * The chapter table's rendered rows, in DOM order, plus the indexes carrying a
 * reading-progress marker.
 *
 * Royal Road has marked the last-read chapter with several different icons and
 * data attributes over time, so all known forms are accepted.
 */
function readChapterRows(document: Document): { rows: { chapter: Chapter }[]; readIndexes: Set<number> } {
  const rows: { chapter: Chapter }[] = [];
  const readIndexes = new Set<number>();

  const elements = document.querySelectorAll("tr[data-url], .chapter-row");
  elements.forEach((row, idx) => {
    const href = row.getAttribute("data-url") || row.querySelector("a")?.getAttribute("href") || "";
    const chapterId = idFromHref(href, 'chapter');
    if (chapterId === null) return;

    const chapterTitle = row.querySelector("a")?.textContent?.trim() || "";
    const dateEl = row.querySelector("time, .chapter-date");

    const hasReadingProgress = !!row.querySelector(
      "i.fa-caret-right[data-original-title*='Reading Progress'], " +
      "[data-original-title*='Reading Progress'], " +
      "i.fa-check[data-original-title*='Reading'], " +
      "[data-reading-progress], .chapter-row[data-read='true'], tr[data-read='true']"
    );
    if (hasReadingProgress) readIndexes.add(idx);

    rows.push({
      chapter: {
        id: chapterId,
        title: chapterTitle,
        url: `/chapter/${chapterId}`,
        date: dateEl?.textContent?.trim(),
      },
    });
  });

  return { rows, readIndexes };
}

export interface ParsedFiction {
  fiction: Fiction;
  /** Chapter ids in page order, for callers that need the raw list. */
  chapterIds: number[];
}

export function parseFictionPage(html: string, id: number, url: string): ParsedFiction {
  const { document } = parseHTML(html);

  // Title
  const titleEl = document.querySelector(".fic-title h1, h1.font-white");

  // Author
  let author = "Unknown";
  const authorEl = document.querySelector(".fic-title a[href*='/profile/']");
  if (authorEl) {
    author = authorEl.textContent?.trim() || "Unknown";
  } else {
    const headerProfileLink = document.querySelector(".fic-header a[href*='/profile/']");
    if (headerProfileLink) {
      author = headerProfileLink.textContent?.trim() || "Unknown";
    }
  }

  const descEl = document.querySelector(".description, .fiction-description");

  const coverEl = document.querySelector(".fic-header img[src*='covers'], .cover-art-container img, img.cover-art, .thumbnail img");
  let coverUrl = coverEl?.getAttribute("src") || undefined;
  if (coverUrl && !coverUrl.startsWith("http")) {
    coverUrl = `https://www.royalroad.com${coverUrl}`;
  }

  // ---- stats ----
  const statsContainer = document.querySelector(".fiction-stats");
  let rating: number | undefined;
  let styleScore: number | undefined;
  let storyScore: number | undefined;
  let grammarScore: number | undefined;
  let characterScore: number | undefined;
  let views: number | undefined;
  let averageViews: number | undefined;
  let followers: number | undefined;
  let favorites: number | undefined;
  let ratings: number | undefined;
  let pages: number | undefined;

  if (statsContainer) {
    const parseRating = (el: Element | null): number | undefined => {
      if (!el) return undefined;
      const content = el.getAttribute("data-content") || el.getAttribute("aria-label") || "";
      const match = content.match(/([\d.]+)/);
      return match ? parseFloat(match[1]) : undefined;
    };

    // Find ratings by their labels. The label and the value live in sibling
    // <li>s, so the label is remembered across iterations.
    const listItems = statsContainer.querySelectorAll("li.list-item, li");
    let currentLabel = "";

    for (const li of listItems) {
      const text = li.textContent?.trim() || "";
      const starEl = li.querySelector(".star, [data-content]");

      if (text.includes("Overall Score")) currentLabel = "overall";
      else if (text.includes("Style Score")) currentLabel = "style";
      else if (text.includes("Story Score")) currentLabel = "story";
      else if (text.includes("Grammar Score")) currentLabel = "grammar";
      else if (text.includes("Character Score")) currentLabel = "character";
      else if (starEl) {
        const score = parseRating(starEl);
        if (currentLabel === "overall") rating = score;
        else if (currentLabel === "style") styleScore = score;
        else if (currentLabel === "story") storyScore = score;
        else if (currentLabel === "grammar") grammarScore = score;
        else if (currentLabel === "character") characterScore = score;
        currentLabel = "";
      }
    }

    // Parse numeric stats from the right column
    const statsListItems = statsContainer.querySelectorAll(".col-sm-6:last-child li, .stats-content li");
    let nextStatType = "";

    for (const li of statsListItems) {
      const text = li.textContent?.trim().toUpperCase() || "";

      if (text.includes("TOTAL VIEWS")) nextStatType = "views";
      else if (text.includes("AVERAGE VIEWS")) nextStatType = "avgViews";
      else if (text.includes("FOLLOWERS")) nextStatType = "followers";
      else if (text.includes("FAVORITES")) nextStatType = "favorites";
      else if (text.includes("RATINGS")) nextStatType = "ratings";
      else if (text.includes("PAGES")) nextStatType = "pages";
      else if (nextStatType && li.classList.contains("font-red-sunglo")) {
        const num = parseInt(text.replace(/,/g, ""), 10);
        if (!isNaN(num)) {
          if (nextStatType === "views") views = num;
          else if (nextStatType === "avgViews") averageViews = num;
          else if (nextStatType === "followers") followers = num;
          else if (nextStatType === "favorites") favorites = num;
          else if (nextStatType === "ratings") ratings = num;
          else if (nextStatType === "pages") pages = num;
        }
        nextStatType = "";
      }
    }
  } else {
    const ratingEl = document.querySelector(".star[data-content], [data-original-title*='Score']");
    rating = ratingEl ? parseFloat(ratingEl.getAttribute("data-content") || "0") : undefined;
  }

  // ---- chapters ----
  // The script array is complete; the table is a paginated window onto it, so
  // the table is only trusted for read state, never for the chapter count.
  const { rows: chapterRows, readIndexes } = readChapterRows(document);
  const scriptChapters = chaptersFromScript(html);
  const chapters: Chapter[] = scriptChapters ?? chapterRows.map((row) => row.chapter);
  const lastReadRow = readIndexes.size > 0 ? Math.max(...readIndexes) : -1;

  if (scriptChapters) {
    // Royal Road marks only the last-read row; by convention everything up to
    // and including it has been read, so mark the whole prefix and look each
    // row up in the full list by id.
    const prefixEnd = lastReadRow >= 0 ? lastReadRow : -1;
    for (let i = 0; i <= prefixEnd; i++) {
      const chapter = chapterRows[i]?.chapter;
      if (!chapter) continue;
      const target = scriptChapters.find((c) => c.id === chapter.id);
      if (target) target.isRead = true;
    }
  } else if (lastReadRow >= 0) {
    // No script array: "everything up to the last read row" is all the table
    // can tell us.
    for (let i = 0; i <= lastReadRow; i++) chapters[i].isRead = true;
  }

  // Continue Reading link
  const continueLink = document.querySelector(
    "a.btn[href*='/chapter/'][class*='continue'], a.btn-primary[href*='/chapter/'], a[class*='btn'][href*='/chapter/']"
  );
  let continueChapterId: number | undefined;
  if (continueLink) {
    continueChapterId = idFromHref(continueLink.getAttribute("href") || "", 'chapter') ?? undefined;
  }

  // Last resort: treat everything before the continue target as read.
  if (lastReadRow < 0 && continueChapterId) {
    const continueIdx = chapters.findIndex((c) => c.id === continueChapterId);
    if (continueIdx > 0) {
      for (let i = 0; i < continueIdx; i++) chapters[i].isRead = true;
    }
  }

  const followButton = document.querySelector("#follow-button");
  const favoriteButton = document.querySelector("#favorite-button");
  const rilButton = document.querySelector("#ril-button");
  const isFollowing = followButton?.classList?.contains("active") || false;
  const isFavorite = favoriteButton?.classList?.contains("active") || false;
  const isReadLater = rilButton?.classList?.contains("active") || false;

  const csrfInput = document.querySelector('input[name="__RequestVerificationToken"]');
  const csrfToken = csrfInput?.getAttribute("value") || undefined;

  const fiction: Fiction = {
    id,
    title: titleEl?.textContent?.trim() || `Fiction ${id}`,
    author,
    url,
    coverUrl,
    description: descEl?.textContent?.trim(),
    stats: {
      rating, styleScore, storyScore, grammarScore, characterScore,
      views, averageViews, followers, favorites, ratings, pages,
    },
    chapters,
    continueChapterId,
    isFollowing, isFavorite, isReadLater,
    csrfToken,
  };

  return { fiction, chapterIds: chapters.map((c) => c.id) };
}

// ============ Chapter page ============

export interface ParsedChapter {
  title: string;
  content: string;
  prevChapterUrl?: string;
  nextChapterUrl?: string;
  fictionId: number;
  fictionTitle: string;
}

/** Nav links: an <a> in `.nav-buttons` whose text names the direction. */
function parseNav(document: Document): { prevUrl?: string; nextUrl?: string } {
  const navButtons = document.querySelector('.nav-buttons');
  if (!navButtons) return {};
  const out: { prevUrl?: string; nextUrl?: string } = {};
  for (const link of Array.from(navButtons.querySelectorAll('a[href*="/chapter/"]'))) {
    const text = link.textContent || '';
    const href = link.getAttribute('href');
    if (!href) continue;
    if (text.includes('Previous')) out.prevUrl = href;
    if (text.includes('Next')) out.nextUrl = href;
  }
  return out;
}

export function parseChapterPage(html: string, chapterId: number): ParsedChapter {
  const { document } = parseHTML(html);

  const navInfo = parseNav(document);

  // Fiction info. The title link comes first in `.fic-header`; the
  // "Fiction Page" button also matches, so take the first match.
  let fictionId = 0;
  let fictionTitle = "";
  const fictionLink =
    document.querySelector(".fic-title a, a.fic-title, .fiction-title a, .fic-header a[href*='/fiction/']") ||
    document.querySelector(".row a[href*='/fiction/']:not([href*='/chapter/']):not(.btn)");
  if (fictionLink) {
    fictionId = idFromHref(fictionLink.getAttribute("href") || "", 'fiction') ?? 0;
    fictionTitle = fictionLink.textContent?.trim() || "";
  }

  const titleEl = document.querySelector("h1.font-white, .chapter-title h1, h1");
  const title = titleEl?.textContent?.trim() || `Chapter ${chapterId}`;

  const contentEl = document.querySelector(".chapter-inner.chapter-content, .chapter-content");
  let cleanContent = "";

  if (contentEl) {
    const cloned = contentEl.cloneNode(true) as Element;

    stripAntiPiracy(cloned, extractHiddenClasses(html));

    // Author notes, ads and embeds are chrome, not story text. `.hidden` is
    // kept for elements that carry words: authors use it for spoilers.
    cloned.querySelectorAll(".author-note, .ad, .portlet, script, .ads, iframe, noscript")
      .forEach((el) => el.remove());
    cloned.querySelectorAll(".hidden")
      .forEach((el) => {
        const text = (el.textContent || '').trim();
        if (!text) el.remove();
      });

    cleanObfuscatedClasses(cloned);

    // Keep only safe styles. width is allowed so tables keep their authored
    // column layout — stripped, RR tables auto-size from content and overflow
    // the reader column (bleeding into the next page on e-ink).
    cloned.querySelectorAll('[style]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const safeStyles: string[] = [];

      const textAlign = style.match(/text-align:\s*([^;]+)/i);
      const fontWeight = style.match(/font-weight:\s*([^;]+)/i);
      const fontStyle = style.match(/font-style:\s*([^;]+)/i);
      const width = style.match(/(?:^|;)\s*width:\s*(\d+(?:\.\d+)?%|[0-9]+px)/i);

      if (textAlign) safeStyles.push(`text-align: ${textAlign[1].trim()}`);
      if (fontWeight) safeStyles.push(`font-weight: ${fontWeight[1].trim()}`);
      if (fontStyle) safeStyles.push(`font-style: ${fontStyle[1].trim()}`);
      if (width) safeStyles.push(`width: ${width[1]}`);

      if (safeStyles.length > 0) el.setAttribute('style', safeStyles.join('; '));
      else el.removeAttribute('style');
    });

    markResponsiveTables(cloned);

    cleanContent = cloned.innerHTML;

    if (shouldPrependTitle(title, cleanContent)) {
      cleanContent = `<h2 class="chapter-title-prepended">${escapeHtml(title)}</h2>\n${cleanContent}`;
    }
  }

  return {
    title,
    content: cleanContent,
    prevChapterUrl: navInfo.prevUrl,
    nextChapterUrl: navInfo.nextUrl,
    fictionId,
    fictionTitle,
  };
}

/**
 * Mark multi-column tables as responsive. RR's cell widths target desktop
 * layouts; keeping them with a large e-ink font makes useful columns too
 * narrow. The reader's auto layout will size columns from their content.
 */
function markResponsiveTables(root: Element): void {
  root.querySelectorAll('table').forEach((table) => {
    const widthRow = [...table.querySelectorAll('tr')].find((row) => {
      const cells = [...row.querySelectorAll(':scope > td, :scope > th')];
      return cells.length > 1 && cells.every((c) =>
        !c.getAttribute('colspan') && /width\s*:\s*\d/.test(c.getAttribute('style') || '')
      );
    });
    if (!widthRow) return;

    const rows = [...table.querySelectorAll('tr')];
    const columnCount = Math.max(0, ...rows.map((row) =>
      [...row.querySelectorAll(':scope > td, :scope > th')]
        .reduce((count, cell) => count + Number(cell.getAttribute('colspan') || 1), 0)
    ));

    const classes = ['responsive-table'];
    if (columnCount >= 4 || rows.length >= 8) classes.push('large-table');
    table.setAttribute('class', `${table.getAttribute('class') || ''} ${classes.join(' ')}`.trim());

    table.querySelectorAll('td, th').forEach((cell) => {
      const style = cell.getAttribute('style') || '';
      const withoutWidth = style
        .replace(/(?:^|;)\s*width\s*:\s*[^;]+;?/i, '')
        .replace(/^\s*;|;\s*$/g, '')
        .trim();
      if (withoutWidth) cell.setAttribute('style', withoutWidth);
      else cell.removeAttribute('style');
    });
  });
}

// ============ Follows / read-later ============

/** Absolute URL for a root-relative href. */
function absoluteUrl(href: string): string {
  return href.startsWith("http") ? href : `https://www.royalroad.com${href}`;
}

export interface ParsedCard {
  id: number;
  title: string;
  author: string;
  href: string;
  coverUrl?: string;
  hasUnread: boolean;
  latestChapter: string;
  latestChapterId?: number;
  lastRead: string;
  lastReadChapterId?: number;
  nextChapterId?: number;
  nextChapterTitle?: string;
  lastUpdateAgo?: string;
  lastReadAgo?: string;
  /** `/chapter/next/<fictionId>` href that still needs resolving. */
  nextChapterResolveUrl?: string;
  /** Read-later cards show a page count instead of full stats. */
  pageCount?: number;
  /** Read-later cards carry a description, follows cards do not. */
  description?: string;
}

/**
 * The card's "read next" action button. Royal Road has used both a direct
 * chapter href and a `/chapter/next/<fictionId>` redirect.
 */
function findReadButton(card: Element): Element | null {
  return (
    card.querySelector("a.btn[href*='/chapter/next/']") ||
    card.querySelector("a[href*='/chapter/next/']") ||
    card.querySelector("a.btn[href*='/chapter/']")
  );
}

/** Button text that is a real chapter title rather than a generic label. */
function readButtonTitle(button: Element | null): string | undefined {
  if (!button) return undefined;
  const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (/^(read|continue|open|next|start)\b/i.test(text)) return undefined;
  return text;
}

export function parseCards(html: string): ParsedCard[] {
  const { document } = parseHTML(html);
  const cards = document.querySelectorAll(FICTION_CARD_SELECTOR);
  const out: ParsedCard[] = [];

  for (const card of cards) {
    try {
      // The title anchor may wrap the heading (redesign) or sit inside it (legacy).
      const titleEl =
        card.querySelector("h2 a[href^='/fiction/'], h2 a[href*='/fiction/']") ||
        card.querySelector("a[data-vt-trigger] h2") ||
        card.querySelector("h2");
      if (!titleEl) continue;

      const titleAnchor =
        titleEl.closest("a[href*='/fiction/']") ||
        titleEl.querySelector("a[href*='/fiction/']") ||
        titleEl.parentElement?.closest("a[href*='/fiction/']") ||
        (titleEl.getAttribute('href') ? titleEl : null);
      const href = (titleAnchor?.getAttribute("href") || "").split("?")[0];
      const id = idFromHref(href, 'fiction');
      if (id === null) continue;

      const title = titleEl.textContent?.trim() || "";

      let author = "";
      const authorEl =
        card.querySelector("span.author a[href*='/profile/']") ||
        card.querySelector("a[href*='/profile/']");
      if (authorEl) author = authorEl.textContent?.trim() || "";

      // Unread indicator: a red dot badge in the title row, or any danger-coloured badge.
      const hasUnread =
        !!card.querySelector("i.fa-circle, .badge-danger, .bg-danger, [data-unread='true'], [data-unread]") ||
        /unread/i.test(card.innerHTML);

      const coverEl = card.querySelector("img[data-type='cover'], img[src*='covers'], img.thumbnail");
      let coverUrl = coverEl?.getAttribute("src") || undefined;
      if (coverUrl && !coverUrl.startsWith("http")) coverUrl = absoluteUrl(coverUrl);

      // Read-later cards expose a page count; follows cards expose a
      // description. Neither is present on the other's layout.
      let pageCount: number | undefined;
      const pageCountEl = card.querySelector("span.page-count, .page-count");
      if (pageCountEl) {
        const numMatch = (pageCountEl.textContent || "").match(/([\d,]+)/);
        if (numMatch) pageCount = parseInt(numMatch[1].replace(/,/g, ""), 10);
      }
      const description = card.querySelector(".hidden-content, .description")?.textContent?.trim() || undefined;

      const readButton = findReadButton(card);
      const refs = chapterRefs(card, readButton);

      let latestChapter = "";
      let latestChapterId: number | undefined;
      let lastRead = "";
      let lastReadChapterId: number | undefined;
      let nextChapterId: number | undefined;
      let nextChapterTitle = readButtonTitle(readButton) ?? "";
      let lastUpdateAgo: string | undefined;
      let lastReadAgo: string | undefined;
      let nextChapterResolveUrl: string | undefined;

      for (const ref of refs) {
        // Royal Road has shipped these as "Last Update:", "Last Read Chapter:"
        // and now "Last read:", and folds both into one
        // "Last Update & Last Read:" row when a fiction has a single chapter —
        // so match the words, unanchored, on the row label only, and let one
        // row fill in both.
        if (/last\s+update/i.test(ref.label)) {
          latestChapter = ref.title;
          latestChapterId = ref.id;
          lastUpdateAgo = ref.ago;
        }
        if (/last\s+read/i.test(ref.label)) {
          lastRead = ref.title;
          lastReadChapterId = ref.id;
          lastReadAgo = ref.ago;
        }
      }

      if (readButton) {
        const readHref = (readButton.getAttribute("href") || "").split("?")[0];
        const directId = idFromHref(readHref, 'chapter');
        if (directId !== null) {
          nextChapterId = directId;
        } else if (readHref.includes("/chapter/next/")) {
          // Resolved later by the caller, which owns the network.
          nextChapterResolveUrl = absoluteUrl(readHref);
        }
      }

      out.push({
        id, title, author, href: absoluteUrl(href), coverUrl, hasUnread,
        latestChapter, latestChapterId,
        lastRead, lastReadChapterId,
        nextChapterId, nextChapterTitle,
        lastUpdateAgo, lastReadAgo,
        nextChapterResolveUrl,
        pageCount, description,
      });
    } catch (e) {
      console.error("Error parsing fiction card:", e);
    }
  }

  return out;
}

// ============ History ============

export function parseHistoryPage(html: string): HistoryEntry[] {
  const { document } = parseHTML(html);
  const rows = document.querySelectorAll(HISTORY_ROW_SELECTOR);
  const history: HistoryEntry[] = [];

  for (const row of rows) {
    try {
      const fictionLink = row.querySelector("a[href*='/fiction/']:not([href*='/chapter/'])");
      if (!fictionLink) continue;
      const fictionId = idFromHref(fictionLink.getAttribute("href") || "", 'fiction');
      if (fictionId === null) continue;

      // On a card, both "last update" and "last read" chapter links exist; the
      // read one is the entry. Prefer a link that is not in a "last update" row.
      const links = Array.from(row.querySelectorAll("a[href*='/chapter/']"));
      const chapterLink =
        links.find((link) => !/last\s+update/i.test(labelWithoutLinks(rowOwningLink(link, row) || link))) ||
        links[0];
      if (!chapterLink) continue;

      const chapterId = idFromHref(chapterLink.getAttribute("href") || "", 'chapter');
      if (chapterId === null) continue;

      const timeEl = row.querySelector("time");
      const readAt = (timeEl?.parentElement?.textContent || timeEl?.textContent || "")
        .replace(/\s+/g, ' ').trim();

      history.push({
        fictionId,
        fictionTitle: fictionLink.textContent?.trim() || "",
        chapterId,
        chapterTitle: chapterLink.textContent?.trim() || "",
        readAt,
      });
    } catch (e) {
      console.error("Error parsing history item:", e);
    }
  }

  return history;
}
