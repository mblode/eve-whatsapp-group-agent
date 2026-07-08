// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { boundedMap, boundedSet } from "./bounded-set.js";

test("boundedSet evicts the oldest entry once the cap is exceeded (FIFO)", () => {
  const s = boundedSet(3);
  s.add("a");
  s.add("b");
  s.add("c");
  s.add("d");
  assert.equal(s.size, 3);
  // oldest evicted
  assert.equal(s.has("a"), false);
  assert.equal(s.has("d"), true);
});

test("boundedSet (FIFO) does NOT refresh recency on re-add", () => {
  const s = boundedSet(2);
  s.add("a");
  s.add("b");
  // re-adding "a" must not move it ahead of "b"
  s.add("a");
  s.add("c");
  // Without LRU, "a" stays the oldest, so it's the one evicted.
  assert.equal(s.has("a"), false);
  assert.equal(s.has("b"), true);
  assert.equal(s.has("c"), true);
});

test("boundedSet (lru) refreshes recency on re-add so the touched entry survives", () => {
  const s = boundedSet(2, { lru: true });
  s.add("a");
  s.add("b");
  // touch "a": now "b" is the least-recently-used
  s.add("a");
  s.add("c");
  assert.equal(s.has("a"), true);
  // evicted as LRU
  assert.equal(s.has("b"), false);
  assert.equal(s.has("c"), true);
});

test("boundedSet delete removes a value (used to roll back a failed send)", () => {
  const s = boundedSet(5);
  s.add("k");
  assert.equal(s.has("k"), true);
  s.delete("k");
  assert.equal(s.has("k"), false);
});

test("boundedSet values yields insertion order for persistence", () => {
  const s = boundedSet(5);
  s.add("a");
  s.add("b");
  assert.deepEqual([...s.values()], ["a", "b"]);
});

test("boundedMap stores and reads values, evicting oldest past the cap", () => {
  const m = boundedMap<string>(2);
  m.set("u1", "Alice");
  m.set("u2", "Bob");
  m.set("u3", "Cara");
  assert.equal(m.size, 2);
  // oldest evicted
  assert.equal(m.get("u1"), undefined);
  assert.equal(m.get("u3"), "Cara");
});

test("boundedMap refreshes recency on set so the touched key survives (LRU)", () => {
  const m = boundedMap<string>(2);
  m.set("u1", "Alice");
  m.set("u2", "Bob");
  // touch + update u1
  m.set("u1", "Alice 2");
  m.set("u3", "Cara");
  assert.equal(m.get("u1"), "Alice 2");
  // evicted as LRU
  assert.equal(m.get("u2"), undefined);
  assert.equal(m.get("u3"), "Cara");
});
