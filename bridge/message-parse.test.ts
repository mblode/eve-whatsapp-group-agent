// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WAMessage } from "@whiskeysockets/baileys";

import {
  classifyMessage,
  documentContent,
  extractText,
  mediaPlaceholder,
  messageTs,
  parseVcard,
  renderContactCard,
  resolveSenderInfo,
} from "./message-parse.js";

test("extractText reads conversation, extended text, and captions in order", () => {
  assert.equal(extractText({ conversation: "  hi  " }), "hi");
  assert.equal(extractText({ extendedTextMessage: { text: "yo" } }), "yo");
  assert.equal(extractText({ imageMessage: { caption: "look" } }), "look");
  assert.equal(extractText(null), "");
  assert.equal(extractText({}), "");
});

test("extractText reads a document caption, plain and captioned-wrapper", () => {
  assert.equal(
    extractText({ documentMessage: { caption: "the PRD" } }),
    "the PRD"
  );
  assert.equal(
    extractText({
      documentWithCaptionMessage: {
        message: { documentMessage: { caption: "wrapped" } },
      },
    }),
    "wrapped"
  );
});

test("documentContent unwraps documentWithCaptionMessage", () => {
  assert.equal(
    documentContent({ documentMessage: { fileName: "a.md" } })?.fileName,
    "a.md"
  );
  assert.equal(
    documentContent({
      documentWithCaptionMessage: {
        message: { documentMessage: { fileName: "b.pdf" } },
      },
    })?.fileName,
    "b.pdf"
  );
  assert.equal(documentContent({ conversation: "x" }), null);
});

test("messageTs coerces number, string and Long shapes, falling back to now", () => {
  assert.equal(messageTs({ messageTimestamp: 1700 } as WAMessage), 1700);
  assert.equal(
    messageTs({ messageTimestamp: "1700" } as unknown as WAMessage),
    1700
  );
  assert.equal(
    messageTs({
      messageTimestamp: { toNumber: () => 1700 },
    } as unknown as WAMessage),
    1700
  );
  assert.equal(
    messageTs({ messageTimestamp: { low: 1700 } } as unknown as WAMessage),
    1700
  );
  const fallback = messageTs({} as WAMessage);
  // falls back to ~now, never NaN
  assert.ok(fallback > 0);
});

test("mediaPlaceholder labels each known media type and returns null otherwise", () => {
  assert.equal(mediaPlaceholder({ imageMessage: {} }), "[image]");
  assert.equal(mediaPlaceholder({ videoMessage: {} }), "[video]");
  assert.equal(mediaPlaceholder({ audioMessage: {} }), "[audio]");
  assert.equal(mediaPlaceholder({ documentMessage: {} }), "[document]");
  assert.equal(
    mediaPlaceholder({ documentMessage: { fileName: "PRD.md" } }),
    "[document: PRD.md]"
  );
  assert.equal(
    mediaPlaceholder({
      documentWithCaptionMessage: {
        message: { documentMessage: { fileName: "deck.pptx" } },
      },
    }),
    "[document: deck.pptx]"
  );
  assert.equal(mediaPlaceholder({ stickerMessage: {} }), "[sticker]");
  assert.equal(mediaPlaceholder({ conversation: "text" }), null);
});

test("parseVcard pulls name, phone, email and LinkedIn, tolerating params", () => {
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Doe;Jane;;;",
    "FN:Jane Doe",
    "ORG:Acme Pty Ltd;",
    "TEL;type=CELL;type=VOICE;waid=61400000000:+61 400 000 000",
    "EMAIL;type=INTERNET:jane@example.com",
    "item1.URL:https://www.linkedin.com/in/janedoe",
    "END:VCARD",
  ].join("\n");
  const c = parseVcard(vcard);
  assert.equal(c.name, "Jane Doe");
  assert.deepEqual(c.phones, ["+61 400 000 000"]);
  assert.deepEqual(c.emails, ["jane@example.com"]);
  assert.equal(c.linkedIn, "https://www.linkedin.com/in/janedoe");
  assert.equal(c.org, "Acme Pty Ltd");
});

test("parseVcard falls back to the structured N name when FN is absent", () => {
  const c = parseVcard(
    ["BEGIN:VCARD", "N:Doe;Jane;;;", "TEL:+61400000000", "END:VCARD"].join("\n")
  );
  assert.equal(c.name, "Jane Doe");
});

test("renderContactCard renders a single contactMessage into readable text", () => {
  const block = renderContactCard({
    contactMessage: {
      displayName: "Jane Doe",
      vcard: [
        "BEGIN:VCARD",
        "FN:Jane Doe",
        "TEL;waid=61400000000:+61 400 000 000",
        "EMAIL:jane@example.com",
        "END:VCARD",
      ].join("\n"),
    },
  });
  assert.match(block, /^Shared contact card:/u);
  assert.match(block, /Name: Jane Doe/u);
  assert.match(block, /Phone: \+61 400 000 000/u);
  assert.match(block, /Email: jane@example\.com/u);
});

