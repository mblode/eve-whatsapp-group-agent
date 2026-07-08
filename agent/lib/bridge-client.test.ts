import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bridgeGet, bridgePost } from "./bridge-client.js";

// The client talks to the Baileys bridge over HTTP; stub global fetch so these
// tests exercise the timeout wiring without a real network.
describe("bridge-client timeout", () => {
  beforeEach(() => {
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.WHATSAPP_BRIDGE_SECRET = "secret";
    process.env.BRIDGE_TIMEOUT_MS = "50";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRIDGE_TIMEOUT_MS;
  });

  it("aborts a GET when the bridge never responds", async () => {
    // Honour the abort signal but otherwise hang forever, like a dead bridge.
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        // oxlint-disable-next-line promise/avoid-new
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason)
          );
        })
    );
    await expect(bridgeGet("/messages")).rejects.toBeDefined();
  });

  it("aborts a POST when the bridge never responds", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        // oxlint-disable-next-line promise/avoid-new
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason)
          );
        })
    );
    await expect(bridgePost("/memory", { x: 1 })).rejects.toBeDefined();
  });

  it("passes an abort signal on every request", async () => {
    const fetchMock = vi.fn<
      (_url: string, init: RequestInit) => Promise<Response>
    >((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true }),
        ok: true,
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(bridgeGet("/messages")).resolves.toStrictEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
