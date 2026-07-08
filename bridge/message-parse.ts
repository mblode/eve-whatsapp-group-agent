import type { WAMessage, WAMessageKey, proto } from "@whiskeysockets/baileys";

import { userPart } from "./trigger.js";

/**
 * Pure message-parsing helpers for the WhatsApp bridge: pull text/media/timestamp
 * out of the many shapes a WAMessage can take, classify a message's JID, and
 * resolve sender identity fields. No socket, no IO — these take a message (and
 * any needed config) and return data, so they're unit-testable without booting
 * Baileys.
 */

/**
 * The sender's phone-number JID from a message key, if the key carries one.
 * Modern WhatsApp uses opaque @lid addressing; the phone-number JID then
 * arrives on the alternate fields (remoteJidAlt in DMs, participantAlt in
 * groups). Either side can be the @lid depending on the chat's addressing
 * mode, so pick whichever alt is actually a phone JID.
 */
export const phoneNumberJid = (
  key: WAMessageKey | null | undefined
): string | null =>
  [key?.remoteJidAlt, key?.participantAlt].find((jid) =>
    jid?.endsWith("@s.whatsapp.net")
  ) ?? null;

/**
 * The document on a message, unwrapping WhatsApp's `documentWithCaptionMessage`
 * envelope (used for captioned docs). Returns null when there's no document.
 */
export const documentContent = (
  message: proto.IMessage | null | undefined
): proto.Message.IDocumentMessage | null => {
  const m = message ?? {};
  return (
    m.documentMessage ??
    m.documentWithCaptionMessage?.message?.documentMessage ??
    null
  );
};

/**
 * The audio on a message — a normal `audioMessage` or a push-to-talk voice note.
 * `pttMessage` is a real WhatsApp field absent from this Baileys version's proto
 * types, so it's read via a narrow cast; this is the single place that owns that
 * cast. Returns null when there's no audio.
 */
export const audioContent = (
  message: proto.IMessage | null | undefined
): proto.Message.IAudioMessage | null => {
  const m = message ?? {};
  return (
    m.audioMessage ??
    (m as { pttMessage?: proto.Message.IAudioMessage }).pttMessage ??
    null
  );
};

/** Pull plain text out of the many shapes a WhatsApp message can take. */
export const extractText = (
  message: proto.IMessage | null | undefined
): string => {
  if (!message) {
    return "";
  }
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    documentContent(message)?.caption ??
    ""
  ).trim();
};

/** The fields we pull out of a shared contact's vCard. */
export interface ParsedContact {
  name: string;
  phones: string[];
  emails: string[];
  linkedIn?: string;
  website?: string;
  org?: string;
}

/** Unescape the small set of vCard value escapes (RFC 6350 §3.4). */
const unescapeVcard = (value: string): string =>
  value
    .replaceAll(/\\n/giu, " ")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\")
    .trim();

/**
 * Parse a vCard string into the handful of fields worth forwarding. Tolerant of
 * WhatsApp's output: property params (`TEL;type=CELL;waid=...:+61...`), a
 * `group.` prefix (`item1.TEL`), folded continuation lines, and CRLF or LF.
 */
export const parseVcard = (vcard: string): ParsedContact => {
  const contact: ParsedContact = { emails: [], name: "", phones: [] };
  if (!vcard) {
    return contact;
  }
  // Unfold: a leading space or tab continues the previous line (RFC 6350 §3.2).
  const unfolded = vcard.replaceAll(/\r?\n[ \t]/gu, "");
  let fn = "";
  let structuredName = "";
  for (const rawLine of unfolded.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const rawKey = line.slice(0, colon);
    const value = unescapeVcard(line.slice(colon + 1));
    if (!value) {
      continue;
    }
    // Drop any `group.` prefix and `;params`, leaving the bare property name.
    const prop = rawKey
      .replace(/^[^.]+\./u, "")
      .split(";")[0]
      .toUpperCase();
    if (prop === "FN") {
      fn = value;
    } else if (prop === "N") {
      // N is `Family;Given;Additional;Prefix;Suffix` — flip to "Given Family".
      const [family, given] = value.split(";");
      structuredName = [given, family].filter(Boolean).join(" ").trim();
    } else if (prop === "TEL") {
      contact.phones.push(value);
    } else if (prop === "EMAIL") {
      contact.emails.push(value);
    } else if (prop === "ORG") {
      contact.org = value.split(";").filter(Boolean).join(", ");
    } else if (prop === "URL") {
      if (/linkedin\.com/iu.test(value)) {
        contact.linkedIn ??= value;
      } else {
        contact.website ??= value;
      }
    }
  }
  contact.name = fn || structuredName;
  return contact;
};

