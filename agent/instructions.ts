import { defineDynamic, defineInstructions } from "eve/instructions";

import { BASE_INSTRUCTIONS } from "#lib/base-instructions.js";
import { EASTER_EGGS } from "#lib/easter-eggs.js";
import { MEMORY_CATEGORIES } from "#lib/memory-categories.js";
import {
  buildGroupMemoryPrompt,
  fetchGroupMemory,
  isAdmin,
  parseAdminJids,
} from "#lib/memory-internal.js";
import {
  groupJidFromAuth,
  senderJidFromAuth,
  senderPhoneFromAuth,
} from "#lib/session.js";

/**
 * Dynamic system prompt. The base identity is constant; per-group long-term
 * memory (stored on the bridge, keyed by group JID) is fetched on session start
 * and appended so the agent carries standing facts into every turn. Outside a
 * WhatsApp group (e.g. the eve TUI) there's no group JID, so we serve the base
 * prompt alone.
 *
 * Each WhatsApp message runs as a fresh session, so `session.started` fires once
 * per turn — which lets us cheaply add a per-turn "memory advisory" when an
 * admin is speaking and memory is thin. The nudge only appears for an admin
 * (the only one who can save), and only when there's a real gap, so the agent
 * self-heals its knowledge as a side effect of normal conversation.
 */

/**
 * A short note, shown ONLY to admins, listing empty memory categories so the agent
 * knows where a save would help if the chat surfaces something. Derived from the
 * already-fetched memory (no extra bridge call). Empty string when there's
 * nothing to nudge about.
 */
const memoryAdvisory = (
  memory: Record<string, string>,
  senderIsAdmin: boolean
): string => {
  if (!senderIsAdmin) {
    return "";
  }
  const empty = MEMORY_CATEGORIES.filter(
    (c) => !memory[c] || !memory[c].trim()
  );
  if (empty.length === 0) {
    return "";
  }
  return [
    "# Memory note (you're talking to an admin)",
    "",
    `Stored memory has nothing yet for: ${empty.join(", ")}. If this chat surfaces a durable fact that fits one of those, offer once to record it (admin-gated save). Don't force it.`,
  ].join("\n");
};

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const jid = groupJidFromAuth(ctx.session.auth);
      if (!jid) {
        // Eve TUI: no group memory, but eggs ride along so they're testable here.
        const base = [BASE_INSTRUCTIONS, EASTER_EGGS].filter(Boolean);
        return defineInstructions({ markdown: base.join("\n\n---\n\n") });
      }

      const memory = await fetchGroupMemory(jid);
      const admins = parseAdminJids(process.env.MEMORY_ADMIN_JIDS);
      // Either identity may match: the principal is often an opaque @lid, so
      // the phone (from senderPn) is what lines up with phone-based admin JIDs.
      const senderIsAdmin =
        isAdmin(senderJidFromAuth(ctx.session.auth), admins) ||
        isAdmin(senderPhoneFromAuth(ctx.session.auth), admins);

      const sections = [BASE_INSTRUCTIONS, EASTER_EGGS].filter(Boolean);
      const block = buildGroupMemoryPrompt(memory);
      if (block) {
        sections.push(block);
      }
      const advisory = memoryAdvisory(memory, senderIsAdmin);
      if (advisory) {
        sections.push(advisory);
      }

      return defineInstructions({ markdown: sections.join("\n\n---\n\n") });
    },
  },
});
