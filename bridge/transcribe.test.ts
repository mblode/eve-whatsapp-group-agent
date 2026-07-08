// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  audioExtension,
  transcribeAudio,
  transcribeConfig,
} from "./transcribe.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("transcribeConfig returns null without an API key", () => {
  assert.equal(transcribeConfig({}), null);
  assert.equal(transcribeConfig({ OPENAI_API_KEY: "   " }), null);
});

test("transcribeConfig defaults to OpenAI and honours overrides", () => {
  const dflt = transcribeConfig({ OPENAI_API_KEY: "sk-x" });
  assert.deepEqual(dflt, {
    apiKey: "sk-x",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
  });
  const custom = transcribeConfig({
    OPENAI_API_KEY: "gk-1",
    TRANSCRIBE_BASE_URL: "https://api.groq.com/openai/v1/",
    TRANSCRIBE_MODEL: "whisper-large-v3-turbo",
  });
  // trailing slash stripped
  assert.equal(custom?.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(custom?.model, "whisper-large-v3-turbo");
});

test("audioExtension maps common mimetypes and defaults to ogg", () => {
  assert.equal(audioExtension("audio/ogg; codecs=opus"), "ogg");
  assert.equal(audioExtension("audio/mpeg"), "mp3");
  assert.equal(audioExtension("audio/mp4"), "m4a");
  assert.equal(audioExtension("audio/wav"), "wav");
  assert.equal(audioExtension("application/octet-stream"), "ogg");
});

const cfg = {
  apiKey: "sk-test",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini-transcribe",
};

test("transcribeAudio posts multipart to the endpoint and returns the text", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    captured = { init, url };
    return Promise.resolve(new Response("  hello there  ", { status: 200 }));
  }) as typeof fetch;

  const out = await transcribeAudio(
    new Uint8Array([1, 2, 3]),
    "audio/ogg; codecs=opus",
    cfg
  );
  assert.equal(out, "hello there");
  assert.ok(captured);
  const { url, init } = captured as { url: string; init: RequestInit };
  assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(
    (init.headers as Record<string, string>).authorization,
    "Bearer sk-test"
  );
  const body = init.body as FormData;
  assert.equal(body.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(body.get("response_format"), "text");
  const file = body.get("file") as File;
  assert.equal(file.name, "audio.ogg");
});

test("transcribeAudio returns null on a non-2xx response", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response("nope", { status: 401 }))) as typeof fetch;
  const out = await transcribeAudio(new Uint8Array([1]), "audio/ogg", cfg);
  assert.equal(out, null);
});

test("transcribeAudio returns null on an empty transcript", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response("   ", { status: 200 }))) as typeof fetch;
  const out = await transcribeAudio(new Uint8Array([1]), "audio/ogg", cfg);
  assert.equal(out, null);
});

test("transcribeAudio returns null when fetch throws", async () => {
  globalThis.fetch = (() =>
    Promise.reject(new Error("network down"))) as typeof fetch;
  const out = await transcribeAudio(new Uint8Array([1]), "audio/ogg", cfg);
  assert.equal(out, null);
});
