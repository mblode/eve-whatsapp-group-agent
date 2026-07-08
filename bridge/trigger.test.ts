// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  userPart,
  getContextInfo,
  mentionsBot,
  triggerText,
  extractEdit,
  shouldReplyToEdit,
} from "./trigger.js";

const bot = { lid: "98765", number: "15551234567" };

test("userPart strips the device suffix and domain from a phone JID", () => {
  assert.equal(userPart("15551234567:12@s.whatsapp.net"), "15551234567");
});

test("userPart strips the domain from an @lid JID", () => {
  assert.equal(userPart("98765@lid"), "98765");
});

test("userPart returns an empty string for a null/empty JID", () => {
  assert.equal(userPart(null), "");
  assert.equal(userPart(""), "");
});

test("getContextInfo reads contextInfo off an extended text message", () => {
  const ctx = { mentionedJid: ["15551234567@s.whatsapp.net"] };
  assert.equal(
    getContextInfo({ extendedTextMessage: { contextInfo: ctx } }),
    ctx
  );
});

test("getContextInfo reads contextInfo off an image message", () => {
  const ctx = { mentionedJid: [] };
  assert.equal(getContextInfo({ imageMessage: { contextInfo: ctx } }), ctx);
});

test("getContextInfo reads contextInfo off a document, plain and wrapped", () => {
  const ctx = { mentionedJid: ["98765@lid"] };
  assert.equal(getContextInfo({ documentMessage: { contextInfo: ctx } }), ctx);
  assert.equal(
    getContextInfo({
      documentWithCaptionMessage: {
        message: { documentMessage: { contextInfo: ctx } },
      },
    }),
    ctx
  );
});

test("getContextInfo returns null when no recognised sub-type carries contextInfo", () => {
  assert.equal(getContextInfo({ conversation: "hi" }), null);
  assert.equal(getContextInfo(null), null);
});

test("mentionsBot matches the bot by number and by @lid, false otherwise", () => {
  assert.equal(
    mentionsBot({ mentionedJid: ["15551234567@s.whatsapp.net"] }, bot),
    true
  );
  assert.equal(mentionsBot({ mentionedJid: ["98765@lid"] }, bot), true);
  assert.equal(mentionsBot({ mentionedJid: ["61400000000@lid"] }, bot), false);
  assert.equal(mentionsBot(null, bot), false);
});

test("triggerText (mention) triggers and strips the @mention token when mentioned by number", () => {
  const ctx = { mentionedJid: ["15551234567@s.whatsapp.net"] };
  assert.equal(
    triggerText("@15551234567 what's the recap", bot, ctx),
    "what's the recap"
  );
});

test("triggerText (mention) triggers when the bot is mentioned by its @lid", () => {
  const ctx = { mentionedJid: ["98765@lid"] };
  assert.equal(triggerText("@98765 hey", bot, ctx), "hey");
});

test("triggerText (mention) falls back to raw text when stripping the mention leaves nothing", () => {
  const ctx = { mentionedJid: ["98765@lid"] };
  assert.equal(triggerText("@98765", bot, ctx), "@98765");
});

test("triggerText (mention) does NOT trigger when only quoting/replying to the bot's own message", () => {
  // ctx.participant is the bot, but there is no @-mention: stay silent.
  const ctx = { mentionedJid: [], participant: "15551234567@s.whatsapp.net" };
  assert.equal(triggerText("grouse of you to say so", bot, ctx), null);
});

test("triggerText (mention) does not trigger on an unrelated message", () => {
  const ctx = { mentionedJid: ["99999999999@s.whatsapp.net"] };
  assert.equal(triggerText("just chatting", bot, ctx), null);
});

test("triggerText (mention) does not trigger when there is no context info at all", () => {
  assert.equal(triggerText("hello", bot, null), null);
});

test("triggerText (prefix) triggers and strips the prefix, case-insensitively", () => {
  const opts = { mode: "prefix", prefix: "!bot" };
  assert.equal(
    triggerText("!BOT recap please", bot, null, opts),
    "recap please"
  );
});

test("triggerText (prefix) does not trigger without the prefix", () => {
  const opts = { mode: "prefix", prefix: "!bot" };
  assert.equal(triggerText("recap please", bot, null, opts), null);
});

test("triggerText (all) returns the text unchanged for every message", () => {
  assert.equal(triggerText("anything", bot, null, { mode: "all" }), "anything");
});

