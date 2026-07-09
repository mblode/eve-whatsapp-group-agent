import { defineEval } from "eve/evals";

/**
 * the agent can answer how it's built from the prompt alone, no tool call, and
 * names the real stack (eve + Claude sonnet) rather than guessing.
 */
export default defineEval({
  description:
    "Knows its own architecture and answers it in voice without tools.",
  async test(t) {
    await t.send(
      "the agent out of interest, how were you actually built? what's your stack"
    );
    t.succeeded();
    t.usedNoTools();
    t.judge.autoevals
      .closedQA(
        "explains it's an eve agent running on Claude (sonnet) wired into WhatsApp, accurately and concisely, in a casual group-chat voice rather than a structured corporate rundown"
      )
      .atLeast(0.7);
  },
});
