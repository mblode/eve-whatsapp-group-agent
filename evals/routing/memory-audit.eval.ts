import { defineEval } from "eve/evals";

export default defineEval({
  description: "A memory-health ask routes to audit-memory, not a guess.",
  async test(t) {
    await t.send(
      "the agent how's our group memory looking? anything stale or out of date?"
    );
    t.succeeded();
    t.calledTool("audit-memory");
  },
});
