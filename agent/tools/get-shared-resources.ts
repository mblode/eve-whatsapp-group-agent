import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeGet } from "#lib/bridge-client.js";
import { withGroupBridge } from "#lib/bridge-tool.js";

/**
 * Recent links/resources shared in the group, fetched from the Baileys bridge.
 * Use it for "what links/resources were shared" asks. The group JID comes from
 * the WhatsApp session auth; on other channels there's no group, so the tool
 * returns `available: false` rather than throwing.
 */

interface BridgeResource {
  t: number;
  s: string;
  n: string | null;
  url: string;
}

export default defineTool({
  description:
    "Get links/resources recently shared in this WhatsApp group. Use it for 'what links were shared' / 'any resources on X' / 'send me that link' asks. Returns oldest→newest with date, who shared it, and the URL.",
  execute(input, ctx) {
    return withGroupBridge(
      ctx,
      {
        note: "Shared resources are only available inside the WhatsApp group.",
        resources: [] as { date: string; from: string; url: string }[],
      },
      async (jid) => {
        const limit = input.limit ?? 40;
        const data = await bridgeGet<{ resources: BridgeResource[] }>(
          `/resources?group=${encodeURIComponent(jid)}&n=${limit}`
        );
        const resources = data.resources.map((r) => ({
          date: new Date(r.t * 1000).toISOString(),
          from: r.n || r.s,
          url: r.url,
        }));
        return { available: true as const, count: resources.length, resources };
      }
    );
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many recent resources to fetch (default 40)."),
  }),
});
