import { defineTool } from "eve/tools";
import { z } from "zod";

import { loadArchive } from "#lib/chat-archive.js";
import { fetchLiveTail, mergeArchiveAndTail } from "#lib/live-tail.js";
import { groupJidFromAuth } from "#lib/session.js";

/**
 * Message-count analytics over the chat. BM25 search can't count, so without
 * this the agent guesses leaderboards from "vibes" (and gets them wrong). This
 * counts real message volume per sender so "who posts the most / top 3" and
 * "how many messages" are answered from data.
 *
 * Covers the embedded archive merged with the bridge's recent
 * live tail (deduped), so counts include recent activity, not just the frozen
 * archive. The live tail is only the last few hundred messages, so it's a
 * recency top-up on an all-time leaderboard, not a windowed stat.
 */

export default defineTool({
  description:
    "Message-count analytics over the group chat archive and recent activity: the most active members (leaderboard), total messages, number of participants, and how many a named person sent (with their rank). Use for 'who posts the most', 'top N senders', 'how many messages', 'how active is X'. Counts are real message volume, not a guess, so prefer this over estimating from search.",
  async execute(input, ctx) {
    const jid = groupJidFromAuth(ctx.session.auth);
    const messages = mergeArchiveAndTail(
      loadArchive(),
      await fetchLiveTail(jid)
    );
    const counts = new Map<string, number>();
    for (const m of messages) {
      counts.set(m.s, (counts.get(m.s) ?? 0) + 1);
    }

    const ranked = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
    const total = messages.length;
    const participants = counts.size;

    if (input.sender) {
      const q = input.sender.toLowerCase();
      const matches = ranked
        .map(([from, count], i) => ({ count, from, rank: i + 1 }))
        .filter((r) => r.from.toLowerCase().includes(q));
      return { matches, participants, query: input.sender, total };
    }

    const limit = input.limit ?? 10;
    const topSenders = ranked
      .slice(0, limit)
      .map(([from, count], i) => ({ count, from, rank: i + 1 }));
    return { participants, topSenders, total };
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many top senders to return (default 10)."),
    sender: z
      .string()
      .optional()
      .describe(
        "Optional: count just this person (substring match on name, e.g. 'Alice')."
      ),
  }),
});
