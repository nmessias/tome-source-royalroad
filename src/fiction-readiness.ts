/** Markers used to detect a Royal Road fiction page. */
// Both the legacy and redesigned page expose the title in an h1. The parser
// uses the same fallback when the legacy .fic-title wrapper is absent.
export const FICTION_READY_SELECTOR = '.fic-title, h1';
export const FICTION_CONTENT_PROBE = /(?:class="[^"]*\bfic-title\b|<h1\b)/i;
