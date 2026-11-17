import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrentHashArray } from '../src/index.js';

test('set and get round-trip a value', () => {
  const map = new ConcurrentHashArray();
  assert.equal(map.set('a', 1), true);
  assert.equal(map.get('a'), 1);
  assert.equal(map.size, 1);
});

test('set overwrites and reports false on an existing key', () => {
  const map = new ConcurrentHashArray();
  map.set('a', 1);
  assert.equal(map.set('a', 2), false);
  assert.equal(map.get('a'), 2);
  assert.equal(map.size, 1);
});

test('get returns undefined for a missing key', () => {
  const map = new ConcurrentHashArray();
  assert.equal(map.get('nope'), undefined);
  assert.equal(map.has('nope'), false);
});

test('delete removes a key and shrinks size', () => {
  const map = new ConcurrentHashArray();
  map.set('a', 1);
  assert.equal(map.delete('a'), true);
  assert.equal(map.get('a'), undefined);
  assert.equal(map.has('a'), false);
  assert.equal(map.size, 0);
});

test('delete of a missing key returns false', () => {
  const map = new ConcurrentHashArray();
  assert.equal(map.delete('ghost'), false);
});

test('compareAndSwap replaces only the expected value', () => {
  const map = new ConcurrentHashArray();
  map.set('a', 1);
  assert.equal(map.compareAndSwap('a', 1, 2), true);
  assert.equal(map.get('a'), 2);
  assert.equal(map.compareAndSwap('a', 1, 3), false);
  assert.equal(map.get('a'), 2);
});

test('compareAndSwap on a missing key returns false and creates nothing', () => {
  const map = new ConcurrentHashArray();
  assert.equal(map.compareAndSwap('a', 1, 2), false);
  assert.equal(map.has('a'), false);
  assert.equal(map.size, 0);
});

test('compareAndDelete removes only when the value matches', () => {
  const map = new ConcurrentHashArray();
  map.set('a', 1);
  assert.equal(map.compareAndDelete('a', 2), false);
  assert.equal(map.has('a'), true);
  assert.equal(map.compareAndDelete('a', 1), true);
  assert.equal(map.has('a'), false);
  assert.equal(map.size, 0);
});

test('compareAndSwap uses Object.is so NaN can be swapped', () => {
  const map = new ConcurrentHashArray();
  map.set('a', NaN);
  assert.equal(map.compareAndSwap('a', NaN, 7), true);
  assert.equal(map.get('a'), 7);
});

test('tombstones do not break probe chains for colliding keys', () => {
  const map = new ConcurrentHashArray(4);
  // These three keys collide under FNV-1a for the chosen capacity in the
  // sense that they share a probe chain once one of them is removed.
  map.set('ab', 1);
  map.set('ba', 2);
  map.set('ca', 3);
  assert.equal(map.delete('ab'), true);
  assert.equal(map.get('ba'), 2);
  assert.equal(map.get('ca'), 3);
  assert.equal(map.set('ab', 4), true);
  assert.equal(map.get('ab'), 4);
  assert.equal(map.size, 3);
});

test('grows when load exceeds the threshold and keeps every entry', () => {
  const map = new ConcurrentHashArray(4);
  for (let i = 0; i < 20; i += 1) {
    map.set(`k${i}`, i);
  }
  assert.ok(map.capacity > 4);
  assert.equal(map.size, 20);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(map.get(`k${i}`), i);
  }
});

test('entries returns all live pairs and no tombstones', () => {
  const map = new ConcurrentHashArray();
  map.set('a', 1);
  map.set('b', 2);
  map.delete('a');
  const pairs = map.entries().sort((x, y) => x[0].localeCompare(y[0]));
  assert.deepEqual(pairs, [['b', 2]]);
});

test('constructor rejects a non-positive capacity', () => {
  assert.throws(() => new ConcurrentHashArray(0), RangeError);
  assert.throws(() => new ConcurrentHashArray(-1), RangeError);
});

test('capacity is rounded up to a power of two', () => {
  const map = new ConcurrentHashArray(3);
  assert.equal(map.capacity, 4);
});

test('storing undefined as a value is distinguishable from absence', () => {
  const map = new ConcurrentHashArray();
  map.set('a', undefined);
  assert.equal(map.has('a'), true);
  assert.equal(map.get('a'), undefined);
  assert.equal(map.delete('a'), true);
  assert.equal(map.has('a'), false);
});
