import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

const SLOP =
  /\b(?<word>actionable|boasts|crucial|delve|elevate|empower|facilitate|foster|furthermore|holistic|impactful|intricate|learnings|leverage|moreover|nuanced|pivotal|robust|seamless|showcase|streamline|underscores|unlock|utilize)\b/iu;

export default defineEval({
  description: "Replies in the group's voice: no em dashes, no AI-slop words.",
  async test(t) {
    await t.send("what's the take on the new shared tool in here?");
    t.succeeded();
    // Soft (tracked): the deterministic guard strips em dashes on the WhatsApp
    // way out, but we still watch the model's raw tendency here.
    t.check(
      t.reply,
      matches(
        z
          .string()
          .refine((s) => !/[—–]/u.test(s), "raw reply has an em/en dash")
      )
    ).soft();
    t.check(
      t.reply,
      matches(
        z
          .string()
          .refine((s) => !SLOP.test(s), "raw reply has a banned slop word")
      )
    ).soft();
    // Grades the voice, not the length: a comparative "take" ask legitimately
    // warrants grounding when there is group evidence. This starter repo ships
    // an empty archive, so an honest "no group hits" answer should also pass.
    t.judge.autoevals
      .closedQA(
        "sounds like a terse Australian builder in a WhatsApp group rather than a corporate assistant: short natural lines, plain language, no prompt echo, AI preamble, or sign-off, and either grounds the take in named group messages when available or plainly says there are no group-history hits instead of inventing a take"
      )
      .atLeast(0.6);
  },
});
