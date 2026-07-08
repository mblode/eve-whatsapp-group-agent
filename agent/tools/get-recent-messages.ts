import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeGet } from "#lib/bridge-client.js";
import { withGroupBridge } from "#lib/bridge-tool.js";
import {
  aggregateByTarget,
  attachReactionsToMessages,
} from "#lib/reactions.js";
import type { RawMessage, RawReaction } from "#lib/reactions.js";

/**
 * Live tail of recent group messages, fetched from the Baileys bridge. This
 * complements `search-chat`: search covers the embedded static archive
 * onward), while this returns the recent messages since that archive's cutoff,
 * so it's the tool for "what did I miss" / recap asks about the last while.
 *
 * Each message also carries its emoji reactions where it got any (joined by
 * message id), so a recap can surface "this landed / that got laughs" without a
 * separate get-reactions call.
 *
 * The group JID comes from the WhatsApp session auth; on other channels (e.g.
 * the eve TUI) there's no group, so the tool returns `available: false` rather
 * than throwing.
 */

export default defineTool({
  description:
    "Get the most recent messages from this WhatsApp group (the live tail since the embedded archive's cutoff), each annotated with its emoji reactions where it got any. Use it for recap / 'what did I miss' / 'what's been happening' asks; pair with search-chat, which covers older history. Returns oldest→newest with date, sender and reactions; summarise tightly.",
  execute(input, ctx) {
    return withGroupBridge(
      ctx,
      {
        messages: [],
        note: "Recent messages are only available inside the WhatsApp group.",
      },
      async (jid) => {
        const limit = input.limit ?? 50;
        // Reactions join to messages by id; over-fetch them so a recent message's
        // reactions aren't missed just because they sit beyond the message window.
        const [{ messages }, { reactions }] = await Promise.all([
          bridgeGet<{ messages: RawMessage[] }>(
            `/messages?group=${encodeURIComponent(jid)}&n=${limit}`
          ),
          bridgeGet<{ reactions: RawReaction[] }>(
            `/reactions?group=${encodeURIComponent(jid)}&n=5000`
          ),
        ]);

        const withReactions = attachReactionsToMessages(
          messages,
          aggregateByTarget(reactions)
        );
        const out = withReactions.map((m) => ({
          date: new Date(m.t * 1000).toISOString(),
          from: m.n || m.s,
          text: m.x,
          ...(m.reactions ? { reactions: m.reactions.emojis } : {}),
        }));
        return { available: true as const, count: out.length, messages: out };
      }
    );
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("How many recent messages to fetch (default 50)."),
  }),
});
