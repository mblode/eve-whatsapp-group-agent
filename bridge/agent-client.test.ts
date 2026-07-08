// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentClient } from "./agent-client.js";
import type { AskAgentArgs } from "./agent-client.js";

const noopLogger = {
  warn: () => {
    // silenced in tests
  },
} as unknown as Parameters<typeof createAgentClient>[0]["logger"];

const baseArgs: AskAgentArgs = {
  message: "hello",
  sender: "15551234567@s.whatsapp.net",
  senderName: "Matt",
  senderPhone: "15551234567",
  surface: "dm",
  token: "15551234567@s.whatsapp.net",
};

interface Captured {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const withStubbedFetch = async (
  responses: (() => Response)[],
  fn: (captured: Captured[]) => Promise<void>
): Promise<void> => {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    captured.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(make());
  }) as typeof fetch;
  try {
    await fn(captured);
  } finally {
    globalThis.fetch = original;
  }
};

const makeClient = (maxAttempts?: number) =>
  createAgentClient({
    endpoint: "http://agent.test/eve/v1/whatsapp/message",
    logger: noopLogger,
    maxAttempts,
    secret: "s3cret",
    sleep: async () => {
      // no backoff in tests
    },
    timeoutMs: 1000,
  });

test("askAgent posts the message envelope and surfaces the reply", async () => {
  await withStubbedFetch(
    [() => Response.json({ reply: " hi there " })],
    async (captured) => {
      const ask = makeClient();
      const result = await ask(baseArgs);
      assert.equal(result.reply, "hi there");
      assert.equal(captured[0].body.message, "hello");
      assert.equal(captured[0].body.token, "15551234567@s.whatsapp.net");
      assert.equal(captured[0].headers["x-bridge-secret"], "s3cret");
    }
  );
});

test("askAgent retries transient failures up to the default 3 attempts", async () => {
  await withStubbedFetch(
    [
      () => new Response("boom", { status: 500 }),
      () => new Response("boom", { status: 500 }),
      () => Response.json({ reply: "third time lucky" }),
    ],
    async (captured) => {
      const ask = makeClient();
      const result = await ask(baseArgs);
      assert.equal(result.reply, "third time lucky");
      assert.equal(captured.length, 3);
    }
  );
});

test("askAgent honors maxAttempts=1", async () => {
  await withStubbedFetch(
    [
      () => new Response("boom", { status: 500 }),
      () => Response.json({ reply: "would-be retry" }),
    ],
    async (captured) => {
      const ask = makeClient(1);
      await assert.rejects(() => ask(baseArgs), /eve responded 500/u);
      // A single attempt, no retry even on a transient 500.
      assert.equal(captured.length, 1);
    }
  );
});

test("askAgent fails fast on non-retryable 4xx", async () => {
  await withStubbedFetch(
    [() => new Response("nope", { status: 401 })],
    async (captured) => {
      const ask = makeClient();
      await assert.rejects(() => ask(baseArgs), /eve responded 401/u);
      assert.equal(captured.length, 1);
    }
  );
});
