import type { proto } from "@whiskeysockets/baileys";

/**
 * Pure trigger logic for the WhatsApp bridge: given an inbound message's text,
 * the bot's identity, and its WhatsApp contextInfo, decide whether the bot
 * should reply and return the cleaned text (or null to stay silent).
 *
 * Kept separate from index.js so it can be unit-tested without booting the
 * Baileys socket or requiring the runtime env vars.
 */

/** The bot's identity fields used for mention matching. */
export interface Bot {
  number?: string;
  lid?: string | null;
}

/** Numeric/user part of a JID, ignoring device suffix and domain (phone or @lid). */
export const userPart = (jid: string | null | undefined): string =>
  (jid || "").split("@")[0].split(":")[0];

/** contextInfo (mentions, quoted message) lives on whichever message sub-type is present. */
export const getContextInfo = (
  message: proto.IMessage | null | undefined
): proto.IContextInfo | null => {
  const m = message ?? {};
  return (
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ??
    null
  );
};

/**
 * Whether this message's contextInfo @-mentions the bot, matching the user part
 * of each mentioned JID against the bot's phone number and LID (modern WhatsApp
 * addresses mentions with `@lid` JIDs). Shared by the trigger check and the
 * per-message routing so both agree on what counts as tagging the bot.
 */
export const mentionsBot = (
  ctx: proto.IContextInfo | null | undefined,
  bot: Bot
): boolean => {
  const ids = new Set([bot.number, bot.lid].filter(Boolean));
  const mentioned = ctx?.mentionedJid ?? [];
  return mentioned.some((j) => ids.has(userPart(j)));
};

/**
 * Does this message target the bot, per the trigger mode? Returns the cleaned
 * text or null.
 *
 * `bot` carries the bot's phone number and LID — modern WhatsApp addresses group
 * mentions with `@lid` JIDs, so we match the user part against both.
 *
 * @param {string} text - The message text to evaluate.
 * @param {{ number?: string, lid?: string|null }} bot - The bot's identity (phone number and LID).
 * @param {{ mentionedJid?: string[] } | null} ctx - WhatsApp contextInfo from the message.
 * @param {{ mode?: string, prefix?: string }} [options] - Trigger mode and optional prefix string.
 */
export const triggerText = (
  text: string,
  bot: Bot,
  ctx: proto.IContextInfo | null | undefined,
  { mode = "mention", prefix = "!bot" }: { mode?: string; prefix?: string } = {}
): string | null => {
  if (mode === "all") {
    return text;
  }

  if (mode === "prefix") {
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
      return text.slice(prefix.length).trim();
    }
    return null;
  }

  // mention mode (default): reply only on an explicit @-mention. Quoting/replying
  // to one of the bot's own messages deliberately does NOT trigger a reply.
  if (mentionsBot(ctx, bot)) {
    // Strip the @mention token so the agent sees a clean message.
    return text.replaceAll(/@\d+/gu, "").trim() || text;
  }
  return null;
};

/**
 * If a message is an edit, return the new (edited) inner message + the id of the
 * message that was edited; otherwise null. WhatsApp delivers an edit as a
 * `protocolMessage` (type MESSAGE_EDIT) whose `editedMessage` carries the new
 * content and whose `key.id` points at the original message. The normal text
 * path ignores protocolMessages, so a mention typed in via an edit is otherwise
 * missed. Handles the bare shape and a one-level `editedMessage` wrapper some
 * clients use.
 *
 * @param {object|null|undefined} message - A Baileys message object.
 * @returns {{ edited: object, targetId: string } | null} The edited inner message and the original message id, or null when not an edit.
 */
export const extractEdit = (
  message?: proto.IMessage | null
): { edited: proto.IMessage; targetId: string } | null => {
  const pm =
    message?.protocolMessage ??
    message?.editedMessage?.message?.protocolMessage ??
    null;
  const edited = pm?.editedMessage;
  const targetId = pm?.key?.id;
  if (edited && targetId) {
    return { edited, targetId };
  }
  return null;
};

/** Inputs for the edit-reply decision; all state is passed in so it stays pure. */
export interface EditReplyDecision {
  jid: string;
  fromMe?: boolean | null;
  targetId?: string | null;
  text: string;
  ctx: proto.IContextInfo | null | undefined;
  bot: Bot;
  allowedGroups: Set<string>;
  /** Only `.has()` is read, so any set-like membership check fits (e.g. boundedSet). */
  repliedIds: { has: (value: string) => boolean };
  mode?: string;
  prefix?: string;
}

/**
 * Decide whether an edited message should get a reply, returning the cleaned
 * trigger text or null. Pure (all state passed in) so the gating + dedup is
 * unit-testable, separate from the socket send: group mention-edits only, never
 * the bot's own edits, an allowed group, not already answered (`repliedIds`),
 * and the edited text must @-mention the bot.
 */
export const shouldReplyToEdit = ({
  jid,
  fromMe,
  targetId,
  text,
  ctx,
  bot,
  allowedGroups,
  repliedIds,
  mode,
  prefix,
}: EditReplyDecision): string | null => {
  // Group mention-edits only; DMs already trigger on any message.
  if (!jid.endsWith("@g.us")) {
    return null;
  }
  // Never react to the bot's own edits.
  if (fromMe) {
    return null;
  }
  if (allowedGroups.size > 0 && !allowedGroups.has(jid)) {
    return null;
  }
  // No id, or we already answered this message.
  if (!targetId || repliedIds.has(targetId)) {
    return null;
  }
  return triggerText(text, bot, ctx, { mode, prefix });
};
