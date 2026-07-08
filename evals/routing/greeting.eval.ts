import { defineEval } from "eve/evals";

export default defineEval({
  description: "A plain greeting doesn't trigger any tool calls.",
  async test(t) {
    await t.send("morning all, big day ahead");
    t.completed();
    t.usedNoTools();
  },
});
