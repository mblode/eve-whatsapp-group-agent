import { describe, it, expect } from "vitest";

import type { ChatMessage } from "./chat-archive.js";
import {
  toArchiveDate,
  toArchiveRecord,
  recordKey,
  freshTail,
  mergeArchiveAndTail,
  mergeRanked,
} from "./live-tail.js";

describe(toArchiveDate, () => {
  it("renders an un-padded D/M/YYYY in local time, month 1-indexed", () => {
    // arbitrary fixed instant
    const ts = 1_710_800_000;
    const d = new Date(ts * 1000);
    // Mirrors the archive's WhatsApp-export date format (no time component).
    expect(toArchiveDate(ts)).toBe(
      `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
    );
  });
});

describe(toArchiveRecord, () => {
  it("prefers the display name (n) for `from`", () => {
    expect(toArchiveRecord({ n: "Alice", s: "12345", t: 0, x: "hi" }).s).toBe(
      "Alice"
    );
  });

  it("falls back to the sender id (s) when n is null", () => {
    expect(toArchiveRecord({ n: null, s: "12345", t: 0, x: "hi" }).s).toBe(
      "12345"
    );
  });

  it("uses 'Unknown' when both n and s are empty", () => {
    expect(toArchiveRecord({ n: null, s: "", t: 0, x: "hi" }).s).toBe(
      "Unknown"
    );
  });

  it("coerces a non-string body to an empty string", () => {
    expect(
      toArchiveRecord({
        n: null,
        s: "a",
        t: 0,
        x: undefined as unknown as string,
      }).x
    ).toBe("");
  });
});

describe(recordKey, () => {
  it("is date + sender + text, matching the reingest contract", () => {
    expect(recordKey({ s: "A", t: "1/1/2025", x: "hi" })).toBe("1/1/2025 A hi");
  });
});

const msg = (t: string, s: string, x: string): ChatMessage => ({ s, t, x });

describe(freshTail, () => {
  it("returns only tail rows not already in the archive", () => {
    const archive = [msg("1/1/2025", "A", "hi")];
    const tail = [msg("1/1/2025", "A", "hi"), msg("2/1/2025", "B", "yo")];
    expect(freshTail(archive, tail)).toStrictEqual([
      msg("2/1/2025", "B", "yo"),
    ]);
  });

  it("returns [] for an empty tail", () => {
    expect(freshTail([msg("1/1/2025", "A", "hi")], [])).toStrictEqual([]);
  });

  it("returns the whole tail when the archive is empty", () => {
    const tail = [msg("2/1/2025", "B", "yo")];
    expect(freshTail([], tail)).toStrictEqual(tail);
  });
});

describe(mergeArchiveAndTail, () => {
  it("returns the archive unchanged when nothing is fresh", () => {
    const archive = [msg("1/1/2025", "A", "hi")];
    expect(mergeArchiveAndTail(archive, [msg("1/1/2025", "A", "hi")])).toBe(
      archive
    );
  });

  it("appends fresh live rows after the archive (recency last)", () => {
    const archive = [msg("1/1/2025", "A", "hi")];
    const merged = mergeArchiveAndTail(archive, [msg("2/1/2025", "B", "yo")]);
    expect(merged).toStrictEqual([
      msg("1/1/2025", "A", "hi"),
      msg("2/1/2025", "B", "yo"),
    ]);
  });
});

describe(mergeRanked, () => {
  const a1 = msg("1/1/2025", "A", "one");
  const a2 = msg("1/1/2025", "A", "two");
  const l1 = msg("2/1/2025", "B", "three");

  it("normalises each corpus to ~[0,1] so two indexes are comparable", () => {
    const merged = mergeRanked(
      [
        { m: a1, score: 10 },
        { m: a2, score: 5 },
      ],
      [{ m: l1, score: 2 }],
      10
    );
    // live top (1.0 + boost) edges archive top (1.0); archive second (0.5) last.
    expect(merged.map((r) => r.m)).toStrictEqual([l1, a1, a2]);
  });

  it("breaks an exact tie toward the recent (live) row", () => {
    const merged = mergeRanked(
      [{ m: a1, score: 10 }],
      [{ m: l1, score: 10 }],
      10
    );
    expect(merged[0]?.m).toBe(l1);
  });

  it("respects the limit", () => {
    const merged = mergeRanked(
      [
        { m: a1, score: 10 },
        { m: a2, score: 5 },
      ],
      [{ m: l1, score: 2 }],
      2
    );
    expect(merged).toHaveLength(2);
  });
});
