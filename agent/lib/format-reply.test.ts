import { describe, it, expect } from "vitest";

import { cleanReply } from "./format-reply.js";

describe("cleanReply — Markdown to WhatsApp", () => {
  it("collapses Markdown **bold** to WhatsApp *bold*", () => {
    expect(cleanReply("**Update:** meeting notes dropped")).toBe(
      "*Update:* meeting notes dropped"
    );
  });

  it("leaves already-correct WhatsApp *bold* untouched", () => {
    expect(cleanReply("*Notice:* room booked")).toBe("*Notice:* room booked");
  });

  it("handles several bold runs on one line", () => {
    expect(cleanReply("**Google:** stuff and **Microsoft:** more")).toBe(
      "*Google:* stuff and *Microsoft:* more"
    );
  });

  it("converts __bold__ to *bold*", () => {
    expect(cleanReply("__big news__ today")).toBe("*big news* today");
  });

  it("turns ATX headings into a bold line with no #", () => {
    expect(cleanReply("## Project notes\nAgenda moved")).toBe(
      "*Project notes*\nAgenda moved"
    );
  });

  it("collapses triple emphasis (***x***) to single", () => {
    expect(cleanReply("***huge***")).toBe("*huge*");
  });

  it("leaves triple-backtick blocks (ASCII art) alone", () => {
    const art = "```\n  .--(the agent)--.\n```";
    expect(cleanReply(art)).toBe(art);
  });

  it("does not touch single-underscore italics or list dashes", () => {
    expect(cleanReply("- _keen_ on this")).toBe("- _keen_ on this");
  });
});

describe("cleanReply — dash guard", () => {
  it("turns a spaced em dash into a comma", () => {
    expect(cleanReply("nice work — really clean")).toBe(
      "nice work, really clean"
    );
  });

  it("turns a word-joined dash into a comma", () => {
    expect(cleanReply("notes—plans")).toBe("notes, plans");
  });

  it("keeps numeric ranges", () => {
    expect(cleanReply("takes 4–5 hours")).toBe("takes 4–5 hours");
  });

  it("trims surrounding whitespace", () => {
    expect(cleanReply("  hey  ")).toBe("hey");
  });
});
