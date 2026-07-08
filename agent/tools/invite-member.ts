import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeConfigured, bridgePost } from "#lib/bridge-client.js";
import { senderNameFromAuth } from "#lib/session.js";

/**
 * Forward a member invite / referral to the maintainer as a WhatsApp
 * DM, via the bridge's `/invite` endpoint. Members use this to put a
 * prospective member in front of the maintainer: either by typing the person's details
 * or by sharing their contact card (which the bridge renders into text the agent
 * reads the fields off).
 *
 * The bridge dedupes repeat invites (by name + phone) and DMs the configured
 * maintainer JID; if the bridge is unreachable or has no maintainer configured
 * it reports back `invited: false` rather than throwing, matching the other
 * bridge tools.
 */

export default defineTool({
  description:
    "Forward a member invite/referral to the maintainer, as a private message. Use it when a member wants to invite or refer a specific person to the group, or shares that person's contact card. Only call it AFTER you've read the details back to the sender and they've confirmed. Never forward on a guess. Requires at least a full name and phone number (email and LinkedIn are optional extras). Make ONE call per person. Tell the member you've passed it to the maintainer; don't promise the person will be added or give a timeline. Returns `invited: true` when it was delivered (or `duplicate: true` if the same person was already forwarded).",
  async execute(input, ctx) {
    if (!bridgeConfigured()) {
      return {
        available: false,
        note: "Inviting is only available when connected to the WhatsApp bridge.",
      };
    }
    try {
      const data = await bridgePost<{
        delivered?: boolean;
        duplicate?: boolean;
      }>("/invite", {
        email: input.email,
        fullName: input.fullName,
        linkedIn: input.linkedIn,
        note: input.note,
        phone: input.phone,
        requestedBy: senderNameFromAuth(ctx.session.auth),
        source: input.source,
      });
      return {
        duplicate: Boolean(data.duplicate),
        invited: Boolean(data.delivered),
      };
    } catch (error) {
      // Match the read tools: degrade instead of throwing out of the turn.
      return { error: String(error), invited: false };
    }
  },
  inputSchema: z.object({
    email: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("The person's email address, if given (optional)."),
    fullName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("The full name of the person being invited."),
    linkedIn: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe("The person's LinkedIn profile URL, if given (optional)."),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe(
        "Optional extra context for the maintainer: how the member knows them, why they'd be a fit."
      ),
    phone: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .describe("The person's phone number, including country code if given."),
    source: z
      .enum(["form", "contact-card"])
      .optional()
      .describe(
        "Where the details came from: 'form' when the member typed them, 'contact-card' when read off a shared contact."
      ),
  }),
});
