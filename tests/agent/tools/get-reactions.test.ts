import { describe, expect, it } from "vitest";

import type { ReactedMessage } from "#lib/reactions.js";
import { dedupTop, topKey } from "#tools/get-reactions.js";

const msg = (over: Partial<ReactedMessage>): ReactedMessage => ({
  emojis: { "🔥": over.reactions ?? 1 },
  from: "Alice",
  reactions: 1,
  text: "gm",
  ...over,
});

describe("get-reactions dedupTop", () => {
  it("keeps same-author/same-text messages on different dates separate", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", reactions: 2 }),
      msg({ date: "2/3/2025", reactions: 5 }),
    ]);
    // Distinct days ⇒ two distinct keys ⇒ both survive (not collapsed).
    expect(map.size).toBe(2);
    const counts = [...map.values()].map((m) => m.reactions).toSorted();
    expect(counts).toStrictEqual([2, 5]);
  });

  it("merges identical date+author+text, keeping the higher count", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", reactions: 2 }),
      msg({ date: "1/3/2025", reactions: 7 }),
    ]);
    expect(map.size).toBe(1);
    expect([...map.values()][0].reactions).toBe(7);
  });

  it("does not let a later, lower count overwrite the higher one", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", reactions: 9 }),
      msg({ date: "1/3/2025", reactions: 3 }),
    ]);
    expect([...map.values()][0].reactions).toBe(9);
  });

  it("treats a missing date distinctly from a dated row", () => {
    const dated = msg({ date: "1/3/2025" });
    const undated = msg({ date: undefined });
    expect(topKey(dated)).not.toBe(topKey(undated));
    expect(dedupTop([dated, undated]).size).toBe(2);
  });

  it("distinguishes different authors and different text", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", from: "Alice", text: "gm" }),
      msg({ date: "1/3/2025", from: "Bob", text: "gm" }),
      msg({ date: "1/3/2025", from: "Alice", text: "gn" }),
    ]);
    expect(map.size).toBe(3);
  });
});
