/**
 * Memory-health scoring for the agent's per-group memory. Pure and deterministic
 * so it's unit-testable and comparable over time; the `audit-memory` tool feeds
 * it live data (stored memory, the bridge's write history, recent senders, the
 * roster).
 *
 * Four signals, weighted: how many categories are filled (coverage), how
 * recently they were saved (freshness), whether the agent recognises who's
 * actually talking (drift), and whether stored recurring topics still show up in
 * traffic (topicsCoverage).
 */

import { buildBm25, tokenize } from "#lib/bm25.js";
import { MEMORY_CATEGORIES } from "#lib/memory-categories.js";
import { isKnownMember } from "#lib/roster.js";

/** A memory write, as recorded in the bridge's `memory/history.jsonl`. */
export interface MemoryHistoryEntry {
  /** Unix seconds. */
  t: number;
  category: string;
}

export interface MemoryHealthMetrics {
  coverage: number;
  freshness: number;
  drift: number;
  topicsCoverage: number;
  emptyCategories: string[];
  /** Categories with content but older than the fresh window. */
  staleCategories: string[];
  /** Active senders not matched to the roster or `members` memory. */
  unknownActive: string[];
}

export interface MemoryHealthArgs {
  /** Stored memory: `{ category: prose }`. */
  memory: Record<string, string>;
  /** Write history from the bridge (newest or oldest order, both fine). */
  history: MemoryHistoryEntry[];
  /** Active senders as `[displayName, count]`, e.g. from the recent tail. */
  recentSenders: [string, number][];
  /** Recent message texts, for checking recurring-topic coverage. */
  recentMessages: string[];
  /** Unix ms "now" (injected so the function stays pure/testable). */
  now: number;
}

const clamp01 = (n: number): number => {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(1, Math.max(0, n));
};

/** Days-since-save → freshness in [0,1]: full ≤30d, zero ≥120d, linear between. */
const freshnessFor = (daysSince: number): number => {
  if (daysSince <= 30) {
    return 1;
  }
  if (daysSince >= 120) {
    return 0;
  }
  return (120 - daysSince) / 90;
};

/** Latest save timestamp (unix seconds) per category from the history log. */
const latestSaveByCategory = (
  history: MemoryHistoryEntry[]
): Map<string, number> => {
  const latest = new Map<string, number>();
  for (const h of history) {
    if (!h || typeof h.t !== "number" || typeof h.category !== "string") {
      continue;
    }
    const prev = latest.get(h.category);
    if (prev === undefined || h.t > prev) {
      latest.set(h.category, h.t);
    }
  }
  return latest;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Split the recurring-topics block into candidate topic phrases. */
const topicPhrases = (block: string): string[] =>
  block
    .split(/[\n;,.]+/u)
    .map((s) => s.replace(/^[\s\-*•]+/u, "").trim())
    .filter((s) => tokenize(s).length > 0);

const scoreTopicsCoverage = (
  topicsBlock: string,
  recentMessages: string[]
): number => {
  const phrases = topicPhrases(topicsBlock);
  if (phrases.length === 0 || recentMessages.length === 0) {
    return 1;
  }
  const idx = buildBm25(recentMessages);
  let hit = 0;
  for (const phrase of phrases) {
    if (idx.search(phrase, 1).length > 0) {
      hit += 1;
    }
  }
  return hit / phrases.length;
};

export interface MemoryHealth {
  score: number;
  metrics: MemoryHealthMetrics;
}

export const memoryHealth = (args: MemoryHealthArgs): MemoryHealth => {
  const { memory, history, recentSenders, recentMessages, now } = args;
  const nowSec = now / 1000;
  const filled = (c: string) =>
    typeof memory[c] === "string" && memory[c].trim().length > 0;

  // 1. Coverage — share of categories with any content.
  const emptyCategories = MEMORY_CATEGORIES.filter((c) => !filled(c));
  const coverage =
    (MEMORY_CATEGORIES.length - emptyCategories.length) /
    MEMORY_CATEGORIES.length;

  // 2. Freshness — average per-category recency. Empty → 0, content with a
  //    known last-save → decayed by age, content without history → 0.5 (unknown
  //    age, e.g. written before history tracking).
  const latest = latestSaveByCategory(history);
  const staleCategories: string[] = [];
  let freshnessSum = 0;
  for (const c of MEMORY_CATEGORIES) {
    if (!filled(c)) {
      freshnessSum += 0;
      continue;
    }
    const lastSec = latest.get(c);
    if (lastSec === undefined) {
      freshnessSum += 0.5;
      continue;
    }
    const days = (nowSec - lastSec) / 86_400;
    const sub = freshnessFor(days);
    if (sub < 1) {
      staleCategories.push(c);
    }
    freshnessSum += sub;
  }
  const freshness = freshnessSum / MEMORY_CATEGORIES.length;

  // 3. Drift — fraction of recent active speakers the agent doesn't recognise
  //    (not in the roster, not named in the `members` block).
  const membersBlock = (memory.members ?? "").toLowerCase();
  const activeNames = recentSenders.map(([name]) => name).filter(Boolean);
  const unknownActive = activeNames.filter(
    (name) => !isKnownMember(name, membersBlock)
  );
  const drift =
    activeNames.length === 0
      ? 0
      : clamp01(unknownActive.length / activeNames.length);

  // 4. Topics coverage — share of stored recurring topics that still get a hit
  //    in recent traffic. Not measurable (no stored topics or no recent
  //    messages) → treated as healthy so it never penalises unfairly.
  const topicsCoverage = scoreTopicsCoverage(
    memory.recurring_topics ?? "",
    recentMessages
  );

  const score = Math.round(
    100 *
      (0.3 * coverage +
        0.3 * freshness +
        0.25 * (1 - drift) +
        0.15 * topicsCoverage)
  );

  return {
    metrics: {
      coverage: round2(coverage),
      drift: round2(drift),
      emptyCategories,
      freshness: round2(freshness),
      staleCategories,
      topicsCoverage: round2(topicsCoverage),
      unknownActive,
    },
    score,
  };
};
