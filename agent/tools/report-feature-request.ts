import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeConfigured, bridgePost } from "#lib/bridge-client.js";
import { senderNameFromAuth } from "#lib/session.js";

/**
 * Forward a feature request or bug report about the agent to the maintainer
 * (the maintainer) as a WhatsApp DM, via the bridge's `/report` endpoint. There's no
 * issue tracker yet, so this is the lightweight backlog: actionable asks reach
 * the maintainer directly instead of getting lost in the chat.
 *
 * The bridge dedupes repeat reports and DMs a configured maintainer JID; if the
 * bridge is unreachable or has no maintainer configured it reports back
 * `reported: false` rather than throwing, matching the other bridge tools.
 */

export default defineTool({
  description:
    "Forward a feature request or bug report about the agent (the agent) to the maintainer, as a private message. Use it only when someone clearly asks for a new capability or reports something broken about you, not for idle gripes, jokes, or general chat. Make ONE call per distinct request with a tight one-line summary. The maintainer is notified directly; tell the member you've passed it to the maintainer, and don't promise it'll be built or give a timeline. Returns `reported: true` when it was delivered (or `duplicate: true` if the same request was already forwarded).",
  async execute(input, ctx) {
    if (!bridgeConfigured()) {
      return {
        available: false,
        note: "Reporting is only available when connected to the WhatsApp bridge.",
      };
    }
    try {
      const data = await bridgePost<{
        delivered?: boolean;
        duplicate?: boolean;
      }>("/report", {
        details: input.details,
        kind: input.kind,
        requestedBy: senderNameFromAuth(ctx.session.auth),
        summary: input.summary,
      });
      return {
        duplicate: Boolean(data.duplicate),
        reported: Boolean(data.delivered),
      };
    } catch (error) {
      // Match the read tools: degrade instead of throwing out of the turn.
      return { error: String(error), reported: false };
    }
  },
  inputSchema: z.object({
    details: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe(
        "Optional extra context: steps to reproduce a bug, the use case behind a request."
      ),
    kind: z
      .enum(["feature", "bug"])
      .describe("Whether this is a feature request or a bug report."),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .describe("One-line summary of the request or bug, in plain language."),
  }),
});
