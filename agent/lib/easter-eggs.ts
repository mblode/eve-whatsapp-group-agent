/**
 * Optional command-triggered easter eggs — one-shot persona bits or inside-joke
 * commands the agent can play when a message is essentially just the trigger.
 *
 * Disabled by default in this template (empty string, skipped in
 * `instructions.ts`). To add your own, set `EASTER_EGGS` to a prompt section
 * describing the triggers and how to play them, for example:
 *
 *   export const EASTER_EGGS = `## Easter eggs (command-triggered, for fun)
 *   Fire one only when a message is essentially just the trigger.
 *   - \`/roll\`: reply with a mock dramatic dice roll and a one-line verdict.`;
 *
 * Keep any copy within the WhatsApp constraints `cleanReply` enforces (single
 * `*` bold, never `**`; no em/en dashes; no headings in the reply itself).
 */
export const EASTER_EGGS = "";
