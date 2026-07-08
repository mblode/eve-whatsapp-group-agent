// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCacheStore, createSentStore } from "./baileys-cache.js";

const JID = "15551234567@s.whatsapp.net";
const message = { conversation: "hello" };

test("sent store round-trips a recorded message", () => {
  const store = createSentStore();
  store.record({ key: { id: "MID1", remoteJid: JID }, message });
  assert.deepEqual(store.get({ id: "MID1", remoteJid: JID }), message);
});

test("sent store returns undefined for an unknown key", () => {
  const store = createSentStore();
  assert.equal(store.get({ id: "nope", remoteJid: JID }), undefined);
});

test("sent store ignores incomplete sends", () => {
  const store = createSentStore();
  store.record();
  store.record({ key: { id: null, remoteJid: JID }, message });
  store.record({ key: { id: "MID2", remoteJid: JID }, message: null });
  assert.equal(store.get({ id: "MID2", remoteJid: JID }), undefined);
});

test("sent store evicts the oldest past capacity", () => {
  const store = createSentStore(2);
  store.record({ key: { id: "a", remoteJid: JID }, message });
  store.record({ key: { id: "b", remoteJid: JID }, message });
  store.record({ key: { id: "c", remoteJid: JID }, message });
  assert.equal(store.get({ id: "a", remoteJid: JID }), undefined);
  assert.deepEqual(store.get({ id: "c", remoteJid: JID }), message);
});

test("cache store supports get/set/del/flushAll", () => {
  const cache = createCacheStore();
  cache.set("k", 3);
  assert.equal(cache.get("k"), 3);
  cache.del("k");
  assert.equal(cache.get("k"), undefined);
  cache.set("x", 1);
  cache.flushAll();
  assert.equal(cache.get("x"), undefined);
});

test("cache store is bounded", () => {
  const cache = createCacheStore(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
});
