/**
 * Bounded FIFO/LRU collections for the WhatsApp bridge.
 *
 * The bridge keeps several in-memory "have I seen this?" sets (processed message
 * ids, replied-to ids, forwarded report keys, history-sync dedup) and one
 * user->name lookup. All need the same shape: add/has, capped size, oldest
 * evicted first. These helpers replace the hand-rolled evictors so the eviction
 * logic lives in one tested place.
 *
 * Eviction is FIFO by default (insertion order, which `Set`/`Map` preserve). Pass
 * `lru: true` to refresh recency on every add, so the cap evicts the
 * least-recently-touched entry instead of the oldest-inserted.
 */

/** A bounded set: add/has with oldest-first eviction once `cap` is exceeded. */
export interface BoundedSet {
  add: (value: string) => void;
  delete: (value: string) => void;
  has: (value: string) => boolean;
  get size(): number;
  values: () => IterableIterator<string>;
}

/** A bounded key->value map: set/get with oldest-first eviction past `cap`. */
export interface BoundedMap<V> {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  has: (key: string) => boolean;
  get size(): number;
}

/**
 * A string set capped at `cap` entries. Eviction is FIFO (oldest insertion);
 * with `{ lru: true }`, an `add` of an existing value refreshes its recency so
 * eviction is least-recently-used instead.
 */
export const boundedSet = (
  cap: number,
  { lru = false }: { lru?: boolean } = {}
): BoundedSet => {
  const set = new Set<string>();
  return {
    add(value) {
      if (lru) {
        // Refresh recency: Set preserves insertion order, so re-inserting moves
        // the value to the newest position.
        set.delete(value);
      }
      set.add(value);
      if (set.size > cap) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) {
          set.delete(oldest);
        }
      }
    },
    delete: (value) => {
      set.delete(value);
    },
    has: (value) => set.has(value),
    get size() {
      return set.size;
    },
    values: () => set.values(),
  };
};

/**
 * A key->value map capped at `cap` entries, evicting oldest-first. `set`
 * refreshes recency (Map preserves insertion order), so eviction is LRU-ish: the
 * least-recently-set key is dropped once the cap is exceeded.
 */
export const boundedMap = <V>(cap: number): BoundedMap<V> => {
  const map = new Map<string, V>();
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    set(key, value) {
      // Refresh recency so eviction is LRU-ish, not strictly insertion-order.
      map.delete(key);
      map.set(key, value);
      if (map.size > cap) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) {
          map.delete(oldest);
        }
      }
    },
    get size() {
      return map.size;
    },
  };
};
