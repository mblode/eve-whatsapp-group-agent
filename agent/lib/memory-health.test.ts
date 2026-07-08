import { describe, it, expect } from "vitest";

import { MEMORY_CATEGORIES } from "./memory-categories.js";
import { memoryHealth } from "./memory-health.js";
import type { MemoryHealthArgs } from "./memory-health.js";

// fixed "now" in ms
const NOW = 1_750_000_000_000;
const recently = (daysAgo: number) => Math.floor(NOW / 1000) - daysAgo * 86_400;

const fullFreshMemory = (): Record<string, string> =>
  Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, `content for ${c}`]));

const freshHistory = () =>
  MEMORY_CATEGORIES.map((c) => ({ category: c, t: recently(1) }));

const base = (overrides: Partial<MemoryHealthArgs> = {}): MemoryHealthArgs => ({
  history: [],
  memory: {},
  now: NOW,
  recentMessages: [],
  recentSenders: [],
  ...overrides,
});

describe(memoryHealth, () => {
  it("scores empty memory at the structural floor with all categories empty", () => {
    // Coverage + freshness (60% weight) are both 0; drift/topics are unmeasurable
    // with no activity, so they don't pile on. The metrics tell the real story.
    const { score, metrics } = memoryHealth(base());
    expect(score).toBeLessThanOrEqual(40);
    expect(metrics.coverage).toBe(0);
    expect(metrics.freshness).toBe(0);
    expect(metrics.emptyCategories).toHaveLength(MEMORY_CATEGORIES.length);
  });

  it("scores a partially-filled memory above an empty one", () => {
    const empty = memoryHealth(base()).score;
    const partial = memoryHealth(
      base({
        history: [
          { category: "members", t: recently(1) },
          { category: "group_facts", t: recently(1) },
        ],
        memory: { group_facts: "some facts", members: "some members" },
      })
    ).score;
    expect(partial).toBeGreaterThan(empty);
  });

  it("scores full, fresh, no-drift memory near 100", () => {
    const { score, metrics } = memoryHealth(
      base({
        history: freshHistory(),
        memory: fullFreshMemory(),
        recentSenders: [["Example Member", 3]],
      })
    );
    expect(score).toBeGreaterThanOrEqual(95);
    expect(metrics.coverage).toBe(1);
    expect(metrics.freshness).toBe(1);
    expect(metrics.drift).toBe(0);
  });

  it("drags freshness down when a category is stale", () => {
    const fresh = memoryHealth(
      base({ history: freshHistory(), memory: fullFreshMemory() })
    ).score;
    const staleHistory = freshHistory().map((h) =>
      h.category === "lore" ? { ...h, t: recently(200) } : h
    );
    const stale = memoryHealth(
      base({ history: staleHistory, memory: fullFreshMemory() })
    );
    expect(stale.score).toBeLessThan(fresh);
    expect(stale.metrics.staleCategories).toContain("lore");
  });

  it("counts an unrecognised active sender as drift", () => {
    const { metrics } = memoryHealth(
      base({
        history: freshHistory(),
        memory: fullFreshMemory(),
        recentSenders: [
          ["Example Member", 5],
          ["Brand Newperson", 4],
        ],
      })
    );
    expect(metrics.unknownActive).toContain("Brand Newperson");
    expect(metrics.drift).toBeGreaterThan(0);
  });

  it("does not penalise topics coverage when nothing is measurable", () => {
    const { metrics } = memoryHealth(
      base({ history: freshHistory(), memory: fullFreshMemory() })
    );
    expect(metrics.topicsCoverage).toBe(1);
  });
});