test("extractEdit returns the edited content + original id for a protocolMessage edit", () => {
  const edited = { extendedTextMessage: { text: "@98765 fixed" } };
  const message = {
    protocolMessage: {
      editedMessage: edited,
      key: { id: "ORIG123" },
      type: 14,
    },
  };
  assert.deepEqual(extractEdit(message), { edited, targetId: "ORIG123" });
});

test("extractEdit handles a one-level editedMessage wrapper", () => {
  const edited = { conversation: "@98765 fixed" };
  const message = {
    editedMessage: {
      message: {
        protocolMessage: { editedMessage: edited, key: { id: "X9" } },
      },
    },
  };
  assert.deepEqual(extractEdit(message), { edited, targetId: "X9" });
});

test("extractEdit returns null for a normal (non-edit) message", () => {
  assert.equal(extractEdit({ conversation: "just a message" }), null);
  assert.equal(extractEdit({ extendedTextMessage: { text: "hi" } }), null);
});

test("extractEdit returns null for a protocolMessage without editedMessage (e.g. a revoke)", () => {
  assert.equal(
    extractEdit({ protocolMessage: { key: { id: "Y" }, type: 0 } }),
    null
  );
});

test("extractEdit returns null for null/empty input", () => {
  assert.equal(extractEdit(null), null);
  assert.equal(extractEdit(), null);
  assert.equal(extractEdit({}), null);
});

test("extractEdit returns null when the edited content has no original key id", () => {
  assert.equal(
    extractEdit({ protocolMessage: { editedMessage: { conversation: "x" } } }),
    null
  );
});

test("an edited-in @mention, once extracted, triggers like a normal mention", () => {
  // End-to-end of the bug: Adam edits a message to add the agent. extractEdit pulls
  // the new content; triggerText then fires on the mention.
  const edited = {
    extendedTextMessage: {
      contextInfo: { mentionedJid: ["98765@lid"] },
      text: "Don't worry about my talk, @98765, work on your keynote",
    },
  };
  const message = {
    protocolMessage: { editedMessage: edited, key: { id: "EDIT1" } },
  };
  const e = extractEdit(message);
  assert.equal(e?.targetId, "EDIT1");
  const ctx = getContextInfo(e?.edited);
  const editedText = e?.edited.extendedTextMessage?.text ?? "";
  assert.equal(
    triggerText(editedText, bot, ctx),
    "Don't worry about my talk, , work on your keynote"
  );
});

// shouldReplyToEdit: the gating + dedup that guards against double-replies and
// replying in the wrong place. A group edit that @-mentions the bot is the base.
const editBase = () => ({
  allowedGroups: new Set<string>(),
  bot,
  ctx: { mentionedJid: ["98765@lid"] },
  fromMe: false,
  jid: "123@g.us",
  repliedIds: new Set<string>(),
  targetId: "T1",
  text: "@98765 fix it",
});

test("shouldReplyToEdit replies when a group edit @-mentions the bot", () => {
  assert.equal(shouldReplyToEdit(editBase()), "fix it");
});

test("shouldReplyToEdit returns null for a DM (non-group jid)", () => {
  assert.equal(
    shouldReplyToEdit({ ...editBase(), jid: "98765@s.whatsapp.net" }),
    null
  );
});

test("shouldReplyToEdit ignores the bot's own edits", () => {
  assert.equal(shouldReplyToEdit({ ...editBase(), fromMe: true }), null);
});

test("shouldReplyToEdit respects the group allowlist", () => {
  assert.equal(
    shouldReplyToEdit({
      ...editBase(),
      allowedGroups: new Set(["other@g.us"]),
    }),
    null
  );
  assert.equal(
    shouldReplyToEdit({ ...editBase(), allowedGroups: new Set(["123@g.us"]) }),
    "fix it"
  );
});

test("shouldReplyToEdit dedups against repliedIds (no double-reply)", () => {
  assert.equal(
    shouldReplyToEdit({ ...editBase(), repliedIds: new Set(["T1"]) }),
    null
  );
});

test("shouldReplyToEdit returns null when there is no target id", () => {
  assert.equal(shouldReplyToEdit({ ...editBase(), targetId: undefined }), null);
});

test("shouldReplyToEdit returns null when the edit doesn't @-mention the bot", () => {
  assert.equal(
    shouldReplyToEdit({
      ...editBase(),
      ctx: { mentionedJid: [] },
      text: "no mention here",
    }),
    null
  );
});
