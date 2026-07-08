import { describe, it, expect } from "vitest";

import type { RosterEntry } from "./roster.js";
import { scanForStaleFacts } from "./stale-scan.js";
import type { StaleScanArgs, RecentMessage } from "./stale-scan.js";

const ROSTER: RosterEntry[] = [
  {
    name: "Dana Example",
    org: "Example Co",
    role: "Community Lead",
    tags: [],
  },
  { name: "Casey Example", org: "Community Org", tags: [] },
];

const msg = (n: string, x: string, t = 1_750_000_000): RecentMessage => ({
  n,
  s: n.toLowerCase().replaceAll(/\s+/gu, ""),
  t,
  x,
});

const base = (overrides: Partial<StaleScanArgs> = {}): StaleScanArgs => ({
  // non-empty = "seen"
  archiveSearch: () => [{ date: "z", from: "x", text: "y" }],
  membersMemory: "",
  recent: [],
  recurringTopicsMemory: "",
  roster: ROSTER,
  ...overrides,
});

describe(scanForStaleFacts, () => {
  it("flags a possible role/org change from a change cue", () => {
    const findings = scanForStaleFacts(
      base({
        recent: [msg("Someone", "heard Dana is now at a different org")],
      })
    );
    const f = findings.find((x) => x.kind === "role_changed");
    expect(f?.subject).toBe("Dana Example");
    expect(f?.current).toContain("Example Co");
    expect(f?.evidence.length).toBeGreaterThan(0);
  });

  it("flags an active sender who isn't on the roster", () => {
    const findings = scanForStaleFacts(
      base({
        recent: [
          msg("Brand Newperson", "hey all, just joined the group"),
          msg("Brand Newperson", "loving the chat"),
        ],
      })
    );
    const f = findings.find((x) => x.kind === "unknown_active");
    expect(f?.subject).toBe("Brand Newperson");
    // 2 messages
    expect(f?.confidence).toBe("med");
  });

  it("does not flag a known member as unknown", () => {
    // "Example Member" is in the shipped roster (bridge/members.ts), which
    // isKnownMember checks — so an active known member is never flagged.
    const findings = scanForStaleFacts(
      base({ recent: [msg("Example Member", "hello")] })
    );
    expect(findings.some((x) => x.kind === "unknown_active")).toBeFalsy();
  });

  it("flags a roster member with no recent or archive presence as possibly left", () => {
    const findings = scanForStaleFacts(
      base({
        archiveSearch: (q) =>
          q.includes("Dana") ? [] : [{ date: "z", from: "x", text: "y" }],
        recent: [msg("Casey Example", "still here")],
      })
    );
    const f = findings.find((x) => x.kind === "possibly_left");
    expect(f?.subject).toBe("Dana Example");
  });

  it("flags a frequent new term missing from recurring topics", () => {
    const recent = Array.from({ length: 6 }, (_, i) =>
      msg("Someone", `the new venuebooking thread number ${i}`)
    );
    const findings = scanForStaleFacts(
      base({ recent, recurringTopicsMemory: "venue options" })
    );
    const f = findings.find(
      (x) => x.kind === "new_recurring_topic" && x.subject === "venuebooking"
    );
    expect(f).toBeDefined();
  });

  it("does not flag a term already in recurring topics", () => {
    const recent = Array.from({ length: 6 }, () =>
      msg("Someone", "widgets widgets talk")
    );
    const findings = scanForStaleFacts(
      base({ recent, recurringTopicsMemory: "widgets everywhere" })
    );
    expect(
      findings.some(
        (x) => x.kind === "new_recurring_topic" && x.subject === "widgets"
      )
    ).toBeFalsy();
  });
});
