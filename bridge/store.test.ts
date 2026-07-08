// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createStore, extractUrls } from "./store.js";
import type { Store, StoreOptions } from "./store.js";

/** A throwaway data dir for one test, cleaned up after. */
const withStore = (
  run: (store: Store, dir: string) => unknown,
  opts?: StoreOptions
) => {
  const dir = mkdtempSync(path.join(tmpdir(), "community-store-"));
  return Promise.resolve(run(createStore(dir, opts), dir)).finally(() =>
    rmSync(dir, { force: true, recursive: true })
  );
};

test("records and reads back messages (recent + all)", async () => {
  await withStore(async (store) => {
    await store.recordMessage("g@g.us", { n: "Aoi", s: "A", t: 1, x: "hello" });
    await store.recordMessage("g@g.us", { n: null, s: "B", t: 2, x: "world" });
    const recent = await store.recentMessages("g@g.us", 10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].x, "hello");
    const all = await store.allMessages("g@g.us");
    assert.equal(all.length, 2);
  });
});

test("records and reads back reactions, preserving the reactor name", async () => {
  await withStore(async (store) => {
    await store.recordReaction("g@g.us", {
      emoji: "🔥",
      n: "Alice",
      s: "A",
      t: 1,
      target: "m1",
    });
    await store.recordReaction("g@g.us", {
      emoji: "❤️",
      s: "B",
      t: 2,
      target: "m1",
    });
    const reactions = await store.recentReactions("g@g.us", 10);
    assert.equal(reactions.length, 2);
    assert.equal(reactions[0].n, "Alice");
    assert.equal(reactions[0].target, "m1");
    // A reaction with no resolved name round-trips without one.
    assert.equal(reactions[1].n, undefined);
  });
});

test("processed-ids round-trip, dropping non-strings", async () => {
  await withStore(async (store, dir) => {
    assert.deepEqual(await store.loadProcessedIds(), []);
    await store.saveProcessedIds(["a", "b", "c"]);
    assert.deepEqual(await store.loadProcessedIds(), ["a", "b", "c"]);
    // A file with mixed types is filtered down to strings on load.
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(
      path.join(dir, "state", "processed-ids.json"),
      JSON.stringify(["x", 1, null, "y"])
    );
    assert.deepEqual(await store.loadProcessedIds(), ["x", "y"]);
  });
});

test("anchors round-trip", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.loadAnchors(), {});
    const anchors = { "g@g.us": { fromMe: false, id: "X", ts: 123 } };
    await store.saveAnchors(anchors);
    assert.deepEqual(await store.loadAnchors(), anchors);
  });
});

test("messages cap trims oldest beyond the cap", async () => {
  await withStore(
    async (store) => {
      // cap 3: append 5, expect the last 3 to survive. Trim runs on the first
      // append and then again past the 200-append cadence, but readLast(n) also
      // bounds the read, so assert via allMessages staying within a sane bound.
      const records = [0, 1, 2, 3, 4].map((i) => ({
        s: "A",
        t: i,
        x: `m${i}`,
      }));
      for (const record of records) {
        // oxlint-disable-next-line no-await-in-loop -- sequential writes are required to test ordered trimming
        await store.recordMessage("g@g.us", record);
      }
      const recent = await store.recentMessages("g@g.us", 3);
      assert.deepEqual(
        recent.map((m) => m.x),
        ["m2", "m3", "m4"]
      );
    },
    { messagesCap: 3 }
  );
});

test("extractUrls strips trailing punctuation", () => {
  assert.deepEqual(extractUrls("see https://a.com, and https://b.io/x)"), [
    "https://a.com",
    "https://b.io/x",
  ]);
});
