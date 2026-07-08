import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeGet } from "#lib/bridge-client.js";
import { withGroupBridge } from "#lib/bridge-tool.js";
import { getArchiveIndex } from "#lib/chat-archive.js";
import type { BridgeMessage } from "#lib/live-tail.js";
import { memoryHealth } from "#lib/memory-health.js";
import type { MemoryHistoryEntry } from "#lib/memory-health.js";
import { ROSTER } from "#lib/roster.js";
import { scanForStaleFacts } from "#lib/stale-scan.js";
import type { ArchiveHit, RecentMessage } from "#lib/stale-scan.js";

/**
 * On-demand health check for the agent's own GROUP memory. The model calls this
 * when an admin asks how memory is doing / what's stale / who's new; it returns
 * a 0-100 score with metrics, and (when `deep`) a list of likely-drifted facts.
 *
 * Everything here is read-only and PROPOSES — findings are for an admin to
 * review and apply via `save-memory`, never auto-written. Degrades to
 * `available:false` off-group or when the bridge is down, never throws.
 */

// Reuses the shared archive BM25 index (chat-archive.js) that search-chat also
// uses, so the ~9k-message index isn't built or held twice. Used to ask "is this
// roster member still mentioned anywhere" for the possibly-left signal.
const archiveSearch = (query: string): ArchiveHit[] => {
  const { messages, index } = getArchiveIndex();
  return index.search(query, 5).map(({ index: i }) => {
    const m = messages[i];
    return { date: m.t, from: m.s, text: m.x };
  });
};

/** Tally recent senders by display name, most active first. */
const tallySenders = (messages: BridgeMessage[]): [string, number][] => {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const who = (m.n || m.s || "").trim();
    if (who) {
      counts.set(who, (counts.get(who) ?? 0) + 1);
    }
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
};

export default defineTool({
  description:
    "Audit the agent's stored GROUP memory and report its health. Use when an admin asks how the memory/knowledge is doing, what's stale or out of date, who's active but not on the roster, or what's drifted. Returns a 0-100 health score with metrics (category coverage, freshness, roster drift, topic coverage). Pass deep:true to also get a list of likely-stale facts (role/org changes, possible departures, unknown-active members, new recurring topics). All findings are PROPOSALS for an admin to review and apply via save-memory. Never state them as confirmed facts, and only an admin can save changes.",
  execute(input, ctx) {
    return withGroupBridge(
      ctx,
      { note: "Memory health is only available inside the WhatsApp group." },
      async (jid) => {
        const [memoryRes, historyRes, messagesRes] = await Promise.all([
          bridgeGet<{ memory?: Record<string, string> }>(
            `/memory?group=${encodeURIComponent(jid)}`
          ),
          bridgeGet<{ history?: MemoryHistoryEntry[] }>(
            `/memory/history?group=${encodeURIComponent(jid)}&n=200`
          ),
          bridgeGet<{ messages?: BridgeMessage[] }>(
            `/messages?group=${encodeURIComponent(jid)}&n=200`
          ),
        ]);

        const memory = memoryRes.memory ?? {};
        const history = historyRes.history ?? [];
        const messages = messagesRes.messages ?? [];
        const recentSenders = tallySenders(messages);

        const { score, metrics } = memoryHealth({
          history,
          memory,
          now: Date.now(),
          recentMessages: messages.map((m) => m.x),
          recentSenders,
        });

        if (!input.deep) {
          return { available: true as const, metrics, score };
        }

        const recent: RecentMessage[] = messages.map((m) => ({
          n: m.n,
          s: m.s,
          t: m.t,
          x: m.x,
        }));
        const findings = scanForStaleFacts({
          archiveSearch,
          membersMemory: memory.members ?? "",
          recent,
          recurringTopicsMemory: memory.recurring_topics ?? "",
          roster: ROSTER,
        });

        return {
          available: true as const,
          findings,
          metrics,
          note: "Findings are proposals for an admin to review; apply with save-memory.",
          score,
        };
      }
    );
  },
  inputSchema: z.object({
    deep: z
      .boolean()
      .optional()
      .describe(
        "Also run the stale-fact scan and return specific proposed updates (slower). Default false = score + metrics only."
      ),
  }),
});
