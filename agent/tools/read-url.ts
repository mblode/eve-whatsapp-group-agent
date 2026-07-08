import { defineTool } from "eve/tools";
import { z } from "zod";

import { DEFAULT_MAX_CHARS, scrapeUrl } from "#lib/firecrawl.js";

/**
 * Read a web page or PDF through Firecrawl, which renders JS and parses PDFs
 * server-side — so it works where the built-in `web_fetch` only gets the shell
 * (SPA-rendered articles) or raw bytes (an arxiv `/pdf/` link). Returns the
 * page title and its content as markdown, capped to `maxChars` (default 60k) so
 * a long paper can't blow the context, with a `truncated` flag when cut.
 *
 * Every failure — no Firecrawl key, a bad URL, an HTTP error, an empty page —
 * comes back as `available:false` or `found:false` with a plain `note` rather
 * than throwing, so the agent can say why instead of erroring.
 */

export default defineTool({
  description:
    "Read the full content of a web page or PDF and get it back as clean text/markdown. Use this whenever someone shares a link (an article, blog post, docs page, or a PDF like an arxiv /pdf/ link) and wants a summary, the TLDR, or what it says, especially when web_fetch came back with just a shell/nav or couldn't parse it. It renders JavaScript and parses PDFs, so summarise from the returned markdown, not the URL. If it returns found:false or available:false, relay the plain note (e.g. couldn't reach it, page empty) instead of claiming you can't read links.",
  async execute(input) {
    const result = await scrapeUrl(input.url, { maxChars: input.maxChars });
    if (!result.available) {
      return {
        available: false,
        found: false,
        note: result.note ?? "URL reading isn't configured.",
      };
    }
    if (!result.found) {
      return {
        available: true,
        found: false,
        note: result.note ?? "Couldn't read that page.",
        sourceUrl: result.sourceUrl,
        title: result.title,
      };
    }
    return {
      available: true,
      content: result.markdown,
      found: true,
      sourceUrl: result.sourceUrl,
      title: result.title,
      truncated: result.truncated,
    };
  },
  inputSchema: z.object({
    maxChars: z
      .number()
      .int()
      .min(1000)
      .max(200_000)
      .optional()
      .describe(
        `Cap on content characters returned (default ${DEFAULT_MAX_CHARS}). Long pages are truncated with a \`truncated\` flag.`
      ),
    url: z
      .string()
      .describe(
        "The URL to read. A full http(s) link is best; a bare domain works too. Accepts normal web pages and PDFs (e.g. arxiv /pdf/ links)."
      ),
  }),
});