/** Render one parsed contact as a readable, WhatsApp-plain block. */
const renderContact = (
  contact: ParsedContact,
  displayName?: string
): string => {
  const name = contact.name || displayName?.trim() || "";
  const lines = ["Shared contact card:"];
  if (name) {
    lines.push(`Name: ${name}`);
  }
  if (contact.phones.length) {
    lines.push(`Phone: ${contact.phones.join(", ")}`);
  }
  if (contact.emails.length) {
    lines.push(`Email: ${contact.emails.join(", ")}`);
  }
  if (contact.linkedIn) {
    lines.push(`LinkedIn: ${contact.linkedIn}`);
  }
  if (contact.website) {
    lines.push(`Website: ${contact.website}`);
  }
  if (contact.org) {
    lines.push(`Company: ${contact.org}`);
  }
  return lines.join("\n");
};

/**
 * Render a shared contact card (single `contactMessage` or a
 * `contactsArrayMessage`) into readable text so it reaches the agent, which
 * would otherwise drop it (a contact card has no caption, so extractText and
 * mediaPlaceholder both come up empty). Returns "" when there's no contact.
 */
export const renderContactCard = (
  message: proto.IMessage | null | undefined
): string => {
  const m = message ?? {};
  const single = m.contactMessage;
  if (single?.vcard) {
    return renderContact(
      parseVcard(single.vcard),
      single.displayName ?? undefined
    );
  }
  const many = m.contactsArrayMessage?.contacts;
  if (many?.length) {
    const blocks = many
      .filter((c): c is proto.Message.IContactMessage => Boolean(c?.vcard))
      .map((c) =>
        renderContact(parseVcard(c.vcard as string), c.displayName ?? undefined)
      );
    return blocks.join("\n\n");
  }
  return "";
};

/**
 * The text to forward for a message: its caption / body, or — for a shared
 * contact card, which has no caption — the rendered vCard block. Keeps the
 * contact fallback out of the message loop so a shared contact reaches the
 * agent without dropping through the empty-text gate.
 */
export const messageText = (
  message: proto.IMessage | null | undefined
): string => extractText(message) || renderContactCard(message);

/** WhatsApp message timestamps arrive as number | string | Long. */
type TimestampLike =
  | number
  | string
  | { toNumber?: () => number; low?: number }
  | null
  | undefined;

/**
 * Server-stamped message time in unix seconds, from WhatsApp's own
 * `messageTimestamp` (number | string | Long), falling back to now. Using the
 * sender's clock instead of bridge-receive time keeps transcript ordering right
 * and lets backfilled history land at its real date.
 */
export const messageTs = (msg: WAMessage | null | undefined): number => {
  const raw = msg?.messageTimestamp as TimestampLike;
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    n = Number(raw);
  } else if (raw && typeof raw.toNumber === "function") {
    n = raw.toNumber();
  } else if (raw && typeof raw.low === "number") {
    n = raw.low;
  } else {
    n = Number.NaN;
  }
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : Math.floor(Date.now() / 1000);
};

/**
 * For a message with no extractable text, return a typed placeholder so the
 * transcript still records that *something* was shared. Returns null when the
 * message carries no recognised media.
 */
