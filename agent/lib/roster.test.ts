import { describe, expect, it } from "vitest";

import { memberProfiles, PEOPLE } from "#data/people.js";

import { findInRoster, matchPerson, ROSTER } from "./roster.js";

const rosterNames = (): string[] => ROSTER.map((e) => e.name);

describe("roster entries", () => {
  it("has unique names", () => {
    const names = rosterNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("derives only members from the profile data (non-members excluded)", () => {
    // The roster is the machine-readable mirror of people.ts members; it must
    // stay consistent with the source so drift detection can't go stale.
    expect(rosterNames()).toStrictEqual(memberProfiles().map((p) => p.name));

    const nonMembers = PEOPLE.filter((p) => p.member === false).map(
      (p) => p.name
    );
    for (const name of nonMembers) {
      expect(rosterNames()).not.toContain(name);
    }
  });

  it("carries role/org/tags through from profiles", () => {
    const example = ROSTER.find((e) => e.name === "Example Member");
    expect(example?.tags).toContain("example");
    expect(example?.role).toBe("Founder");
  });
});

describe(findInRoster, () => {
  it("matches a full name", () => {
    expect(findInRoster("Example Member")?.name).toBe("Example Member");
  });

  it("matches a first name", () => {
    expect(findInRoster("example")?.name).toBe("Example Member");
  });

  it("matches an alias", () => {
    expect(findInRoster("Ander")?.name).toBe("Another Member");
  });

  it("is case-insensitive", () => {
    expect(findInRoster("EXAMPLE MEMBER")?.name).toBe("Example Member");
  });

  it("returns undefined for an unknown name", () => {
    expect(findInRoster("Some Randomperson")).toBeUndefined();
  });

  it("matches a 3+ char substring but ignores 2-char noise", () => {
    expect(findInRoster("ano")?.name).toBe("Another Member");
    expect(findInRoster("an")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(findInRoster("")).toBeUndefined();
    expect(findInRoster()).toBeUndefined();
  });
});

describe(matchPerson, () => {
  it("resolves a member by alias against the full profile list", () => {
    expect(matchPerson(PEOPLE, "Ander")?.name).toBe("Another Member");
  });
});
