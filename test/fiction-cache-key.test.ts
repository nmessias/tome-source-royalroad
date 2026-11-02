import { expect, test } from 'bun:test';
import { fictionCacheKey } from '../src/fiction-cache-key';

test('keeps anonymous, authenticated, and legacy fiction entries separate', () => {
  expect(fictionCacheKey(42, 'reader', true)).toBe('fiction:42:v2:user:reader');
  expect(fictionCacheKey(42, 'reader', false)).toBe('fiction:42:v2:anon');
  expect(fictionCacheKey(42)).toBe('fiction:42:v2:anon');
  expect(fictionCacheKey(42, 'reader', true)).not.toBe('fiction:42:reader');
});
