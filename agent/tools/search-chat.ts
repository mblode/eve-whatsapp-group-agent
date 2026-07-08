import { defineTool } from "eve/tools";
import { z } from "zod";

import { buildBm25 } from "#lib/bm25.js";
import { getArchiveIndex } from "#lib/chat-archive.js";
import { fetchLiveTail, freshTail, mergeRanked } from "#lib/live-tail.js";
import { formatBakedReactions } from "#lib/reactions.js";
import { groupJidFromAuth } from "#lib/session.js";

/**
 * BM25 search over the group chat. The deep history ships embedded
 * (gzipped+base64), decoded and indexed once on first use. On top of that, when
 * we're in the WhatsApp group, we also pull the bridge's live tail (anything
 * said since the embedded archive's cutoff) and merge it in, so a recall ask
 * about something said recently isn't a miss.
 *
 * Returns matches ranked by relevance with provenance (date + sender) so the
 * agent can ground its answer and cite who said what. When the live tail is
 * present, scores are min-max normalised to ~0–1 across both corpora (raw BM25
 * scores aren't comparable across two indexes), with a small recency nudge; with
 * no bridge / off-group the result is the archive-only ranking, unchanged.
 */

// The deep-archive index is shared with audit-memory via chat-archive.js so the
// ~9k-message index isn't built or held twice. The live-tail index below is
// per-turn and stays local.
const loadArchiveIndex = () => {
  const { messages, index } = getArchiveIndex();
  return { index, msgs: messages };
};

const trunc = (x: string) => (x.length > 500 ? `${x.slice(0, 500)}…` : x);
const round = (s: number) => Math.round(s * 100) / 100;

/**
 * Compact emoji-reaction summary for a result, e.g. "❤️×3 😂×1". Only archive
 * messages carry `r` (baked from WhatsApp Web's reaction history); live-tail
 * rows don't, so this is omitted there. Lets the agent answer "did this land /
 * what got a reaction" straight from a search hit.
 */
const fmtReactions = (r?: { e: string; n: number }[]): string | undefined =>
  r?.length ? formatBakedReactions(r) : undefined;

export default defineTool({
  description:
    "Search the WhatsApp group chat history (embedded archive plus recent live messages) with BM25 relevance ranking. Use it to answer what the group discussed, who said what, when a topic came up, links/tools shared, or the prevailing take on a model or tool. Results are ranked by relevance (not recency) with date + sender for citation. If the first query is too narrow, try again with broader or alternative terms.",
  async execute(input, ctx) {
    const limit = input.limit ?? 15;
    const senderQ = input.sender?.toLowerCase();
    // Over-fetch when filtering by sender so the filter has candidates to keep.
    const over = senderQ ? limit * 8 : limit;

    const { msgs: aMsgs, index: aIndex } = loadArchiveIndex();

    // Live tail: archive-shaped rows not already baked into the archive.
    const jid = groupJidFromAuth(ctx.session.auth);
    const fresh = freshTail(aMsgs, await fetchLiveTail(jid));

    // Archive-only fast path: no bridge / off-group / nothing new → behave
    // exactly as before (raw BM25 scores), so the no-bridge path is unchanged.
    if (fresh.length === 0) {
      const ranked = aIndex.search(input.query, over);
      const results = [];
      for (const { index: i, score } of ranked) {
        const m = aMsgs[i];
        if (senderQ && !m.s.toLowerCase().includes(senderQ)) {
          continue;
        }
        results.push({
          date: m.t,
          from: m.s,
          reactions: fmtReactions(m.r),
          score: round(score),
          text: trunc(m.x),
        });
        if (results.length >= limit) {
          break;
        }
      }
      return { matched: results.length, results };
    }

    // Merge archive + fresh live, each ranked by its own index (scores aren't
    // comparable raw, so mergeRanked normalises per-corpus and nudges recency).
    const aRanked = aIndex
      .search(input.query, over)
      .map((r) => ({ m: aMsgs[r.index], score: r.score }));
    const lIndex = buildBm25(fresh.map((m) => `${m.s}: ${m.x}`));
    const lRanked = lIndex
      .search(input.query, over)
      .map((r) => ({ m: fresh[r.index], score: r.score }));
    const merged = mergeRanked(aRanked, lRanked, senderQ ? over : limit);

    const results = [];
    for (const { m, score } of merged) {
      if (senderQ && !m.s.toLowerCase().includes(senderQ)) {
        continue;
      }
      results.push({
        date: m.t,
        from: m.s,
        reactions: fmtReactions(m.r),
        score: round(score),
        text: trunc(m.x),
      });
      if (results.length >= limit) {
        break;
      }
    }
    return { matched: results.length, results };
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max messages to return (default 15)."),
    query: z
      .string()
      .describe(
        "Search terms. Ranked by BM25 relevance, so include the meaningful keywords; you don't need exact phrasing. Try synonyms or a broader query if the first search is thin."
      ),
    sender: z
      .string()
      .optional()
      .describe(
        "Optional: restrict to a person (substring match on name, e.g. 'Alice')."
      ),
  }),
});
