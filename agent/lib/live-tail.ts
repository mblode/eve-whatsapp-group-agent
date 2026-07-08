import { bridgeConfigured, bridgeGet } from "#lib/bridge-client.js";
import type { ChatMessage } from "#lib/chat-archive.js";

/**
 * Shared live-tail helpers: fetch the recent messages the Baileys bridge holds
 * (anything since the embedded archive's cutoff), normalise them to the archive
 * `{t,s,x}` shape, and merge them onto the static archive — deduped.
 *
 * The embedded archive is frozen at the last `scripts/reingest-archive.mjs` run,
 * so search and stats miss anything said since. These helpers let `search-chat`
 * and `get-group-stats` cover the recent tail too. The normalisation + dedup key
 * are deliberately identical to the offline reingest script, so a live row that
 * gets merged in-process dedupes against the same row once it's baked into the
 * archive by a later reingest.
 */

/** A row as the bridge's `/messages` endpoint returns it. */
export interface BridgeMessage {
  t: number;
  s: string;
  n: string | null;
  x: string;
}

/** Convert a unix-seconds timestamp to the archive's `D/M/YYYY` (un-padded). */
export const toArchiveDate = (unixSeconds: number): string => {
  const d = new Date(unixSeconds * 1000);
  // Archive dates are WhatsApp-export local dates with no time component.
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};

/** Map a bridge message `{t,s,n,x}` to the archive shape `{t,s,x}`. */
export const toArchiveRecord = (m: BridgeMessage): ChatMessage => ({
  s: m.n || m.s || "Unknown",
  t: toArchiveDate(m.t),
  x: typeof m.x === "string" ? m.x : "",
});

/** Stable dedup key (date + sender + text); matches reingest-archive.mjs. */
export const recordKey = (r: ChatMessage): string => `${r.t} ${r.s} ${r.x}`;

/**
 * Fetch the live tail for a group, normalised to archive shape (oldest→newest,
 * the order the bridge returns). Returns `[]` — never throws — when the bridge
 * is unconfigured, there's no group jid (e.g. the eve TUI), or the call fails,
 * so callers degrade to archive-only with no special-casing.
 */
export const fetchLiveTail = async (
  jid: string | null,
  n = 500
): Promise<ChatMessage[]> => {
  if (!bridgeConfigured() || !jid) {
    return [];
  }
  try {
    const data = await bridgeGet<{ messages: BridgeMessage[] }>(
      `/messages?group=${encodeURIComponent(jid)}&n=${n}`
    );
    return (data.messages ?? []).map(toArchiveRecord);
  } catch {
    return [];
  }
};

/** Rows in `tail` that aren't already in `archive` (by recordKey). */
export const freshTail = (
  archive: ChatMessage[],
  tail: ChatMessage[]
): ChatMessage[] => {
  if (tail.length === 0) {
    return [];
  }
  const seen = new Set(archive.map(recordKey));
  return tail.filter((r) => !seen.has(recordKey(r)));
};

/**
 * Merge the live tail onto the static archive, deduped. The archive is the base
 * (deep history); only-new live rows are appended, preserving the tail's recency
 * at the end. Returns the archive unchanged when nothing fresh comes in.
 */
export const mergeArchiveAndTail = (
  archive: ChatMessage[],
  tail: ChatMessage[]
): ChatMessage[] => {
  const fresh = freshTail(archive, tail);
  return fresh.length ? [...archive, ...fresh] : archive;
};

/** A scored archive/live row, ahead of the cross-corpus merge. */
export interface RankedRow {
  m: ChatMessage;
  score: number;
}

/** Normalise a list of ranked rows to [0,1] against the top score, plus a boost. */
const normRanked = (xs: RankedRow[], boost: number): RankedRow[] => {
  let max = 0;
  for (const x of xs) {
    if (x.score > max) {
      max = x.score;
    }
  }
  if (max === 0) {
    max = 1;
  }
  return xs.map((x) => ({ m: x.m, score: x.score / max + boost }));
};

/**
 * Merge ranked hits from the archive index and the (separate) live-tail index.
 *
 * Raw Okapi BM25 scores are corpus-relative — IDF uses each index's own N/df —
 * so they aren't comparable across two indexes. We min-max normalise each list
 * to [0,1] against its own top hit, then merge: "best in archive" and "best in
 * tail" land on the same scale. A small constant boost on live rows breaks ties
 * toward the recent message, which is exactly the "who said X last week" intent.
 */
export const mergeRanked = (
  archiveHits: RankedRow[],
  liveHits: RankedRow[],
  limit: number
): RankedRow[] => {
  const LIVE_BOOST = 0.05;
  return [...normRanked(archiveHits, 0), ...normRanked(liveHits, LIVE_BOOST)]
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit);
};
