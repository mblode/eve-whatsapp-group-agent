import { gunzipSync } from "node:zlib";

import { CHAT_GZIP_B64 } from "#data/chat-data.js";
import { buildBm25 } from "#lib/bm25.js";
import type { Bm25Index } from "#lib/bm25.js";

/**
 * The embedded group chat archive, shipped gzipped+base64 so it travels with the
 * deployment without a database. Empty by default in this template (see
 * `#data/chat-data.js`); populate it from your own export with
 * `scripts/reingest-archive.ts`. Decoded and parsed once per process and cached,
 * so multiple tools (search-chat, get-group-stats) share a single in-memory copy.
 */

/** An aggregated emoji reaction on a message: emoji + how many people used it. */
export interface Reaction {
  e: string;
  n: number;
}

export interface ChatMessage {
  /** Date as "D/M/YYYY" (kept for dedup + back-compat with the original export). */
  t: string;
  /** Sender display name ("who"). */
  s: string;
  /** Message text. */
  x: string;
  /** Unix seconds (precise time), when known (richer rows from the wacli import). */
  ts?: number;
  /** Aggregated emoji reactions, when any (from the wacli import). */
  r?: Reaction[];
}

let cached: ChatMessage[] | null = null;

/** Decode + parse the embedded archive once; cached for the process lifetime. */
export const loadArchive = (): ChatMessage[] => {
  if (!cached) {
    const json = gunzipSync(Buffer.from(CHAT_GZIP_B64, "base64")).toString(
      "utf-8"
    );
    cached = JSON.parse(json) as ChatMessage[];
  }
  return cached;
};

let cachedIndex: { messages: ChatMessage[]; index: Bm25Index } | null = null;

/**
 * Shared BM25 index over the archive, indexing "Sender: text" so a person's name
 * is a lexical signal. Built once and reused by every caller (search-chat,
 * audit-memory) so the ~9k-message index isn't held in memory twice.
 */
export const getArchiveIndex = (): {
  messages: ChatMessage[];
  index: Bm25Index;
} => {
  if (!cachedIndex) {
    const messages = loadArchive();
    cachedIndex = {
      index: buildBm25(messages.map((m) => `${m.s}: ${m.x}`)),
      messages,
    };
  }
  return cachedIndex;
};
