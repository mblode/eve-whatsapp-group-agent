import { afterEach, beforeEach, describe, expect, it } from "vitest";

import inviteMember from "#tools/invite-member.js";

// Off-bridge context (no BRIDGE_URL / secret), the way the eve TUI runs. The
// tool should degrade to { available: false } rather than throw, matching the
// other bridge-backed tools.
const ctx = { session: { auth: { current: undefined } } } as never;

describe("invite-member", () => {
  let originalBridgeUrl: string | undefined;
  let originalBridgeSecret: string | undefined;

  beforeEach(() => {
    originalBridgeUrl = process.env.BRIDGE_URL;
    originalBridgeSecret = process.env.WHATSAPP_BRIDGE_SECRET;
    delete process.env.BRIDGE_URL;
    delete process.env.WHATSAPP_BRIDGE_SECRET;
  });

  afterEach(() => {
    if (originalBridgeUrl === undefined) {
      delete process.env.BRIDGE_URL;
    } else {
      process.env.BRIDGE_URL = originalBridgeUrl;
    }
    if (originalBridgeSecret === undefined) {
      delete process.env.WHATSAPP_BRIDGE_SECRET;
    } else {
      process.env.WHATSAPP_BRIDGE_SECRET = originalBridgeSecret;
    }
  });

  it("degrades gracefully without the bridge rather than throwing", async () => {
    const res = (await inviteMember.execute(
      { fullName: "Jane Doe", phone: "+61400000000" },
      ctx
    )) as { available?: boolean; note?: string; invited?: boolean };
    // No bridge configured (eve TUI / test env): available:false. If a bridge
    // env leaks into CI the call fails closed with invited:false; either way it
    // never delivers and never throws.
    expect(res.available === false || res.invited === false).toBeTruthy();
  });
});
