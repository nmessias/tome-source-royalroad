import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import { FICTION_CONTENT_PROBE, FICTION_READY_SELECTOR } from '../src/fiction-readiness';

describe('fiction page readiness', () => {
  for (const [layout, html] of [
    ['legacy', '<html><body><div class="fic-title"><h1>Title</h1></div></body></html>'],
    ['logged-in redesign', '<html><body><h1 class="text-lg">Title</h1><div data-rr-show-more-content="">Description</div></body></html>'],
  ]) {
    test(`accepts the ${layout} markup`, () => {
      expect(parseHTML(html).document.querySelector(FICTION_READY_SELECTOR)).not.toBeNull();
      expect(FICTION_CONTENT_PROBE.test(html)).toBe(true);
    });
  }
});
