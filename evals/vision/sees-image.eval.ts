import { defineEval } from "eve/evals";

/**
 * End-to-end vision check: attach an image and confirm the agent actually sees
 * it. The WhatsApp channel forwards images into the same multimodal send(), so
 * this exercises the core capability the bridge depends on.
 */
export default defineEval({
  description: "Sees an attached image and describes its colour.",
  async test(t) {
    await t.sendFile(
      "what colour is this image? one word.",
      "evals/data/red-square.png",
      "image/png"
    );
    t.succeeded();
    t.messageIncludes(/red/iu);
  },
});
