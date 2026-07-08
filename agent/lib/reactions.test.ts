import { describe, it, expect } from "vitest";

import type { RawMessage, RawReaction } from "./reactions.js";
import {
  aggregateByTarget,
  attachReactionsToMessages,
  buildNameMap,
  reactorName,
  summariseBakedReactions,
  tallyByEmoji,
  topReactors,
} from "./reactions.js";

const rx = (
  target: string,
  s: string,
  emoji: string,
  t = 0,
  n?: string | null
): RawReaction => ({ emoji, n, s, t, target });

const msg = (
  s: string,
  n: string | null,
  x = "hi",
  id?: string
): RawMessage => ({ id, n, s, t: 0, x });

describe(buildNameMap, () => {
  it("maps sender user-part to display name, last non-empty wins", () => {
    const map = buildNameMap([
      msg("123", "Alice"),
      msg("123", "Ada Lovelace"),
      msg("456", "Bob"),
    ]);
    expect(map.get("123")).toBe("Ada Lovelace");
    expect(map.get("456")).toBe("Bob");
  });

  it("never lets a blank name shadow a real one", () => {
    const map = buildNameMap([msg("123", "Alice"), msg("123", "  ")]);
    expect(map.get("123")).toBe("Alice");
  });
});

describe(reactorName, () => {
  const map = buildNameMap([msg("123", "Alice")]);

  it("prefers the bridge-captured name", () => {
    expect(reactorName(rx("t", "123", "🔥", 0, "Alice Smith"), map)).toBe(
      "Alice Smith"
    );
  });

  it("falls back to the messages-derived name", () => {
    expect(reactorName(rx("t", "123", "🔥"), map)).toBe("Alice");
  });

  it("falls back to the raw id when no name is known", () => {
    expect(reactorName(rx("t", "999", "🔥"), map)).toBe("999");
  });
});

describe(aggregateByTarget, () => {
  it("counts the latest reaction per (target, reactor)", () => {
    const agg = aggregateByTarget([
      rx("m1", "A", "👍", 1),
      // A changed their react: ❤️ wins
      rx("m1", "A", "❤️", 2),
      rx("m1", "B", "❤️", 1),
    ]);
    expect(agg.get("m1")).toStrictEqual({
      count: 2,
      emojis: { "❤️": 2 },
    });
  });

  it("drops a removed reaction (empty emoji wins when latest)", () => {
    const agg = aggregateByTarget([
      rx("m1", "A", "👍", 1),
      // A removed it
      rx("m1", "A", "", 2),
    ]);
    expect(agg.has("m1")).toBeFalsy();
  });

  it("ignores rows missing a target or reactor", () => {
    expect(
      aggregateByTarget([rx("", "A", "👍"), rx("m1", "", "👍")]).size
    ).toBe(0);
  });
});

describe(tallyByEmoji, () => {
  it("tallies effective reactions per emoji", () => {
    expect(
      tallyByEmoji([
        rx("m1", "A", "😂"),
        rx("m2", "B", "😂"),
        rx("m3", "C", "🔥"),
      ])
    ).toStrictEqual({ "🔥": 1, "😂": 2 });
  });
});

describe(topReactors, () => {
  it("ranks reactors by effective reaction count, resolved to names", () => {
    const map = buildNameMap([msg("A", "Alice"), msg("B", "Bob")]);
    const ranked = topReactors(
      [
        rx("m1", "A", "👍"),
        rx("m2", "A", "🔥"),
        rx("m3", "B", "❤️"),
        // distinct target → still counts
        rx("m4", "A", "👍", 1),
        // same (target,reactor) → collapses to one
        rx("m4", "A", "❤️", 2),
      ],
      map,
      10
    );
    expect(ranked).toStrictEqual([
      { count: 3, name: "Alice" },
      { count: 1, name: "Bob" },
    ]);
  });
});

describe(attachReactionsToMessages, () => {
  it("attaches reactions to the message whose id matches the target", () => {
    const byTarget = aggregateByTarget([rx("m1", "A", "😂")]);
    const out = attachReactionsToMessages(
      [msg("A", "Alice", "funny", "m1"), msg("B", "Bob", "plain", "m2")],
      byTarget
    );
    expect(out[0]?.reactions).toStrictEqual({ count: 1, emojis: { "😂": 1 } });
    expect(out[1]?.reactions).toBeUndefined();
  });

  it("leaves messages without an id untouched", () => {
    const byTarget = aggregateByTarget([rx("m1", "A", "😂")]);
    const [only] = attachReactionsToMessages([msg("A", "Alice")], byTarget);
    expect(only?.reactions).toBeUndefined();
  });
});

describe(summariseBakedReactions, () => {
  it("ranks reacted messages by total and tallies emoji, ignoring un-reacted", () => {
    const { ranked, byEmoji } = summariseBakedReactions([
      { r: [{ e: "❤️", n: 1 }], s: "Alice", t: "1/1/2026", x: "small" },
      { s: "Bob", x: "no reactions here" },
      {
        r: [
          { e: "😂", n: 3 },
          { e: "❤️", n: 2 },
        ],
        s: "Ash",
        t: "2/1/2026",
        x: "big one",
      },
    ]);
    expect(ranked.map((m) => m.text)).toStrictEqual(["big one", "small"]);
    expect(ranked[0]).toStrictEqual({
      date: "2/1/2026",
      emojis: { "❤️": 2, "😂": 3 },
      from: "Ash",
      reactions: 5,
      text: "big one",
    });
    expect(byEmoji).toStrictEqual({ "❤️": 3, "😂": 3 });
  });
});
