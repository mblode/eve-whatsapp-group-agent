# scripts

Human-run tools: offline maintenance of the embedded chat archive
(`agent/lib/data/chat-data.ts`) plus an end-to-end smoke test (`smoke.ts`). Run them
manually from the repo root; for the archive tool, commit and push the
regenerated blob to deploy. They are TypeScript run directly under Node (≥ 23.6
native type stripping — no build step) with no extra deps (built-in
`node:zlib`/`node:fs`/`node:child_process`, global `fetch`). They are covered by
`npm run typecheck`; use `node --check scripts/<file>.ts` as a quick syntax
check when you only touched one script.

`archive-io.ts` is the shared library `reingest-archive.ts` imports: it owns the
archive round-trip (`decodeExisting` / `renderFile`), the `D/M/YYYY` date format
(`toArchiveDate`), the dedup key (`recordKey`), the `ArchiveRecord` /
`ArchiveReaction` types, and the reaction aggregator (`aggregateReactions`).
`renderFile` wraps the base64 at 120 chars so the committed blob diffs
line-by-line. It is not run directly.

## reingest-archive.ts

Populates / refreshes the embedded chat archive (`agent/lib/data/chat-data.ts`) that
`search-chat` and `get-group-stats` read. That file ships empty in this template
and, once populated, freezes at the last reingest (search can't see anything said
after it). This script pulls the recent tail from the live Baileys bridge and
rewrites the data file. `search-chat` also merges the bridge's live tail at query
time, so the bot works on recent messages even before you bake an archive.

```sh
BRIDGE_URL=https://your-bridge WHATSAPP_BRIDGE_SECRET=… \
  node scripts/reingest-archive.ts --group <group-jid> --merge
```

| flag / env                               | meaning                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--group <jid>` (or `REFRESH_GROUP_JID`) | group JID to fetch                                                                                                |
| `--n <count>`                            | recent messages to pull, default 500 (the bridge caps a request at 500 and returns the most recent N, no paging). |
| `--merge`                                | merge the tail onto the existing archive (dedup by date+sender+text). Without it the file is **replaced**.        |
| `--export`                               | pull the bridge's **full** stored history via `/export` (no 500 cap). Pair with `--merge` to avoid overwriting.   |
| `--out <path>`                           | output path, default `agent/lib/data/chat-data.ts`                                                                |
| `--dry-run`                              | report counts but don't write                                                                                     |

Use `--merge` in practice: the bridge returns only the recent tail, so the baked
archive holds the deep history and `--merge` tops up the recent end. After
running, commit the regenerated file and push so the new archive ships with the
agent — the GitHub→Vercel deploy builds from it.

## smoke.ts

End-to-end smoke test that drives the _live_ agent over its public HTTP session
API (`POST /eve/v1/session` + stream) — the same contract the dev TUI and the
WhatsApp bridge use. It exercises the real model and prompt, unlike vitest, which
only covers pure units. Each message runs as a fresh DM-style session (no group
JID), the no-jid branch in `agent/instructions.ts`.

```bash
# Local: start the dev server in one terminal, smoke it from another.
npm run dev
npm run smoke -- "hey, what can you do?"        # ad-hoc messages
npm run smoke -- --url https://your-agent.vercel.app   # against a deployment
```

Exits non-zero if any reply is empty or errors. If the deployment protects the
session API, pass a bearer token via `EVE_AUTH`. The default (no-arg) run and any
persona/easter-egg checks assume you've added your own eggs in
`agent/lib/easter-eggs.ts` (empty by default) — pass explicit messages otherwise.
