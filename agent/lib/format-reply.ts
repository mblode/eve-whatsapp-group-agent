/**
 * Deterministic cleanup applied to every reply on the way out to WhatsApp.
 *
 * The model drifts toward two things the group reads as wrong:
 *  1. Em/en dashes, which the group reads as AI-written.
 *  2. Markdown emphasis (`**bold**`, `__bold__`, `## heading`). WhatsApp's bold
 *     is a *single* asterisk, so a Markdown `**Update:**` renders as the
 *     literal text `*Update:*` (WhatsApp eats the outer pair as bold and
 *     leaves the inner asterisks showing). We normalise Markdown emphasis to
 *     WhatsApp's single-asterisk bold so it renders cleanly.
 *
 * Triple-backtick blocks are deliberately left alone: WhatsApp renders them as
 * monospace, which is what makes the agent's ASCII art land.
 *
 * Kept pure and standalone so it's unit-testable without booting the agent.
 */
export const cleanReply = (text: string): string =>
  text
    // Markdown ATX headings (`## Title`) → a WhatsApp bold line, no leading #.
    .replaceAll(
      /^[ \t]{0,3}#{1,6}[ \t]+(?<heading>.+?)[ \t]*#*$/gmu,
      "*$<heading>*"
    )
    // Markdown `__bold__` → WhatsApp bold. Single `_italic_` is valid in both
    // and is left untouched (the pattern needs two adjacent underscores).
    .replaceAll(/__(?<bold>\S(?:.*?\S)?)__/gu, "*$<bold>*")
    // Collapse any run of 2+ asterisks to one. Turns Markdown `**bold**` into
    // WhatsApp `*bold*`; already-correct single `*bold*` is untouched.
    .replaceAll(/\*{2,}/gu, "*")
    // Em/en dash used as punctuation → comma. A spaced dash (` — `) or a
    // dash hugging one side becomes a comma.
    .replaceAll(/ *[—–] +| +[—–] */gu, ", ")
    // Word-joined dash (`foo—bar`) → comma; numeric ranges (4–5) are kept.
    .replaceAll(/(?<pre>[a-zA-Z])[—–](?<post>[a-zA-Z])/gu, "$<pre>, $<post>")
    .trim();
