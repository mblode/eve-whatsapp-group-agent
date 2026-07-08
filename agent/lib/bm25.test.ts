import { describe, it, expect } from "vitest";

import { tokenize, buildBm25 } from "./bm25.js";

describe(tokenize, () => {
  it("lowercases input", () => {
    expect(tokenize("Hello World")).toStrictEqual(["hello", "world"]);
  });

  it("splits on non-[a-z0-9] and drops punctuation and emoji", () => {
    expect(tokenize("foo, bar! baz 🚀 qux")).toStrictEqual([
      "foo",
      "bar",
      "baz",
      "qux",
    ]);
  });

  it("filters tokens shorter than 2 chars", () => {
    expect(tokenize("a foo b bar")).toStrictEqual(["foo", "bar"]);
  });

  it("removes stopwords", () => {
    expect(tokenize("the cat and the dog is here")).toStrictEqual([
      "cat",
      "dog",
      "here",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(tokenize("")).toStrictEqual([]);
  });

  it("returns [] for punctuation-only input", () => {
    expect(tokenize("!!! ... ???")).toStrictEqual([]);
  });
});

describe("buildBm25().search", () => {
  it("ranks a rare query term above a common one (IDF)", () => {
    // "common" appears in every doc; "zebra" appears in only one.
    const docs = [
      "common common common",
      "common zebra",
      "common term here",
      "common stuff",
    ];
    const idx = buildBm25(docs);
    const results = idx.search("zebra common", 10);
    // the doc with the rare "zebra"
    expect(results[0]?.index).toBe(1);
  });

  it("saturates term frequency (no unbounded growth from repeats)", () => {
    const docs = ["alpha", "alpha alpha alpha alpha alpha alpha alpha alpha"];
    const idx = buildBm25(docs);
    const results = idx.search("alpha", 10);
    const single = results.find((r) => r.index === 0)?.score ?? 0;
    const many = results.find((r) => r.index === 1)?.score ?? 0;
    // More repeats score higher, but with saturation the ratio stays small.
    expect(many).toBeGreaterThan(single);
    expect(many).toBeLessThan(single * 3);
  });

  it("favours shorter docs for equal term frequency (length normalisation)", () => {
    const docs = [
      "needle",
      "needle padding padding padding padding padding padding",
    ];
    const idx = buildBm25(docs);
    const results = idx.search("needle", 10);
    // shorter doc ranks first
    expect(results[0]?.index).toBe(0);
  });

  it("caps results at limit", () => {
    const docs = ["match one", "match two", "match three", "match four"];
    const idx = buildBm25(docs);
    expect(idx.search("match", 2)).toHaveLength(2);
  });

  it("yields no matches for an unknown query term", () => {
    const docs = ["alpha beta", "gamma delta"];
    const idx = buildBm25(docs);
    expect(idx.search("nonexistentterm", 10)).toStrictEqual([]);
  });

  it("handles an empty corpus without throwing (avgdl guard)", () => {
    const idx = buildBm25([]);
    expect(() => idx.search("anything", 10)).not.toThrow();
    expect(idx.search("anything", 10)).toStrictEqual([]);
  });
});
