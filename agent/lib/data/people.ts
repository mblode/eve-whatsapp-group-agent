/**
 * member roster for the agent.
 *
 * The roster itself lives in `bridge/members.ts` (keyed by phone), so the Railway
 * bridge and the Vercel agent read the exact same list — one source of truth, no
 * sync, no external store, no drift. This module just re-exports it under the
 * agent's existing names and derives the helpers the agent code uses.
 *
 * `roster.ts` builds the structured roster from this; `who-is` reads it directly.
 */

// BOUNDARY: the one sanctioned agent→bridge import. The Vercel agent reads the
// Railway bridge's roster by relative path so both deploy from a single source
// of truth (no sync, no drift). Keep this the ONLY cross-package import; never
// reach into other bridge internals from the agent.
import { MEMBERS } from "../../../bridge/members.js";
import type { Member } from "../../../bridge/members.js";

/** A member profile. Phone (E.164) is the unique id; see bridge/members.ts. */
export type PersonProfile = Member;

export const PEOPLE: PersonProfile[] = MEMBERS;

/** Members only (non-member contacts, if any, are excluded). */
export const memberProfiles = (): PersonProfile[] =>
  PEOPLE.filter((p) => p.member !== false);

/** Current-member display names, derived from the roster (no hand-kept list). */
export const MEMBER_NAMES: string[] = memberProfiles().map((p) => p.name);

/** Every member phone (E.164). */
export const memberPhones = (): string[] =>
  memberProfiles()
    .map((p) => p.phone)
    .filter(Boolean);
