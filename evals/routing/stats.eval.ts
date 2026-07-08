import { defineEval } from "eve/evals";

export default defineEval({
  description: "A leaderboard ask counts via get-group-stats, not vibes.",
  async test(t) {
    await t.send("who sends the most messages here, top 3?");
    t.completed();
    t.calledTool("get-group-stats");
  },
});
