# eve-whatsapp-group-agent

An AI agent that lives in a WhatsApp group and replies when @mentioned, built on the **eve** framework. Two deployables:

- **`agent/`** — the eve agent (TypeScript), deploys to Vercel. Tools, channels and instructions are files under `agent/`.
- **`bridge/`** — a Baileys WhatsApp ↔ agent bridge (TypeScript run via tsx, Node >=20), deploys to Railway. A **separate npm package** with its own tsconfig and tests; not covered by the root tsgo or vitest.

Before writing agent code, read the relevant guide in `node_modules/eve/docs/` (channels, tools, schedules, evals). New here? Start with `docs/build-your-own-whatsapp-agent.md`.

Install both packages first: `npm install` (root, Node 24) and `cd bridge && npm install` (bridge, Node >=20).

- `npm run dev` — eve dev TUI (hot-reloads the agent)
- `npm test` — vitest unit tests (`agent/**/*.test.ts`, `tests/**/*.test.ts`)
- `npm run typecheck` — tsgo (agent, evals, scripts, tests)
- `npm run check` — lint + format (ultracite); pre-commit auto-runs `ultracite fix`
- `npm run test:evals` — eve eval (LLM-judged); needs AI Gateway creds, skips without them
- `npm run build` — eve build (Vercel output)
- `cd bridge && npm test` — bridge unit tests (`tsx --test`); `cd bridge && npm run typecheck` — bridge tsc

Run `npm test` and `npm run typecheck` before committing.

## Make it yours

- **Persona:** `agent/lib/base-instructions.ts` is the neutral starter prompt. Change the bot's name (match `BOT_NAME` on the bridge), the community, the voice, and the "who's who". `agent/lib/easter-eggs.ts` is empty by default.
- **Roster:** `bridge/members.ts` ships two fake example members. Replace them with your own (keyed by E.164 phone). It's the single source of truth for both the bridge's DM allowlist and the agent's who-is/roster tools.
- **Chat archive:** `agent/lib/data/chat-data.ts` ships empty. Populate it from your own group export with `scripts/reingest-archive.ts` (see `scripts/README.md`). `search-chat` also merges the bridge's live tail at query time, so the bot works on recent messages even before you bake an archive.

## Writing a tool

Tools are thin and follow one shape — keep real logic in `agent/lib/`:

1. **One file per tool in `agent/tools/`; the filename IS the tool name.** eve auto-registers it (kebab-case). No manual wiring, no `index.ts`.
2. **`defineTool` stays a shell**: a `description`, a Zod `inputSchema` with `.describe()` on each field, and an `execute` that calls into `#lib/*`. Put parsing, ranking, matching, HTTP, etc. in a `lib` module with its own `*.test.ts` — tools themselves are barely worth unit-testing.
3. **Degrade, never throw.** A tool that reads live group state from the bridge must return `{ available: false, ... }` (not throw) when the bridge is unconfigured/down or there's no group context (e.g. the eve TUI). Wrap it with `withGroupBridge` from `#lib/bridge-tool.js`, which resolves the group JID, short-circuits to your empty-result shape, and turns any throw into `{ available: false, ..., error }`. Tools where the bridge is only optional enrichment (e.g. `get-reactions`, always available via the baked archive) degrade per-field instead.
4. **Never format output for WhatsApp** — `cleanReply` normalises Markdown at the channel boundary. Return plain data/text.

## Gotchas

- Tools auto-register from `agent/tools/*.ts` (filename = tool name); same for `agent/channels/` and `agent/schedules/`. No manual wiring — adding a file is enough.
- WhatsApp replies are plain text. `agent/lib/format-reply.ts` (`cleanReply`) normalises Markdown→WhatsApp on the way out: bold is a single `*` (never `**`), no headings/tables/em dashes. Don't hand-roll formatting in tools.
- Import aliases: `#*` → `agent/*`, `#data/*` → `agent/lib/data/*` (package.json `imports`). Import `#lib/...`, `#data/...` with a `.js` extension on the path.
- Evals live in `evals/` and run via `eve eval`, NOT vitest. vitest excludes `evals/**`, `.eve/**`, and `bridge/**` (see `vitest.config.ts`) — keep new bridge tests as `node --test`.
- Agent ↔ bridge calls are HTTP guarded by `WHATSAPP_BRIDGE_SECRET` (shared on both sides). Memory writes are admin-gated by JID (`MEMORY_ADMIN_JIDS`). Feature requests / bug reports route through the `report-feature-request` tool → bridge `POST /report` → a DM to `MAINTAINER_JID` (set on the bridge).
