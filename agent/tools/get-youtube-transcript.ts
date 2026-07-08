import { defineTool } from "eve/tools";
import { z } from "zod";

import { fetchTranscript } from "#lib/youtube.js";

/**
 * Pull a YouTube video's transcript so the agent can summarise it or answer
 * what it covers. No API key: it scrapes the watch page and reads the embedded
 * caption tracks (see `#lib/youtube.ts`). Returns the title, channel, and full
 * transcript text. Every failure (bad link, captions disabled, login wall)
 * comes back as `found: false` with a plain `note` rather than throwing, so the
 * agent can say why instead of erroring.
 *
 * Long transcripts are capped to `maxChars` (default 60k) so a multi-hour video
 * can't blow the context; the agent gets a `truncated` flag when that happens.
 */

const DEFAULT_MAX_CHARS = 60_000;

export default defineTool({
  description:
    "Fetch the transcript/captions of a YouTube video so you can summarise it or answer what it covers. Pass the YouTube URL (youtu.be, watch?v=, /live/, /shorts/) or the 11-char video id. Returns the title, channel, language, and full transcript text. Use it whenever someone shares a YouTube link and asks for a summary, the TLDR, or what the video is about. If it comes back found:false, relay the note (e.g. captions disabled) plainly.",
  async execute(input) {
    const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
    const result = await fetchTranscript(input.url, { lang: input.lang });

    if (!result.found || !result.text) {
      return {
        author: result.author,
        found: false,
        note: result.note ?? "Couldn't get a transcript for that video.",
        title: result.title,
        videoId: result.videoId,
      };
    }

    const full = result.text;
    const truncated = full.length > maxChars;
    return {
      author: result.author,
      found: true,
      lang: result.lang,
      lengthSeconds: result.lengthSeconds,
      title: result.title,
      transcript: truncated ? `${full.slice(0, maxChars)}…` : full,
      truncated,
      videoId: result.videoId,
    };
  },
  inputSchema: z.object({
    lang: z
      .string()
      .optional()
      .describe(
        "Preferred caption language code prefix (default 'en'). Falls back to any available track if the language isn't present."
      ),
    maxChars: z
      .number()
      .int()
      .min(1000)
      .max(200_000)
      .optional()
      .describe(
        "Cap on transcript characters returned (default 60000). Long videos are truncated with a `truncated` flag."
      ),
    url: z
      .string()
      .describe(
        "YouTube URL or 11-character video id. Accepts youtu.be/…, youtube.com/watch?v=…, /live/…, /shorts/…, /embed/…"
      ),
  }),
});
