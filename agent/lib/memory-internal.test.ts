import { describe, it, expect } from "vitest";

import {
  buildGroupMemoryPrompt,
  canSaveMemory,
  isAdmin,
  parseAdminJids,
} from "./memory-internal.js";

describe(parseAdminJids, () => {
  it("returns an empty set for undefined", () => {
    expect(parseAdminJids().size).toBe(0);
  });

  it("returns an empty set for an empty string", () => {
    expect(parseAdminJids("").size).toBe(0);
  });

  it("splits on commas and trims", () => {
    const set = parseAdminJids(" a@s.whatsapp.net , b@s.whatsapp.net ");
    expect(set).toStrictEqual(
      new Set(["a@s.whatsapp.net", "b@s.whatsapp.net"])
    );
  });

  it("drops empty entries from trailing/double commas", () => {
    const set = parseAdminJids("a@s.whatsapp.net,,b@s.whatsapp.net,");
    expect(set).toStrictEqual(
      new Set(["a@s.whatsapp.net", "b@s.whatsapp.net"])
    );
  });
});

describe(isAdmin, () => {
  const admins = parseAdminJids(
    "61400000000@s.whatsapp.net,61411111111@s.whatsapp.net"
  );

  it("matches an exact JID", () => {
    expect(isAdmin("61400000000@s.whatsapp.net", admins)).toBeTruthy();
  });

  it("matches on the user part before @", () => {
    // Sender JID may carry a device suffix or differ in domain; the user part matches.
    expect(isAdmin("61400000000:12@s.whatsapp.net", admins)).toBeTruthy();
    expect(isAdmin("61400000000@lid", admins)).toBeTruthy();
  });

  it("rejects a non-admin sender", () => {
    expect(isAdmin("61499999999@s.whatsapp.net", admins)).toBeFalsy();
  });

  it("returns false when there is no sender", () => {
    expect(isAdmin(undefined, admins)).toBeFalsy();
  });

  it("returns false when there are no admins", () => {
    expect(isAdmin("61400000000@s.whatsapp.net", new Set())).toBeFalsy();
  });
});

describe(buildGroupMemoryPrompt, () => {
  it("returns an empty string for empty memory", () => {
    expect(buildGroupMemoryPrompt({})).toBe("");
  });

  it("returns an empty string when all categories are blank", () => {
    expect(buildGroupMemoryPrompt({ lore: "", members: "   " })).toBe("");
  });

  it("renders a heading and prose per non-empty category", () => {
    const out = buildGroupMemoryPrompt({
      group_facts: "Cap is ~100 members.",
      recurring_topics: "Model launches.",
    });
    expect(out).toContain("# Group memory (learned over time)");
    expect(out).toContain("## Group Facts");
    expect(out).toContain("Cap is ~100 members.");
    expect(out).toContain("## Recurring Topics");
    expect(out).toContain("Model launches.");
  });

  it("skips blank categories but keeps populated ones", () => {
    const out = buildGroupMemoryPrompt({
      decisions: "Meet quarterly.",
      lore: "",
    });
    expect(out).not.toContain("## Lore");
    expect(out).toContain("## Decisions");
    expect(out).toContain("Meet quarterly.");
  });
});

describe(canSaveMemory, () => {
  const admins = parseAdminJids("61400000000@s.whatsapp.net");

  it("denies when there is no group context", () => {
    expect(
      canSaveMemory(null, "61400000000@s.whatsapp.net", admins)
    ).toStrictEqual({
      ok: false,
      reason: "no group context",
    });
  });

  it("denies a non-admin sender", () => {
    expect(
      canSaveMemory("123@g.us", "61499999999@s.whatsapp.net", admins)
    ).toStrictEqual({
      ok: false,
      reason: "only group admins can update memory",
    });
  });

  it("denies when the sender is unknown", () => {
    expect(canSaveMemory("123@g.us", undefined, admins).ok).toBeFalsy();
  });

  it("allows an admin in a group and returns the group jid", () => {
    // Sender carries a device suffix; isAdmin matches on the user part.
    expect(
      canSaveMemory("123@g.us", "61400000000:5@s.whatsapp.net", admins)
    ).toStrictEqual({
      groupJid: "123@g.us",
      ok: true,
    });
  });

  it("allows when only the phone matches (principal is an opaque @lid)", () => {
    // Modern WhatsApp: principal is a @lid that doesn't match; the phone does.
    expect(
      canSaveMemory(
        "123@g.us",
        "987654321@lid",
        admins,
        "61400000000@s.whatsapp.net"
      )
    ).toStrictEqual({
      groupJid: "123@g.us",
      ok: true,
    });
  });

  it("denies when neither the JID nor the phone matches an admin", () => {
    expect(
      canSaveMemory(
        "123@g.us",
        "987654321@lid",
        admins,
        "61499999999@s.whatsapp.net"
      )
    ).toStrictEqual({
      ok: false,
      reason: "only group admins can update memory",
    });
  });

  it("denies a save from a DM even for a recognised admin", () => {
    // DM JID is not a group (@g.us); group memory there would never be read.
    expect(
      canSaveMemory(
        "61400000000@s.whatsapp.net",
        "987654321@lid",
        admins,
        "61400000000@s.whatsapp.net"
      )
    ).toStrictEqual({
      ok: false,
      reason: "group memory can only be updated from the group, not a DM",
    });
  });
});
