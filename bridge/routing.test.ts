// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldReplyToChat } from "./routing.js";
import type { Whitelist } from "./whitelist.js";

const whitelistOf = (members: string[]): Whitelist => ({
  isMember: (num) => members.includes(num ?? ""),
  ready: () => true,
});

const base = {
  isSelfChat: false,
  whitelist: whitelistOf(["61400000000"]),
};

test("member DM is allowed", () => {
  const allowed = shouldReplyToChat({
    ...base,
    isDM: true,
    sender: "61400000000@s.whatsapp.net",
    senderPhone: "61400000000",
  });
  assert.equal(allowed, true);
});

test("non-member DM is ignored", () => {
  const allowed = shouldReplyToChat({
    ...base,
    isDM: true,
    sender: "61411111111@s.whatsapp.net",
    senderPhone: "61411111111",
  });
  assert.equal(allowed, false);
});

test("DM whitelist gate falls back to the sender when senderPhone is null", () => {
  const allowed = shouldReplyToChat({
    ...base,
    isDM: true,
    sender: "61400000000@s.whatsapp.net",
    senderPhone: null,
    whitelist: whitelistOf(["61400000000@s.whatsapp.net"]),
  });
  assert.equal(allowed, true);
});

test("the account's own self-chat bypasses the member gate", () => {
  const allowed = shouldReplyToChat({
    ...base,
    isDM: true,
    isSelfChat: true,
    // Sender is the bot's own number, not a listed member.
    sender: "61494718128@s.whatsapp.net",
    senderPhone: "61494718128",
    whitelist: whitelistOf([]),
  });
  assert.equal(allowed, true);
});

test("group messages are allowed", () => {
  const allowed = shouldReplyToChat({
    ...base,
    isDM: false,
    sender: "15551234567@s.whatsapp.net",
    senderPhone: "15551234567",
  });
  assert.equal(allowed, true);
});

test("a not-ready whitelist lets member DMs through (matches legacy gate)", () => {
  const allowed = shouldReplyToChat({
    ...base,
    isDM: true,
    sender: "61411111111@s.whatsapp.net",
    senderPhone: "61411111111",
    whitelist: { isMember: () => false, ready: () => false },
  });
  assert.equal(allowed, true);
});
