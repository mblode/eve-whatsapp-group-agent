import type { SessionContext } from "eve/tools";

/**
 * Helpers for reading WhatsApp identity off the session auth. The WhatsApp
 * channel (see `agent/channels/whatsapp.ts`) stores the group JID under
 * `attributes.groupJid` and the sender JID as the principal id. Both tool
 * (`ToolContext`) and dynamic-instruction (`DynamicResolveContext`) callbacks
 * expose `session.auth` of this shape, so these centralize the extraction.
 */

type SessionAuthState = SessionContext["session"]["auth"];

/** The WhatsApp group JID for this session, or null off-group (e.g. the eve TUI). */
export const groupJidFromAuth = (auth: SessionAuthState): string | null => {
  const raw = auth.current?.attributes?.groupJid;
  return typeof raw === "string" && raw ? raw : null;
};

/** The JID of the member whose message triggered this turn, if known. */
export const senderJidFromAuth = (auth: SessionAuthState): string | undefined =>
  auth.current?.principalId;

/**
 * The sender's phone-based identity, if the bridge resolved one. Modern
 * WhatsApp uses an opaque `@lid` as the principal, so this carries the real
 * phone number (from `senderPn`) for admin matching against phone-based JIDs.
 */
export const senderPhoneFromAuth = (
  auth: SessionAuthState
): string | undefined => {
  const raw = auth.current?.attributes?.senderPhone;
  return typeof raw === "string" && raw ? raw : undefined;
};

/** The display name of the member who triggered this turn, if the bridge sent one. */
export const senderNameFromAuth = (
  auth: SessionAuthState
): string | undefined => {
  const raw = auth.current?.attributes?.senderName;
  return typeof raw === "string" && raw ? raw : undefined;
};
