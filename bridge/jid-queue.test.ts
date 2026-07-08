// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
// oxlint-disable avoid-new, param-names, require-await, no-invalid-void-type -- test scaffolding: a deferred helper and sync task bodies
import assert from "node:assert/strict";
import { test } from "node:test";

import { createJidQueue } from "./jid-queue.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

test("same key runs strictly in order", async () => {
  const queue = createJidQueue();
  const order: string[] = [];
  const gate = deferred<void>();

  const first = queue.run("a", async () => {
    order.push("first-start");
    await gate.promise;
    order.push("first-end");
  });
  const second = queue.run("a", async () => {
    order.push("second-start");
  });

  // Second must not start until first finishes.
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("different keys run concurrently", async () => {
  const queue = createJidQueue();
  const order: string[] = [];
  const blockA = deferred<void>();

  const a = queue.run("a", async () => {
    order.push("a-start");
    await blockA.promise;
    order.push("a-end");
  });
  const b = queue.run("b", async () => {
    order.push("b-start");
  });

  // b runs even though a is still blocked.
  await b;
  assert.deepEqual(order, ["a-start", "b-start"]);
  blockA.resolve();
  await a;
});

test("a rejected task propagates to its caller but doesn't wedge the key", async () => {
  const queue = createJidQueue();
  await assert.rejects(
    queue.run("a", async () => {
      throw new Error("boom");
    }),
    /boom/u
  );
  // The next task on the same key still runs.
  const result = await queue.run("a", async () => "ok");
  assert.equal(result, "ok");
});

test("the chain entry is cleaned up once it drains", async () => {
  const queue = createJidQueue();
  await queue.run("a", async () => {});
  // Let the cleanup microtask settle.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.size, 0);
});
