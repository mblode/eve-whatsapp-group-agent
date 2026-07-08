/**
 * Member invite / referral forwarding. The eve agent's `invite-member` tool
 * POSTs here via the bridge's `/invite` route; the bridge DMs the configured
 * maintainer a presentable summary of the person being referred. These pure
 * helpers (dedup key, message text) are split out so they're unit-testable
 * without the socket, matching `report.ts`.
 */

export interface InviteRequest {
  fullName: string;
  phone: string;
  email?: string;
  linkedIn?: string;
  /** Optional context: who's referring, why, how they know them. */
  note?: string;
  /** Display name of the member who asked the agent to forward the invite. */
  requestedBy?: string;
  /** Whether the details were typed out or read off a shared contact card. */
  source?: "form" | "contact-card";
}

/** Bare digits of a phone string, for dedup (ignores spaces, +, punctuation). */
const phoneDigits = (phone: string): string => phone.replaceAll(/\D/gu, "");

/**
 * Stable dedup key for an invite: the whitespace-normalised, lowercased name
 * plus the phone's bare digits. Lets the bridge drop a repeat referral of the
 * same person without re-DMing the maintainer.
 */
export const inviteDedupKey = (invite: InviteRequest): string => {
  const name = invite.fullName.toLowerCase().replaceAll(/\s+/gu, " ").trim();
  return `invite:${name}:${phoneDigits(invite.phone)}`;
};

/** Render an invite as the plain-text WhatsApp DM the maintainer receives. */
export const buildInviteMessage = (
  invite: InviteRequest,
  botName: string
): string => {
  const from = invite.requestedBy?.trim() || "someone";
  const lines = [
    `New member invite via @${botName}`,
    `From: ${from}`,
    "",
    `Name: ${invite.fullName.trim()}`,
    `Phone: ${invite.phone.trim()}`,
  ];
  const email = invite.email?.trim();
  if (email) {
    lines.push(`Email: ${email}`);
  }
  const linkedIn = invite.linkedIn?.trim();
  if (linkedIn) {
    lines.push(`LinkedIn: ${linkedIn}`);
  }
  const note = invite.note?.trim();
  if (note) {
    lines.push("", note);
  }
  return lines.join("\n");
};
