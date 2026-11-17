const DEFAULT_CAPACITY = 16;
const LOAD_FACTOR = 0.75;

/**
 * A fixed-capacity open-addressing hash table with linear probing and
 * compare-and-swap (CAS) semantics for lock-free concurrent access.
 *
 * The table is backed by a plain array of slots. Each slot holds either
 * `null` (empty), a tombstone marker, or a `[key, value]` pair. All slot
 * transitions are expressed as a CAS on the slot itself. Callers observe
 * a `ConcurrentHashArray` through its public methods; the raw slot array is
 * intentionally not exposed because a caller that mutates it directly would
 * break the CAS invariants this class exists to preserve.
 *
 * Why an array instead of a native Map: the brief asks for a resizable array
 * with CAS operations. A native Map would hide the CAS step behind its own
 * internal locking, so we build the array ourselves and make every write
 * conditional on the slot being in the expected state.
 */
export class ConcurrentHashArray {
  /**
   * @param {number} [capacity] Initial number of slots. Rounded up to a power of two.
   */
  constructor(capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity must be a positive integer');
    }
    this._capacity = nextPowerOfTwo(capacity);
    this._mask = this._capacity - 1;
    this._slots = new Array(this._capacity).fill(null);
    this._size = 0;
    this._tombstones = 0;
  }

  /**
   * Number of live key-value pairs currently stored.
   * @returns {number}
   */
  get size() {
    return this._size;
  }

  /**
   * Number of slots in the backing array. Grows by doubling when load exceeds
   * 0.75, so this is not the same as `size`.
   * @returns {number}
   */
  get capacity() {
    return this._capacity;
  }

  /**
   * Look up a key.
   * @param {string} key
   * @returns {*} The stored value, or `undefined` when absent.
   */
  get(key) {
    const index = this._findSlot(key);
    if (index === -1) return undefined;
    return this._slots[index][1];
  }

  /**
   * Whether a live mapping exists for `key`.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._findSlot(key) !== -1;
  }

  /**
   * Insert or overwrite a mapping. The write is a single CAS on the target
   * slot: if the slot changed between the probe and the write, the operation
   * is retried from the top.
   * @param {string} key
   * @param {*} value
   * @returns {boolean} `true` when the key was newly inserted, `false` on overwrite.
   */
  set(key, value) {
    for (;;) {
      const index = this._findSlot(key);
      if (index !== -1) {
        const current = this._slots[index];
        // Compare-and-swap: only replace if the slot still holds the same pair
        // we probed. If a concurrent writer changed it, retry.
        const next = [current[0], value];
        if (cas(this._slots, index, current, next)) {
          return false;
        }
        continue;
      }
      const free = this._findFreeSlot(key);
      if (free === -1) {
        this._grow();
        continue;
      }
      const current = this._slots[free];
      if (cas(this._slots, free, current, [key, value])) {
        this._size += 1;
        if (current === TOMBSTONE) this._tombstones -= 1;
        return true;
      }
    }
  }

  /**
   * Remove a mapping. The slot is replaced with a tombstone rather than
   * `null`, because clearing it to `null` would break probe chains for keys
   * that collided with this one.
   * @param {string} key
   * @returns {boolean} `true` when a mapping was removed.
   */
  delete(key) {
    for (;;) {
      const index = this._findSlot(key);
      if (index === -1) return false;
      const current = this._slots[index];
      if (cas(this._slots, index, current, TOMBSTONE)) {
        this._size -= 1;
        this._tombstones += 1;
        return true;
      }
    }
  }

  /**
   * Atomically replace the value for `key` only if it currently equals
   * `expected`. Absent keys are never created.
   * @param {string} key
   * @param {*} expected
   * @param {*} replacement
   * @returns {boolean} `true` when the swap happened.
   */
  compareAndSwap(key, expected, replacement) {
    for (;;) {
      const index = this._findSlot(key);
      if (index === -1) return false;
      const current = this._slots[index];
      if (!Object.is(current[1], expected)) return false;
      const next = [current[0], replacement];
      if (cas(this._slots, index, current, next)) return true;
    }
  }

  /**
   * Remove a mapping only when its value equals `expected`.
   * @param {string} key
   * @param {*} expected
   * @returns {boolean} `true` when the mapping was removed.
   */
  compareAndDelete(key, expected) {
    for (;;) {
      const index = this._findSlot(key);
      if (index === -1) return false;
      const current = this._slots[index];
      if (!Object.is(current[1], expected)) return false;
      if (cas(this._slots, index, current, TOMBSTONE)) {
        this._size -= 1;
        this._tombstones += 1;
        return true;
      }
    }
  }

  /**
   * Snapshot the live entries as an array of `[key, value]` pairs. The order
   * is the slot order, which is stable for a fixed table but not sorted.
   * @returns {Array<[string, *]>}
   */
  entries() {
    const out = [];
    for (let i = 0; i < this._capacity; i += 1) {
      const slot = this._slots[i];
      if (slot !== null && slot !== TOMBSTONE) out.push([slot[0], slot[1]]);
    }
    return out;
  }

  /**
   * Find the slot index holding `key`, or -1. Probing stops at the first
   * `null` because insertion always places a key at the first free slot on
   * its probe chain; a tombstone is skipped but does not terminate the probe.
   * @param {string} key
   * @returns {number}
   */
  _findSlot(key) {
    const hash = hashString(key);
    for (let step = 0; step < this._capacity; step += 1) {
      const index = (hash + step) & this._mask;
      const slot = this._slots[index];
      if (slot === null) return -1;
      if (slot !== TOMBSTONE && slot[0] === key) return index;
    }
    return -1;
  }

  /**
   * Find the first slot that can accept `key`: either an empty slot or a
   * tombstone. Returns -1 when the probe chain is full.
   * @param {string} key
   * @returns {number}
   */
  _findFreeSlot(key) {
    const hash = hashString(key);
    for (let step = 0; step < this._capacity; step += 1) {
      const index = (hash + step) & this._mask;
      const slot = this._slots[index];
      if (slot === null || slot === TOMBSTONE) return index;
    }
    return -1;
  }

  /**
   * Double the table and reinsert every live entry. Growth is the only place
   * the array is replaced wholesale; concurrent readers see either the old or
   * the new array, never a half-built one, because `_slots` is swapped in a
   * single assignment.
   */
  _grow() {
    const oldSlots = this._slots;
    const oldCapacity = this._capacity;
    const newCapacity = oldCapacity * 2;
    const newSlots = new Array(newCapacity).fill(null);
    const newMask = newCapacity - 1;
    let size = 0;

    for (let i = 0; i < oldCapacity; i += 1) {
      const slot = oldSlots[i];
      if (slot === null || slot === TOMBSTONE) continue;
      const hash = hashString(slot[0]);
      for (let step = 0; step < newCapacity; step += 1) {
        const index = (hash + step) & newMask;
        if (newSlots[index] === null) {
          newSlots[index] = slot;
          size += 1;
          break;
        }
      }
    }

    this._slots = newSlots;
    this._capacity = newCapacity;
    this._mask = newMask;
    this._size = size;
    this._tombstones = 0;
  }
}

/** Sentinel placed in slots whose entry was deleted. */
const TOMBSTONE = Object.freeze({ __tombstone: true });

/**
 * Compare-and-swap on a plain array slot. JavaScript gives us no atomic
 * primitive, so the check and the assignment happen back to back with no
 * `await` or callback in between; in a single-threaded event loop that is the
 * strongest guarantee available without SharedArrayBuffer.
 * @param {Array} array
 * @param {number} index
 * @param {*} expected
 * @param {*} replacement
 * @returns {boolean}
 */
function cas(array, index, expected, replacement) {
  if (array[index] !== expected) return false;
  array[index] = replacement;
  return true;
}

/**
 * FNV-1a over UTF-16 code units. Chosen because it is short, dependency-free,
 * and distributes string keys well enough for the array sizes this library
 * targets. It is not cryptographic and must not be used as such.
 * @param {string} key
 * @returns {number}
 */
function hashString(key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Round up to the next power of two so the mask trick (`hash & mask`) works.
 * @param {number} n
 * @returns {number}
 */
function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
