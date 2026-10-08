/**
 * Trim the live-captured Royal Road pages into fixtures the parser tests read.
 *
 * The captures are full pages (100-400 KB, mostly ads, nav and comment
 * threads). Only the regions the parsers touch are kept, so the suite stays
 * small while still exercising the real markup.
 *
 * Run once; the output is committed so tests never need the network.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CAPTURES = "/home/nmessias/.local/share/opencode/tool-output";
const OUT = new URL("./fixtures/", import.meta.url).pathname;

const toplist = readFileSync(`${CAPTURES}/tool_11c109082001466PewC4cllkdl`, "utf8");
const fiction = readFileSync(`${CAPTURES}/tool_11c10adc1001CkNuUCSzM3WFBa`, "utf8");
const chapter = readFileSync(`${CAPTURES}/tool_11c11d830001ur1S2v4MEMSeSh`, "utf8");

/** Extract from `start` up to `end` (first occurrence after it). */
function slice(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  if (from < 0) throw new Error(`start marker not found: ${start}`);
  const to = html.indexOf(end, from);
  if (to < 0) throw new Error(`end marker not found: ${end}`);
  return html.slice(from, to);
}

/** Keep the first N matches of `pattern`. */
function keepN(html: string, pattern: RegExp, n: number): string {
  let out = "";
  let rest = html;
  for (let i = 0; i < n; i++) {
    const m = rest.match(pattern);
    if (!m || m.index === undefined) break;
    out += rest.slice(0, m.index + m[0].length);
    rest = rest.slice(m.index + m[0].length);
  }
  return out + rest.replace(pattern, "").replace(new RegExp(pattern.source, "g"), "");
}

const toplistBody = slice(
  toplist,
  '<div class="fiction-list" id="result">',
  "</div>\n        </div>\n    </div>\n</div>"
);
const fictionBody = slice(fiction, '<div class="row fic-header">', "</table>");
const chapterBody = slice(
  chapter,
  '<div class="row fic-header margin-bottom-40">',
  '<div class="portlet light dKKumhSnWiFq75vPUVtmTanQ"><div class="bold uppercase">Advertisement'
);

// The anti-piracy <style> lives in <head>; the chapter parser reads it back out
// of the raw HTML, so it has to travel with the fixture.
const chapterStyle = slice(chapter, "<style>\n            .cj", "</style>");

const page = (body: string, extraHead = "") =>
  `<!DOCTYPE html><html><head>${extraHead}</head><body>${body}</body></html>`;

writeFileSync(`${OUT}toplist.html`, page(keepN(toplistBody, /<div class="fiction-list-item row">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, 2)));
writeFileSync(`${OUT}fiction.html`, page(fictionBody));
writeFileSync(`${OUT}chapter.html`, page(chapterBody, `<style>${chapterStyle}</style>`));

console.log("fixtures written");
