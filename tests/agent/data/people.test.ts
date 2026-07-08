import { describe, expect, it } from "vitest";

import { memberProfiles, MEMBER_NAMES, PEOPLE } from "#data/people.js";

const allStrings = (): string[] =>
  PEOPLE.flatMap((p) => [
    p.name,
    p.role ?? "",
    p.org ?? "",
    p.focus ?? "",
    ...(p.aliases ?? []),
    ...(p.inChat ?? []),
    ...(p.links ?? []),
    ...p.tags,
  ]);

describe("people data", () => {
  it("has unique names", () => {
    const names = PEOPLE.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every member has a unique E.164 phone id (the allowlist key)", () => {
    const phones = PEOPLE.map((p) => p.phone);
    for (const phone of phones) {
      expect(phone, `bad phone for a member`).toMatch(/^\+\d{8,15}$/u);
    }
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("every entry has a name and tags array", () => {
    for (const p of PEOPLE) {
      expect(p.name.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(p.tags)).toBeTruthy();
    }
  });

  it("memberProfiles excludes only entries flagged member:false", () => {
    const members = memberProfiles();
    expect(members.every((p) => p.member !== false)).toBeTruthy();
  });

  // Roster prose is public-professional only: nothing private may leak into the
  // free-text fields. This template ships example data, but the guard stays so
  // a real roster can't accidentally commit a phone number or email.
  it("carries no emails or phone numbers in free-text fields", () => {
    const email = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
    const phone = /\+?\d[\d\s()-]{8,}\d/u;
    for (const s of allStrings()) {
      expect(s, `email-like value: ${s}`).not.toMatch(email);
      expect(s, `phone-like value: ${s}`).not.toMatch(phone);
    }
  });

  it("only carries http(s) links when present", () => {
    for (const p of PEOPLE) {
      for (const link of p.links ?? []) {
        expect(link).toMatch(/^https?:\/\//u);
      }
    }
  });
});

describe("MEMBER_NAMES roster", () => {
  it("derives display names from the profiled members, deduped", () => {
    expect(new Set(MEMBER_NAMES).size).toBe(MEMBER_NAMES.length);
    for (const p of memberProfiles()) {
      expect(MEMBER_NAMES, `missing profiled member ${p.name}`).toContain(
        p.name
      );
    }
  });

  it("excludes phone-number-like entries", () => {
    for (const name of MEMBER_NAMES) {
      expect(name, `phone-like roster entry: ${name}`).not.toMatch(
        /\+?\d[\d\s()-]{6,}/u
      );
    }
  });
});
