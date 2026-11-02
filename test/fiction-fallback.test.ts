import { expect, test } from 'bun:test';
import { readSavedFiction } from '../src/fiction-fallback';

test('recovers a legacy per-user saved copy without exposing another user or stale bookmark tokens', () => {
  const values: Record<string, string> = {
    'stale:fiction:67742:alice': JSON.stringify({ id: 67742, title: 'Elydes', csrfToken: 'old', continueChapterId: 42 }),
    'stale:fiction:67742:bob': JSON.stringify({ id: 67742, title: 'Other account' }),
  };
  const cache = (key: string) => values[key] ?? null;
  const saved = readSavedFiction(cache, 'fiction:67742:v2:user:alice', 67742, 'alice');
  expect(saved?.title).toBe('Elydes');
  expect(saved?.cacheStale).toBe(true);
  expect(saved?.csrfToken).toBeUndefined();
  expect(readSavedFiction(cache, 'fiction:67742:v2:user:carol', 67742, 'carol')).toBeNull();
});

test('rejects malformed or mismatched saved fiction', () => {
  expect(readSavedFiction(() => '{', 'k', 1, 'a')).toBeNull();
  expect(readSavedFiction(() => JSON.stringify({ id: 2, title: 'wrong' }), 'k', 1, 'a')).toBeNull();
});
