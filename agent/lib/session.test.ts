import { describe, it, expect } from "vitest";

import { groupJidFromAuth, senderJidFromAuth } from "./session.js";

// The helpers take eve's SessionAuth; build minimal stand-ins for the test.
type Auth = Parameters<typeof groupJidFromAuth>[0];
const auth = (current: unknown): Auth => ({ current, initiator: null }) as Auth;

describe(groupJidFromAuth, () => {
  it("returns the group JID from attributes", () => {
    expect(
      groupJidFromAuth(
        auth({ attributes: { groupJid: "123@g.us" }, principalId: "x" })
      )
    ).toBe("123@g.us");
  });

  it("returns null when there is no current principal", () => {
    expect(groupJidFromAuth(auth(null))).toBeNull();
  });

  it("returns null when the groupJid attribute is absent or empty", () => {
    expect(
      groupJidFromAuth(auth({ attributes: {}, principalId: "x" }))
    ).toBeNull();
    expect(
      groupJidFromAuth(auth({ attributes: { groupJid: "" }, principalId: "x" }))
    ).toBeNull();
  });

  it("ignores a non-string groupJid", () => {
    expect(
      groupJidFromAuth(
        auth({ attributes: { groupJid: ["123@g.us"] }, principalId: "x" })
      )
    ).toBeNull();
  });
});

describe(senderJidFromAuth, () => {
  it("returns the principal id", () => {
    expect(
      senderJidFromAuth(
        auth({ attributes: {}, principalId: "61400@s.whatsapp.net" })
      )
    ).toBe("61400@s.whatsapp.net");
  });

  it("returns undefined when there is no current principal", () => {
    expect(senderJidFromAuth(auth(null))).toBeUndefined();
  });
});
