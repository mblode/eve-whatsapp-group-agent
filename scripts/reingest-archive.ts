#!/usr/bin/env node
/**
 * Refresh the embedded chat archive (`agent/lib/data/chat-data.ts`) from the
 * live Baileys bridge.
 *
 * The archive that `search-chat` / `get-group-stats` read is frozen — it ships
 * as a gzip+base64 blob baked into the deploy, so anything said after the last
 * reingest is invisible to search. This script pulls the recent tail from the
 * bridge's authenticated `/messages` endpoint, maps it to the archive's
 * `{t,s,x}` shape, re-gzips, and rewrites the data file in place.
 *
 * It is a standalone Node ESM script: no new dependencies, only built-in
 * `node:zlib` / `node:fs`. Run it from the repo root.
 *
 * Usage:
 *   BRIDGE_URL=https://… WHATSAPP_BRIDGE_SECRET=… \
 *     node scripts/reingest-archive.ts --group <group-jid> [--n 500] [--merge]
 *
 * Flags / env:
 *   --group <jid>   group JID to fetch (or env REFRESH_GROUP_JID).
 *   --n <count>     how many recent messages to fetch (default 500). The bridge
 *                   returns only the most recent N (capped at 500) with no
 *                   offset, so this is a single capped fetch of the tail; for
 *                   the full stored history use --export instead.
 *   --merge         merge the fetched tail onto the EXISTING archive (dedup by
 *                   date+sender+text) instead of replacing it. Use this to keep
 *                   the deep history while topping up the recent end. Without it
 *                   the file is replaced with only what the bridge returned.
 *   --export        pull the bridge's FULL stored history via /export (no 500
 *                   cap) instead of the recent tail. This REPLACES deep history
 *                   unless combined with --merge — a bare --export rewrites the
 *                   whole archive with only what /export returns, so always pair
 *                   it with --merge unless you intend a full replacement.
 *   --out <path>    output path (default agent/lib/data/chat-data.ts).
 *   --dry-run       print the summary but do not write the file.
 *
 * The bridge endpoint returns only the most recent N (no deep pagination), so
 * `--merge` is the safe default mental model: the bridge tops up the tail, the
 * baked archive holds the deep history. A bare run (replace) is only sensible
 * if the bridge buffer covers everything you want searchable.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  decodeExisting,
  recordKey,
  renderFile,
  toArchiveDate,
} from "./archive-io.ts";
import type { ArchiveRecord } from "./archive-io.ts";

const { resolve } = path;

/** A message as returned by the Baileys bridge `/messages` / `/export`. */
interface BridgeMessage {
  t: number;
  s: string;
  n?: string | null;
  x: string;
  id?: string;
}

/** Parsed CLI arguments. */
interface Args {
  dryRun: boolean;
  export: boolean;
  group: string;
  merge: boolean;
  n: number;
  out: string;
}

const DEFAULT_OUT = "agent/lib/data/chat-data.ts";
// mirrors clampN(..., 1, 500) in bridge/server.js
const BRIDGE_PER_REQUEST_CAP = 500;
const EXPORT_REPLACE_WARNING =
  "WARNING: --export without --merge REPLACES the whole archive (deep history included) with only what /export returns. Pass --merge to keep the baked deep history; proceed only if a full replacement is what you intend.";

const usage = (msg?: string): never => {
  if (msg) {
    console.error(`\nerror: ${msg}`);
  }
  console.error(`
Refresh the embedded chat archive from the live bridge.

Usage:
  BRIDGE_URL=… WHATSAPP_BRIDGE_SECRET=… \\
    node scripts/reingest-archive.ts --group <group-jid> [options]

Options:
  --group <jid>   group JID (or env REFRESH_GROUP_JID)
  --n <count>     recent messages to fetch (default 500, capped at 500)
  --merge         merge onto the existing archive (dedup) instead of replacing
  --export        pull the bridge's FULL stored history via /export (no 500 cap).
                  REPLACES deep history unless paired with --merge — use
                  --export --merge after a history backfill.
  --out <path>    output file (default ${DEFAULT_OUT})
  --dry-run       compute and report, but do not write

Env:
  BRIDGE_URL                base URL of the Baileys bridge
  WHATSAPP_BRIDGE_SECRET    shared secret for the x-bridge-secret header
  REFRESH_GROUP_JID         fallback for --group
`);
  process.exit(msg ? 1 : 0);
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    dryRun: false,
    export: false,
    group: "",
    merge: false,
    n: 500,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      usage();
    } else if (a === "--merge") {
      args.merge = true;
    } else if (a === "--export") {
      args.export = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--group") {
      i += 1;
      args.group = argv[i] ?? "";
    } else if (a === "--n") {
      i += 1;
      args.n = Number(argv[i]);
    } else if (a === "--out") {
      i += 1;
      args.out = argv[i] ?? DEFAULT_OUT;
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  return args;
};

