import { bridgeConfigured, bridgeGet, bridgePost } from "#lib/bridge-client.js";
import type { GroupMemoryCategory } from "#lib/memory-categories.js";

/**
 * Per-group long-term memory. The bridge persists one prose block per category
 * keyed by group JID; these helpers read it (to inject into the system prompt)
 * and write it (via the `save-memory` tool). Network helpers swallow errors and
 * fall back to empty so a bridge outage degrades the agent gracefully instead
 * of breaking a turn.
 */

/** Fetch the group's stored memory. Returns `{}` on any error or no bridge. */
export const fetchGroupMemory = async (
  groupJid: string
): Promise<Record<string, string>> => {
  if (!bridgeConfigured() || !groupJid) {
    return {};
  }
  try {
    const data = await bridgeGet<{ memory?: Record<string, string> }>(
      `/memory?group=${encodeURIComponent(groupJid)}`
    );
    return data.memory ?? {};
  } catch {
    return {};
  }
};

/** Replace one category's prose block for the group. */
export const saveGroupMemoryRemote = async (args: {
  groupJid: string;
  category: GroupMemoryCategory;
  content: string;
  by: string;
  reason: string;
}): Promise<{ saved: boolean }> => {
  const data = await bridgePost<{ saved?: boolean }>("/memory", {
    by: args.by,
    category: args.category,
    content: args.content,
    group: args.groupJid,
    reason: args.reason,
  });
  return { saved: Boolean(data.saved) };
};

const titleCase = (category: string): string =>
  category
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

/**
 * Render the stored memory as a markdown block for the system prompt. One
 * `## <Title Case category>` heading per non-empty category, prose underneath.
 * Returns `""` when there's nothing to show.
 */
export const buildGroupMemoryPrompt = (
  memory: Record<string, string>
): string => {
  const sections = Object.entries(memory)
    .filter(([, content]) => typeof content === "string" && content.trim())
    .map(
      ([category, content]) => `## ${titleCase(category)}\n\n${content.trim()}`
    );

  if (sections.length === 0) {
    return "";
  }
  return `# Group memory (learned over time)\n\n${sections.join("\n\n")}`;
};

/** Parse the comma-separated `MEMORY_ADMIN_JIDS` env var into a JID set. */
export const parseAdminJids = (raw?: string): Set<string> => {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
};

/** A JID's user part: everything before the first `@` or `:`. */
const userPart = (jid: string): string => jid.split(/[@:]/u)[0];

/** True when the sender's user part matches one of the admin JIDs' user parts. */
export const isAdmin = (
  senderJid: string | undefined,
  admins: Set<string>
): boolean => {
  if (!senderJid || admins.size === 0) {
    return false;
  }
  const sender = userPart(senderJid);
  for (const admin of admins) {
    if (userPart(admin) === sender) {
      return true;
    }
  }
  return false;
};

export type SaveGate =
  | { ok: true; groupJid: string }
  | { ok: false; reason: string };

/**
 * Decide whether a sender may write group memory: must be inside a group and an
 * admin. Pure so the security boundary is unit-testable without the network.
 */
export const canSaveMemory = (
  groupJid: string | null,
  senderJid: string | undefined,
  admins: Set<string>,
  senderPhone?: string
): SaveGate => {
  if (!groupJid) {
    return { ok: false, reason: "no group context" };
  }
  // Group memory is keyed by the group JID. In a 1:1 DM the JID is the DM chat,
  // not a group (`@g.us`), so a save there would persist under a key the group
  // never reads — refuse it rather than silently writing to the wrong place.
  if (!groupJid.endsWith("@g.us")) {
    return {
      ok: false,
      reason: "group memory can only be updated from the group, not a DM",
    };
  }
  // Match on either identity: modern WhatsApp's principal is an opaque @lid, so
  // the phone (from senderPn) is what lines up with phone-based admin JIDs.
  if (!isAdmin(senderJid, admins) && !isAdmin(senderPhone, admins)) {
    return { ok: false, reason: "only group admins can update memory" };
  }
  return { groupJid, ok: true };
};
