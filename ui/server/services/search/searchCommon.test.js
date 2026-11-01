// @vitest-environment node
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ByteLru } from './searchCommon.js';

test('byte LRU touches reads, evicts least recently used entries, and declines oversized entries', () => {
  const cache = new ByteLru(10, 10);
  cache.set('a', 'a', 4); cache.set('b', 'b', 4);
  assert.equal(cache.get('a'), 'a');
  cache.set('c', 'c', 4);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.bytes, 8);
  cache.set('huge', 'huge', 11);
  assert.equal(cache.get('a'), 'a'); assert.equal(cache.get('huge'), undefined);
});
