import { defineTool } from "eve/tools";
import { z } from "zod";

import { MEMORY_CATEGORIES } from "#lib/memory-categories.js";
import {
  canSaveMemory,
  fetchGroupMemory,
  parseAdminJids,
  saveGroupMemoryRemote,
} from "#lib/memory-internal.js";
import {
  groupJidFromAuth,
  senderJidFromAuth,
  senderPhoneFromAuth,
} from "#lib/session.js";

/**
 * Records durable GROUP memory via the bridge. No `needsApproval`: the
 * WhatsApp channel has no approval UI, so a gated call would stall the turn.
 * Access is gated in code instead — only configured group admins can save, and
 * a non-admin gets an honest "not allowed" result the model reports.
 *
 * Group JID and sender JID come from the WhatsApp session auth; absent on other
 * channels, where the tool just reports there's no group context.
 */

export default defineTool({
  description:
    "Record durable GROUP memory so it persists across conversations. Save only standing facts about the group, not ephemeral chat: roster changes, group decisions, new lore, recurring topics. Categories: group_facts, members, lore, recurring_topics, decisions. Each category holds ONE prose block and save-memory REPLACES it, so send the FULL updated text for that category, not just the delta. Make ONE save-memory call per turn with all changed categories batched into `updates`. Only group admins can save, and only from inside the group, not a DM (the tool enforces both). The result reports a per-category `confirmed` flag (read back from storage); only tell the user a change was recorded when `confirmed` is true. Never claim to remember something that isn't in the injected group-memory block.",
  async execute(input, ctx) {
    const gate = canSaveMemory(
      groupJidFromAuth(ctx.session.auth),
      senderJidFromAuth(ctx.session.auth),
      parseAdminJids(process.env.MEMORY_ADMIN_JIDS),
      senderPhoneFromAuth(ctx.session.auth)
    );
    if (!gate.ok) {
      return { reason: gate.reason, saved: false };
    }

    const by = senderJidFromAuth(ctx.session.auth) ?? "unknown";
    try {
      const saveResults = await Promise.all(
        input.updates.map((update) =>
          saveGroupMemoryRemote({
            by,
            category: update.category,
            content: update.content,
            groupJid: gate.groupJid,
            reason: input.reason,
          }).then(({ saved }) => [update.category, saved] as const)
        )
      );
      const written = new Map<string, boolean>(saveResults);

      // Read-after-write: re-fetch and confirm the bridge actually stored what
      // we sent, so a silent write failure surfaces instead of being assumed.
      // One extra GET regardless of how many categories changed; if it fails we
      // report confirmed:false rather than throwing.
      let stored: Record<string, string> = {};
      try {
        stored = await fetchGroupMemory(gate.groupJid);
      } catch {
        // leave empty → every category reports confirmed:false
      }
      const results = input.updates.map((u) => ({
        category: u.category,
        confirmed: (stored[u.category] ?? "").trim() === u.content.trim(),
        saved: written.get(u.category) ?? false,
      }));
      return { results, saved: true };
    } catch (error) {
      // Match the read tools: degrade instead of throwing out of the turn.
      return {
        error: String(error),
        reason: "memory backend unavailable",
        saved: false,
      };
    }
  },
  inputSchema: z.object({
    reason: z
      .string()
      .min(1)
      .describe(
        "Short note on why this is worth remembering (recorded in the audit log)."
      ),
    updates: z
      .array(
        z.object({
          category: z.enum(MEMORY_CATEGORIES),
          content: z
            .string()
            .trim()
            .min(1)
            .describe(
              "The FULL updated prose for this category; replaces the stored block."
            ),
        })
      )
      .min(1)
      .max(5)
      .describe(
        "One entry per category to update; batch all changes in a single call."
      ),
  }),
});
