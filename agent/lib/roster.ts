/**
 * Structured the group roster used by the memory self-healing code (drift detection,
 * stale-fact scan). It is now *derived* from the richer profiles in
 * `#data/people.ts` — that file is the single source of truth for member facts;
 * this stays the slim machine-readable mirror the scanners already consume.
 *
 * `roster.test.ts` asserts the derived roster stays consistent with the profile
 * data so the two can't silently drift apart.
 */

import { memberProfiles } from "#data/people.js";
import type { PersonProfile } from "#data/people.js";

export interface RosterEntry {
  name: string;
  /** Other names/handles a member is referred to by. */
  aliases?: string[];
  role?: string;
  org?: string;
  /** Free-form interest/affiliation tags ("founder", "codex", "mcp", …). */
  tags: string[];
}

/** Project a full profile down to the slim roster shape the scanners use. */
const toRosterEntry = (p: PersonProfile): RosterEntry => ({
  name: p.name,
  ...(p.aliases?.length ? { aliases: p.aliases } : {}),
  ...(p.role ? { role: p.role } : {}),
  ...(p.org ? { org: p.org } : {}),
  tags: p.tags,
});

/** Members only (non-member contacts in people.ts are excluded). */
export const ROSTER: RosterEntry[] = memberProfiles().map(toRosterEntry);

/** Lower-cased first token of a name ("Ada Lovelace" → "ada"). */
export const firstName = (name: string): string =>
  name.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";

/**
 * Find an entry by a loose name/handle in any list of name+alias records.
 * Matches full name, first name, an alias, or a clear substring either way —
 * enough to resolve "Alice", "alice example", or "Jordy" without
 * false-matching short fragments. Shared so the `who-is` tool can resolve
 * against the full profile list (including non-members) with the same rules.
 */
export const matchPerson = <T extends { name: string; aliases?: string[] }>(
  people: readonly T[],
  query?: string | null
): T | undefined => {
  if (!query) {
    return undefined;
  }
  const q = query.trim().toLowerCase();
  if (!q) {
    return undefined;
  }
  // Tiered, strongest-first, so a precise hit always beats a loose one. This
  // matters now that some members are first-name-only ("Ben", "Will"): a bare
  // "Jordan" must not shadow "Jordan Lee" when someone asks for "Jordy".
  const aliasHit = (e: T) => e.aliases?.some((a) => a.toLowerCase() === q);
  return (
    // 1. exact full name
    people.find((e) => e.name.toLowerCase() === q) ??
    // 2. exact alias
    people.find(aliasHit) ??
    // 3. exact first name
    people.find((e) => firstName(e.name) === q) ??
    // 4. guarded substring either way (>=3 chars), last resort
    (q.length >= 3
      ? people.find((e) => {
          const name = e.name.toLowerCase();
          return name.includes(q) || q.includes(name);
        })
      : undefined)
  );
};

/** Find a roster entry by a loose name/handle. */
export const findInRoster = (query?: string | null): RosterEntry | undefined =>
  matchPerson(ROSTER, query);

/**
 * Is this active sender a recognised member? True when the roster matches them
 * (exact name, first name, alias, or a clear substring) or the stored `members`
 * block names them by first name. `membersBlockLc` must already be lower-cased.
 */
export const isKnownMember = (
  name: string,
  membersBlockLc: string
): boolean => {
  if (findInRoster(name)) {
    return true;
  }
  const first = firstName(name);
  return first.length >= 3 && membersBlockLc.includes(first);
};