export const mediaPlaceholder = (
  message: proto.IMessage | null | undefined
): string | null => {
  const m = message ?? {};
  if (m.imageMessage) {
    return "[image]";
  }
  if (m.videoMessage) {
    return "[video]";
  }
  if (audioContent(m)) {
    return "[audio]";
  }
  const doc = documentContent(m);
  if (doc) {
    const name = doc.fileName?.trim();
    return name ? `[document: ${name}]` : "[document]";
  }
  if (m.stickerMessage) {
    return "[sticker]";
  }
  return null;
};

/** The classification of a message's JID. */
export interface MessageClass {
  isDM: boolean;
  isGroup: boolean;
  /** True for the bridge account's own "message yourself" chat. */
  isSelfChat: boolean;
  jid: string;
}

/**
 * Classify a message key's JID: returns { jid, isGroup, isDM, isSelfChat } or
 * null if the message should be dropped (outbound, disallowed group, system
 * channel).
 *
 * `allowedGroups` empty = all groups allowed. `selfIds` holds the user-parts of
 * the bridge account's own identities (phone number + @lid); a DM whose JID
 * matches is the account's self-chat, the one place a `fromMe` message is kept
 * (every other outbound/self message is still dropped). `onInboundLog`
 * (optional) is invoked for inbound non-group messages so the caller can emit
 * the diagnostic log line; classification itself stays pure.
 */
export const classifyMessage = (
  msg: WAMessage,
  allowedGroups: Set<string>,
  selfIds: Set<string>,
  onInboundLog?: (info: {
    isDM: boolean;
    jid: string;
    msgType: string | undefined;
    senderPn: string | null;
  }) => void
): MessageClass | null => {
  const jid = msg.key.remoteJid ?? "";
  const isGroup = jid.endsWith("@g.us");
  const isDM =
    !isGroup &&
    jid !== "" &&
    !jid.endsWith("@broadcast") &&
    !jid.endsWith("@newsletter");
  // The account's own self-chat: a DM addressed to one of our own identities.
  // It's the sole exception to the fromMe drop below.
  const isSelfChat = isDM && selfIds.has(userPart(jid));
  // Diagnostic: log every inbound non-group message (low volume) so DM
  // routing is visible at info level. Include the self-chat (fromMe) so its
  // routing is visible too.
  if (!isGroup && (!msg.key.fromMe || isSelfChat)) {
    onInboundLog?.({
      isDM,
      jid,
      msgType: Object.keys(msg.message ?? {})[0],
      senderPn: phoneNumberJid(msg.key),
    });
  }
  if (!isGroup && !isDM) {
    return null;
  }
  // Drop outbound / self messages, except our own self-chat (see selfIds).
  if (msg.key.fromMe && !isSelfChat) {
    return null;
  }
  if (isGroup && allowedGroups.size > 0 && !allowedGroups.has(jid)) {
    return null;
  }
  return { isDM, isGroup, isSelfChat, jid };
};

/** Sender identity fields resolved off a message key. */
export interface SenderInfo {
  sender: string;
  senderName: string | undefined;
  senderPhone: string | null;
  surface: "dm" | "group";
  ts: number;
}

/**
 * Resolve sender identity fields from a message key.
 * In a 1:1 DM there's no participant; the sender is the chat JID itself.
 * Modern WhatsApp uses @lid (opaque) for sender; the alt key fields carry the phone.
 */
export const resolveSenderInfo = (
  msg: WAMessage,
  jid: string,
  isDM: boolean
): SenderInfo => {
  const sender = userPart(msg.key.participant ?? jid);
  const rawPhone = userPart(phoneNumberJid(msg.key) ?? "");
  const senderPhone = rawPhone || null;
  const senderName = msg.pushName ?? undefined;
  const ts = messageTs(msg);
  const surface = isDM ? "dm" : "group";
  return { sender, senderName, senderPhone, surface, ts };
};
