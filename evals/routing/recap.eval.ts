import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A recap ask pulls the live recent tail, not the static archive.",
  async test(t) {
    await t.send("what did I miss today? quick recap");
    t.completed();
    t.calledTool("get-recent-messages");
  },
});
