# simple-concurrent-hash-array

A resizable open-addressing hash array whose writes are compare-and-swap operations, so callers can build lock-free update loops in a single-threaded event loop.

```js
import { ConcurrentHashArray } from 'simple-concurrent-hash-array';

const map = new ConcurrentHashArray();
map.set('requests', 0);

// Only increment if nobody else moved the counter since we read it.
let done = false;
while (!done) {
  const current = map.get('requests');
  done = map.compareAndSwap('requests', current, current + 1);
}

console.log(map.get('requests')); // 1
```

## Why this exists

A plain object or `Map` gives you a read and a write, but no way to say "replace this value only if it is still what I read". Without that, a read-modify-write loop can silently drop an update when another task interleaves between the read and the write. `ConcurrentHashArray` exposes `compareAndSwap` and `compareAndDelete`, which retry internally until the slot they observed is the slot they write, and a `set` that retries the same way. The trade-off is that the backing array is not exposed: you trade direct slot access for the invariant that every mutation goes through a CAS. If you need raw array access, this library is the wrong tool.

## API

- `new ConcurrentHashArray(capacity = 16)` — `capacity` is rounded up to a power of two; non-positive or non-integer values throw `RangeError`.
- `get size` — number of live pairs.
- `get capacity` — number of slots in the backing array, which doubles when the load factor exceeds 0.75.
- `get(key)` — value, or `undefined` when absent.
- `has(key)` — boolean.
- `set(key, value)` — `true` when the key was newly inserted, `false` on overwrite.
- `delete(key)` — `true` when a mapping was removed.
- `compareAndSwap(key, expected, replacement)` — `true` when the swap happened. Absent keys are not created.
- `compareAndDelete(key, expected)` — `true` when the mapping was removed.
- `entries()` — array of `[key, value]` pairs in slot order.

## The awkward edge

Deletion writes a tombstone instead of clearing the slot to `null`, because clearing it would cut a probe chain and make later keys unreachable. Tombstones are only reclaimed when the table grows, so a workload that deletes and reinserts the same keys without ever pushing the table past its load factor will accumulate tombstones and slow down probes. The fix is to size the initial capacity for the peak number of live keys, or to force growth by inserting enough distinct keys.

## Values and comparison

`compareAndSwap` and `compareAndDelete` use `Object.is`, so `NaN` can be swapped and `-0` is distinct from `0`. `get` returns `undefined` both for a missing key and for a key whose stored value is `undefined`; use `has` when that distinction matters.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

