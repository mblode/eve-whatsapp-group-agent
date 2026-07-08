import type { Logger } from "pino";

import { MEMBERS } from "./members.js";

/**
 * member phone allowlist, derived straight from `bridge/members.ts` — the
 * single source of truth shared with the agent. No external store and no sync:
 * the roster and the DM allowlist are the same data, so they can't drift.
 *
 * Numbers are compared on digits so they line up with WhatsApp phone JIDs
 * (`61...@s.whatsapp.net`). Used to gate 1:1 DMs to members only — group
 * messages aren't gated (the group is already invite-only).
 */

const digits = (s: string | null | undefined): string =>
  (s || "").replaceAll(/\D/gu, "");

const MEMBER_PHONES = new Set(
  MEMBERS.map((m) => digits(m.phone)).filter(Boolean)
);

/** The allowlist surface: membership check plus a readiness flag. */
export interface Whitelist {
  isMember: (num: string | null | undefined) => boolean;
  ready: () => boolean;
}

export const createWhitelist = (logger: Logger): Whitelist => {
  logger.info(
    { count: MEMBER_PHONES.size },
    "loaded member allowlist from bridge/members.ts"
  );
  return {
    isMember(num) {
      const d = digits(num);
      if (!d) {
        return false;
      }
      if (MEMBER_PHONES.has(d)) {
        return true;
      }
      // AU tolerance: 0-prefixed national form vs 61-prefixed E.164.
      if (d.startsWith("0") && MEMBER_PHONES.has(`61${d.slice(1)}`)) {
        return true;
      }
      const last9 = d.slice(-9);
      if (last9.length === 9 && MEMBER_PHONES.has(`61${last9}`)) {
        return true;
      }
      return false;
    },
    // Built from a static import, so it's always ready.
    ready: () => true,
  };
};