/** Fetch the most recent `n` messages from the bridge (capped at 500). */
const fetchMessages = async (
  base: string,
  secret: string,
  group: string,
  n: number
): Promise<BridgeMessage[]> => {
  // The bridge returns the most recent N with no offset, so one capped request
  // already gives the newest tail — there's nothing to page. For the full
  // stored history use --export instead.
  const req = Math.min(n, BRIDGE_PER_REQUEST_CAP);
  const url = `${base}/messages?group=${encodeURIComponent(group)}&n=${req}`;
  const res = await fetch(url, { headers: { "x-bridge-secret": secret } });
  if (!res.ok) {
    throw new Error(`bridge GET /messages → ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { messages?: BridgeMessage[] };
  return Array.isArray(data.messages) ? data.messages : [];
};

/**
 * Fetch the bridge's full stored history for a group via /export (no recent
 * cap), so a history backfill on the bridge can be baked into the archive in one
 * shot. Use with --merge to keep the deep history and top up the recent end.
 */
const fetchExport = async (
  base: string,
  secret: string,
  group: string
): Promise<BridgeMessage[]> => {
  const url = `${base}/export?group=${encodeURIComponent(group)}`;
  const res = await fetch(url, { headers: { "x-bridge-secret": secret } });
  if (!res.ok) {
    throw new Error(`bridge GET /export → ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { messages?: BridgeMessage[] };
  return Array.isArray(data.messages) ? data.messages : [];
};

/** Map a bridge message `{t,s,n,x}` to the archive shape `{t,s,x}`. */
const toArchiveRecord = (m: BridgeMessage): ArchiveRecord => ({
  s: m.n || m.s || "Unknown",
  t: toArchiveDate(m.t),
  x: typeof m.x === "string" ? m.x : "",
});

/** Result of merging the fetched tail onto the existing archive. */
interface MergeResult {
  records: ArchiveRecord[];
  existingCount: number;
  addedCount: number;
}

/** Merge the fetched tail onto the existing archive (dedup by recordKey). */
const mergeOntoExisting = (
  tail: ArchiveRecord[],
  outPath: string
): MergeResult => {
  let existing: ArchiveRecord[] = [];
  try {
    existing = decodeExisting(outPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `  warning: could not read existing archive to merge (${message}); writing tail only.`
    );
  }
  const seen = new Set(existing.map(recordKey));
  const fresh = tail.filter((r) => !seen.has(recordKey(r)));
  return {
    addedCount: fresh.length,
    existingCount: existing.length,
    records: [...existing, ...fresh],
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.BRIDGE_URL ?? "").trim().replace(/\/+$/u, "");
  const secret = process.env.WHATSAPP_BRIDGE_SECRET ?? "";
  const group = (args.group || process.env.REFRESH_GROUP_JID || "").trim();

  if (!base) {
    usage("BRIDGE_URL is required");
  }
  if (!secret) {
    usage("WHATSAPP_BRIDGE_SECRET is required");
  }
  if (!group) {
    usage("--group (or REFRESH_GROUP_JID) is required");
  }
  if (!Number.isFinite(args.n) || args.n < 1) {
    usage("--n must be a positive number");
  }

  const outPath = resolve(process.cwd(), args.out);

  let fetched: BridgeMessage[];
  if (args.export) {
    if (!args.merge) {
      console.warn(`\n${EXPORT_REPLACE_WARNING}\n`);
    }
    console.log(
      `Fetching ALL stored history for group ${group} from ${base} (/export) …`
    );
    fetched = await fetchExport(base, secret, group);
  } else {
    console.log(
      `Fetching up to ${args.n} messages for group ${group} from ${base} …`
    );
    fetched = await fetchMessages(base, secret, group, args.n);
  }
  console.log(`  bridge returned ${fetched.length} messages.`);

  const tail = fetched.map(toArchiveRecord);

  let records = tail;
  let existingCount = 0;
  let addedCount = tail.length;
  if (args.merge) {
    const merged = mergeOntoExisting(tail, outPath);
    ({ records } = merged);
    ({ existingCount } = merged);
    ({ addedCount } = merged);
  }

  console.log("\nSummary");
  console.log(
    `  mode:            ${args.merge ? "merge onto existing" : "replace"}`
  );
  if (args.merge) {
    console.log(`  existing:        ${existingCount} messages`);
  }
  console.log(`  fetched (tail):  ${tail.length} messages`);
  console.log(`  new added:       ${addedCount} messages`);
  console.log(`  total written:   ${records.length} messages`);
  if (records.length) {
    console.log(`  date range:      ${records[0]?.t} → ${records.at(-1)?.t}`);
  }
  console.log(`  output:          ${outPath}`);

  if (!records.length) {
    usage("refusing to write an empty archive");
  }

  if (args.dryRun) {
    console.log("\n--dry-run: not writing.");
    return;
  }

  writeFileSync(outPath, renderFile(records), "utf-8");
  console.log(
    "\nDone. Rebuild/redeploy so the new archive ships with the agent."
  );
};

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.stack || error.message : error;
  console.error(`\nreingest failed: ${detail}`);
  process.exit(1);
}