test("renderContactCard renders each contact in a contactsArrayMessage", () => {
  const block = renderContactCard({
    contactsArrayMessage: {
      contacts: [
        { vcard: "BEGIN:VCARD\nFN:Jane Doe\nTEL:+61400000000\nEND:VCARD" },
        { vcard: "BEGIN:VCARD\nFN:John Roe\nTEL:+61400000001\nEND:VCARD" },
      ],
    },
  });
  assert.match(block, /Name: Jane Doe/u);
  assert.match(block, /Name: John Roe/u);
});

test("renderContactCard returns empty string for a non-contact message", () => {
  assert.equal(renderContactCard({ conversation: "hi" }), "");
  assert.equal(renderContactCard(null), "");
});

test("classifyMessage tags a group message", () => {
  const msg = {
    key: { fromMe: false, remoteJid: "123@g.us" },
  } as WAMessage;
  assert.deepEqual(classifyMessage(msg, new Set(), new Set()), {
    isDM: false,
    isGroup: true,
    isSelfChat: false,
    jid: "123@g.us",
  });
});

test("classifyMessage tags a 1:1 DM and fires the inbound log callback", () => {
  let logged: unknown = null;
  const msg = {
    key: { fromMe: false, remoteJid: "5511@s.whatsapp.net" },
    message: { conversation: "hi" },
  } as WAMessage;
  const result = classifyMessage(msg, new Set(), new Set(), (info) => {
    logged = info;
  });
  assert.deepEqual(result, {
    isDM: true,
    isGroup: false,
    isSelfChat: false,
    jid: "5511@s.whatsapp.net",
  });
  assert.deepEqual(logged, {
    isDM: true,
    jid: "5511@s.whatsapp.net",
    msgType: "conversation",
    senderPn: null,
  });
});

test("classifyMessage keeps a fromMe message in the account's own self-chat", () => {
  let logged: unknown = null;
  const msg = {
    key: { fromMe: true, remoteJid: "61494718128@s.whatsapp.net" },
    message: { conversation: "summarise this" },
  } as WAMessage;
  const result = classifyMessage(
    msg,
    new Set(),
    new Set(["61494718128"]),
    (info) => {
      logged = info;
    }
  );
  assert.deepEqual(result, {
    isDM: true,
    isGroup: false,
    isSelfChat: true,
    jid: "61494718128@s.whatsapp.net",
  });
  // Self-chat still fires the inbound diagnostic log so its routing is visible.
  assert.deepEqual(logged, {
    isDM: true,
    jid: "61494718128@s.whatsapp.net",
    msgType: "conversation",
    senderPn: null,
  });
});

test("classifyMessage matches the self-chat on the bot's @lid identity too", () => {
  const msg = {
    key: { fromMe: true, remoteJid: "998877@lid" },
  } as WAMessage;
  assert.deepEqual(classifyMessage(msg, new Set(), new Set(["998877"])), {
    isDM: true,
    isGroup: false,
    isSelfChat: true,
    jid: "998877@lid",
  });
});

test("classifyMessage drops outbound, system, and disallowed-group messages", () => {
  // fromMe in a group is still dropped, even with selfIds set.
  assert.equal(
    classifyMessage(
      { key: { fromMe: true, remoteJid: "123@g.us" } } as WAMessage,
      new Set(),
      new Set(["61494718128"])
    ),
    null
  );
  // fromMe DM to someone who ISN'T us is dropped (only the self-chat survives).
  assert.equal(
    classifyMessage(
      { key: { fromMe: true, remoteJid: "5511@s.whatsapp.net" } } as WAMessage,
      new Set(),
      new Set(["61494718128"])
    ),
    null
  );
  assert.equal(
    classifyMessage(
      { key: { fromMe: false, remoteJid: "x@broadcast" } } as WAMessage,
      new Set(),
      new Set()
    ),
    null
  );
  assert.equal(
    classifyMessage(
      { key: { fromMe: false, remoteJid: "123@g.us" } } as WAMessage,
      new Set(["other@g.us"]),
      new Set()
    ),
    null
  );
});

test("resolveSenderInfo prefers the phone identity and group participant", () => {
  const msg = {
    key: {
      participant: "99:1@lid",
      participantAlt: "5511@s.whatsapp.net",
      remoteJid: "123@g.us",
    },
    messageTimestamp: 1700,
    pushName: "Alice",
  } as WAMessage;
  assert.deepEqual(resolveSenderInfo(msg, "123@g.us", false), {
    sender: "99",
    senderName: "Alice",
    senderPhone: "5511",
    surface: "group",
    ts: 1700,
  });
});

test("resolveSenderInfo treats the chat jid as the sender in a DM", () => {
  const msg = {
    key: { remoteJid: "5511@s.whatsapp.net" },
    messageTimestamp: 1700,
  } as WAMessage;
  const info = resolveSenderInfo(msg, "5511@s.whatsapp.net", true);
  assert.equal(info.sender, "5511");
  assert.equal(info.senderPhone, null);
  assert.equal(info.surface, "dm");
});
