/**
 * Shared archive round-trip helpers for the offline maintenance scripts.
 *
 * The embedded chat archive (`agent/lib/data/chat-data.ts`) ships as a
 * gzip+base64 blob that `search-chat` / `get-group-stats` read. Every script
 * under `scripts/` that reads or rewrites it needs the same primitives:
 * decode the existing blob, re-encode a record array, key records for dedup,
 * and aggregate raw reaction rows into the archive's `r` shape. Those used to
 * be copy-pasted (and had drifted — see `renderFile`); they live here once.
 *
 * No dependencies beyond built-in `node:zlib` / `node:fs`, so the scripts stay
 * runnable directly under Node's native TypeScript stripping (no build step).
 */

import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

/** A reaction on an archive record: emoji + how many reacted. */
export interface ArchiveReaction {
  e: string;
  n: number;
}

/** The archive record shape `search-chat` / `get-group-stats` read. */
export interface ArchiveRecord {
  t: string;
  s: string;
  x: string;
  ts?: number;
  r?: ArchiveReaction[];
}

/** unix seconds -> archive "D/M/YYYY" (un-padded local date). */
export const toArchiveDate = (unixSeconds: number): string => {
  const d = new Date(unixSeconds * 1000);
  // Archive dates are WhatsApp-export local dates with no time component.
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};

/** Stable dedup key for an archive record (date + sender + text). */
export const recordKey = (r: ArchiveRecord): string => `${r.t} ${r.s} ${r.x}`;

/** Decode an existing data file's CHAT_GZIP_B64 into the record array. */
export const decodeExisting = (filePath: string): ArchiveRecord[] => {
  const src = readFileSync(filePath, "utf-8");
  const m = src.match(/"(?<b64>[A-Za-z0-9+/=\s]+)"/u);
  if (!m?.groups) {
    throw new Error(`could not find CHAT_GZIP_B64 string in ${filePath}`);
  }
  const b64 = m.groups.b64.replaceAll(/\s+/gu, "");
  const json = gunzipSync(Buffer.from(b64, "base64")).toString("utf-8");
  return JSON.parse(json) as ArchiveRecord[];
};

/**
 * Render the archive data file: gzip+base64 the records and wrap the base64 at
 * 120 chars so the committed blob diffs line-by-line instead of as one giant
 * string. `decodeExisting` strips the whitespace back out on read.
 */
export const renderFile = (records: ArchiveRecord[]): string => {
  const json = JSON.stringify(records);
  const b64 = gzipSync(Buffer.from(json, "utf-8")).toString("base64");
  const wrapped = b64.replaceAll(/(?<chunk>.{120})/gu, "$<chunk>\n");
  return `// Auto-generated from a WhatsApp group export. Do not edit by hand.
// ${records.length} messages, gzipped + base64 for zero-dependency shipping.
export const CHAT_GZIP_B64 =
  "${wrapped}";
`;
};

/** A normalised reaction row: the four fields the aggregation needs. */
export interface RawReaction {
  /** Target message id (the reacted-to message). */
  target: string;
  /** Reactor identity — used only to dedup latest-per-reactor. */
  reactor: string;
  /** Reaction time (any monotonic unit; only compared, never displayed). */
  ts: number;
  /** Emoji; empty string means the reaction was removed. */
  emoji: string;
}

/**
 * Aggregate raw reaction rows per target message id into the archive's `r`
 * shape. The latest reaction per (target, reactor) wins and removals (empty
 * emoji) drop, so swapping or un-reacting doesn't inflate counts. Returns
 * `Map<target, [{ e, n }]>` sorted by count desc.
 *
 * Each source (wacli rows, the bridge `/reactions` feed, the WhatsApp-Web IDB
 * export) names its fields differently; the caller maps to `RawReaction` first.
 */
export const aggregateReactions = (
  rows: RawReaction[]
): Map<string, ArchiveReaction[]> => {
  const latest = new Map<string, RawReaction>();
  for (const r of rows) {
    if (!r.target || !r.reactor) {
      continue;
    }
    const key = `${r.target}|${r.reactor}`;
    const prev = latest.get(key);
    if (!prev || (r.ts ?? 0) >= (prev.ts ?? 0)) {
      latest.set(key, r);
    }
  }
  const counts = new Map<string, Map<string, number>>();
  for (const r of latest.values()) {
    if (!r.emoji) {
      continue;
    }
    const byEmoji = counts.get(r.target) ?? new Map<string, number>();
    byEmoji.set(r.emoji, (byEmoji.get(r.emoji) ?? 0) + 1);
    counts.set(r.target, byEmoji);
  }
  const out = new Map<string, ArchiveReaction[]>();
  for (const [target, byEmoji] of counts) {
    out.set(
      target,
      [...byEmoji.entries()]
        .map(([e, n]) => ({ e, n }))
        .toSorted((a, b) => b.n - a.n)
    );
  }
  return out;
};
