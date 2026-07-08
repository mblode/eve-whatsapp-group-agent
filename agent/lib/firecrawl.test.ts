import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { firecrawlConfigured, normaliseUrl, scrapeUrl } from "./firecrawl.js";

describe("URL normalisation", () => {
  it("keeps a full http(s) URL", () => {
    expect(normaliseUrl("https://arxiv.org/pdf/2605.23904")).toBe(
      "https://arxiv.org/pdf/2605.23904"
    );
  });

  it("prepends https:// to a bare domain", () => {
    expect(normaliseUrl("arxiv.org/pdf/2605.23904")).toBe(
      "https://arxiv.org/pdf/2605.23904"
    );
  });

  it("rejects non-URLs and non-web schemes", () => {
    expect(normaliseUrl("just some text")).toBeNull();
    expect(normaliseUrl("mailto:me@example.com")).toBeNull();
    expect(normaliseUrl("")).toBeNull();
  });
});

const jsonResponse = (data: unknown, ok = true, status = 200): Response =>
  ({
    json: () => Promise.resolve(data),
    ok,
    status,
    text: () => Promise.resolve(typeof data === "string" ? data : ""),
  }) as unknown as Response;

describe(scrapeUrl, () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "fc-test";
  });

  afterEach(() => {
    process.env.FIRECRAWL_API_KEY = undefined;
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("reports available:false when no key is configured", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    expect(firecrawlConfigured()).toBeFalsy();
    const result = await scrapeUrl("https://example.com");
    expect(result).toMatchObject({ available: false, found: false });
  });

  it("returns markdown and title on success", async () => {
    const fetchMock = (() =>
      Promise.resolve(
        jsonResponse({
          data: {
            markdown: "# Hello\n\nbody text",
            metadata: {
              sourceURL: "https://example.com/",
              title: "Hello",
            },
          },
          success: true,
        })
      )) as unknown as typeof fetch;

    const result = await scrapeUrl("example.com", { fetch: fetchMock });
    expect(result).toMatchObject({
      available: true,
      found: true,
      markdown: "# Hello\n\nbody text",
      sourceUrl: "https://example.com/",
      title: "Hello",
      truncated: false,
    });
  });

  it("truncates markdown past maxChars and flags it", async () => {
    const long = "x".repeat(5000);
    const fetchMock = (() =>
      Promise.resolve(
        jsonResponse({ data: { markdown: long }, success: true })
      )) as unknown as typeof fetch;

    const result = await scrapeUrl("https://example.com", {
      fetch: fetchMock,
      maxChars: 1000,
    });
    expect(result.found).toBeTruthy();
    expect(result.truncated).toBeTruthy();
    expect(result.markdown).toBe(`${"x".repeat(1000)}…`);
  });

  it("returns found:false with a note on an HTTP error", async () => {
    const fetchMock = (() =>
      Promise.resolve(
        jsonResponse("rate limited", false, 429)
      )) as unknown as typeof fetch;

    const result = await scrapeUrl("https://example.com", { fetch: fetchMock });
    expect(result).toMatchObject({ available: true, found: false });
    expect(result.note).toContain("429");
  });

  it("returns found:false when the page is empty", async () => {
    const fetchMock = (() =>
      Promise.resolve(
        jsonResponse({ data: { markdown: "" }, success: true })
      )) as unknown as typeof fetch;

    const result = await scrapeUrl("https://example.com", { fetch: fetchMock });
    expect(result).toMatchObject({ available: true, found: false });
    expect(result.note).toContain("empty");
  });

  it("never throws on a network failure", async () => {
    const fetchMock = (() =>
      Promise.reject(new Error("boom"))) as unknown as typeof fetch;

    const result = await scrapeUrl("https://example.com", { fetch: fetchMock });
    expect(result).toMatchObject({ available: true, found: false });
    expect(result.note).toContain("boom");
  });

  it("rejects a non-URL before hitting the network", async () => {
    let called = false;
    const fetchMock = (() => {
      called = true;
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    const result = await scrapeUrl("not a url", { fetch: fetchMock });
    expect(called).toBeFalsy();
    expect(result).toMatchObject({ available: true, found: false });
  });
});
