import type { SessionContext } from "eve/tools";

import { bridgeConfigured } from "#lib/bridge-client.js";
import { groupJidFromAuth } from "#lib/session.js";

/**
 * Best-practice wrapper for a bridge-backed, group-scoped tool.
 *
 * Every such tool must DEGRADE instead of throwing: off a WhatsApp group (e.g.
 * the eve TUI) there's no group JID, and the bridge may be unconfigured or down.
 * This centralises that contract so tools stay thin and can't forget the guard:
 *
 *   - resolves the group JID from the session auth,
 *   - returns `{ available: false, ...unavailable }` when there's no group
 *     context or the bridge isn't configured,
 *   - runs `fn(jid)` and turns any throw into `{ available: false,
 *     ...unavailable, error }`.
 *
 * `unavailable` is the tool's own empty-result shape (e.g. `{ messages: [] }`);
 * `available: false` is added for you. On success `fn` returns the full result,
 * including `available: true`.
 *
 * Use this for tools that read live group state from the bridge. Tools where the
 * bridge is only optional enrichment (e.g. `get-reactions`, which always has the
 * baked archive) should NOT use it — they stay available and degrade per-field.
 */
export const withGroupBridge = async <U extends object, R extends object>(
  ctx: { session: { auth: SessionContext["session"]["auth"] } },
  unavailable: U,
  fn: (jid: string) => Promise<R>
): Promise<R | (U & { available: false; error?: string })> => {
  const jid = groupJidFromAuth(ctx.session.auth);
  if (!bridgeConfigured() || !jid) {
    return { available: false, ...unavailable };
  }
  try {
    return await fn(jid);
  } catch (error) {
    return { available: false, ...unavailable, error: String(error) };
  }
};
