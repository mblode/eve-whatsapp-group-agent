import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A 'who said X' recall ask searches the chat (which now spans recent + archive).",
  async test(t) {
    await t.send("who was talking about pricing changes in here recently?");
    t.succeeded();
    t.calledTool("search-chat");
  },
});
