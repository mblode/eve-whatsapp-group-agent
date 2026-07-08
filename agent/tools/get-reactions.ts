import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeConfigured, bridgeGet } from "#lib/bridge-client.js";
import { loadArchive } from "#lib/chat-archive.js";
import { toArchiveDate } from "#lib/live-tail.js";
import {
  aggregateByTarget,
  buildNameMap,
  summariseBakedReactions,
  tallyByEmoji,
  topReactors,
} from "#lib/reactions.js";
import type {
  RawMessage,
  RawReaction,
  ReactedMessage,
  ReactorCount,
} from "#lib/reactions.js";
import { groupJidFromAuth } from "#lib/session.js";

/**
 * Emoji reactions on group messages, from two sources merged:
 *   1. The embedded archive's baked reactions — the deep history recovered from
 *      WhatsApp Web (search/BM25 only carry text, so this is the agent's only
 *      window into who-reacted-to-what historically). Available even off-bridge.
 *   2. The bridge's live reactions — recent reacts plus who-reacts-most names,
 *      which the frozen archive can't have.
 *
 * Answers "most liked / most reacted message", "top reactions", "who reacts
 * most". Coverage is best-effort: WhatsApp never replays a complete reaction
 * history, so absence means "not captured", not "nobody reacted".
 */

const truncateText = (x: string): string =>
  x.length > 200 ? `${x.slice(0, 200)}…` : x;

/**
 * Dedup key for the merged top list: date+author+text. Date is part of the key
 * so two distinct messages with the same author and text on different days stay
 * separate — without it they'd collapse into one. Exported for tests.
 */
export const topKey = (m: ReactedMessage): string =>
  `${m.date ?? ""} ${m.from} ${m.text}`;

/**
 * Fold reacted messages into a deduped map keyed by {@link topKey}, keeping the
 * higher reaction count when the same message arrives from both the baked
 * archive and the live bridge (the recent overlap). Exported for tests.
 */
export const dedupTop = (
  messages: Iterable<ReactedMessage>
): Map<string, ReactedMessage> => {
  const byKey = new Map<string, ReactedMessage>();
  for (const m of messages) {
    const key = topKey(m);
    const prev = byKey.get(key);
    if (!prev || m.reactions > prev.reactions) {
      byKey.set(key, m);
    }
  }
  return byKey;
};

export default defineTool({
  description:
    "Emoji reactions on group messages: the most-reacted messages (with text + author), a per-emoji tally, and who reacts most (live). Merges the deep baked history with recent live reactions. Use for 'most liked / most reacted message', 'top reactions', 'what landed', or 'who reacts most'. Best-effort coverage, so absence means 'not captured', not 'nobody reacted'.",
  async execute(input, ctx) {
    const limit = input.limit ?? 10;

    // Base: reactions baked into the embedded archive. Works without the bridge.
    const baked = summariseBakedReactions(loadArchive());
    const byEmoji: Record<string, number> = { ...baked.byEmoji };
    // Dedup the merged top so a message that's both baked and live (the recent
    // overlap) isn't listed twice; see {@link dedupTop}/{@link topKey}.
    const topByKey = new Map<string, ReactedMessage>();
    const addTop = (m: ReactedMessage): void => {
      const key = topKey(m);
      const prev = topByKey.get(key);
      if (!prev || m.reactions > prev.reactions) {
        topByKey.set(key, m);
      }
    };
    for (const m of baked.ranked) {
      addTop({ ...m, text: truncateText(m.text) });
    }

    let topReactorsList: ReactorCount[] = [];
    let liveError: string | undefined;
    const jid = groupJidFromAuth(ctx.session.auth);
    if (bridgeConfigured() && jid) {
      try {
        const [{ reactions }, { messages }] = await Promise.all([
          bridgeGet<{ reactions: RawReaction[] }>(
            `/reactions?group=${encodeURIComponent(jid)}&n=5000`
          ),
          bridgeGet<{ messages: RawMessage[] }>(
            `/messages?group=${encodeURIComponent(jid)}&n=2000`
          ),
        ]);
        for (const [e, n] of Object.entries(tallyByEmoji(reactions))) {
          byEmoji[e] = (byEmoji[e] ?? 0) + n;
        }
        topReactorsList = topReactors(reactions, buildNameMap(messages), limit);
        const byId = new Map<string, RawMessage>();
        for (const m of messages) {
          if (m.id) {
            byId.set(m.id, m);
          }
        }
        for (const [target, agg] of aggregateByTarget(reactions)) {
          const m = byId.get(target);
          addTop({
            // Convert the bridge's unix-seconds `t` to the archive D/M/YYYY shape
            // so the dedup key lines up with baked rows' dates.
            date: typeof m?.t === "number" ? toArchiveDate(m.t) : undefined,
            emojis: agg.emojis,
            from: m?.n || m?.s || "unknown",
            reactions: agg.count,
            text: m ? truncateText(m.x) : "(message not buffered)",
          });
        }
      } catch (error) {
        liveError = String(error);
      }
    }

    const top = [...topByKey.values()]
      .toSorted((a, b) => b.reactions - a.reactions)
      .slice(0, limit);
    const totalReactions = Object.values(byEmoji).reduce((a, b) => a + b, 0);
    // Match the other bridge-backed tools' availability contract: we have data
    // whenever the baked archive carried any reactions (works off-bridge), so
    // only report unavailable when there are no baked reactions AND the live
    // fetch failed. When baked data exists, `liveError` signals partial (live)
    // data rather than flipping availability.
    const available = baked.ranked.length > 0 || liveError === undefined;
    return {
      available,
      byEmoji,
      liveError,
      top,
      topReactors: topReactorsList,
      totalReactions,
    };
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "How many top-reacted messages (and top reactors) to return (default 10)."
      ),
  }),
});
