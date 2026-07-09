# Eve WhatsApp group agent

A Claude-powered agent that lives in a WhatsApp group and replies when @mentioned. Built on [eve](https://vercel.com/eve), Vercel's filesystem-first agent framework, with a [Baileys](https://github.com/WhiskeySockets/Baileys) bridge so it can join group chats (the official WhatsApp Business API can't).

## What you get

- **A group member, not a help desk.** Replies only when @mentioned or quote-replied, in clean WhatsApp plain text.
- **Web research.** Live `web_search` and `web_fetch`, a Firecrawl-backed `read-url` for JS-heavy pages and PDFs, and `get-youtube-transcript` for video summaries.
- **Group grounding.** `search-chat` (BM25 over the chat history), recaps, shared resources, reaction and message-count analytics, and `who-is` over a member roster.
- **Per-group memory.** Durable prose facts stored on the bridge, admin-gated, with an on-demand health audit and reactive self-healing (no crons).
- **Reads what's shared.** Images and screenshots, PDFs and office documents, voice notes (transcribed via an OpenAI-compatible endpoint), and contact cards for member referrals.
- **A real bridge.** Baileys 7 (LID sessions), QR or pairing-code login, volume-persisted auth, fully env-configured (bot name, group allowlist, maintainer/admin identities, shared-secret HTTP API).

## Quick start

This is a template repo: click **Use this template** on GitHub to create your own copy, then clone it. The full walkthrough (burner number, eve scaffold, Vercel + Railway deploy, debugging) is in **[docs/build-your-own-whatsapp-agent.md](docs/build-your-own-whatsapp-agent.md)**.

```bash
npm install
npm run dev        # eve dev TUI: chat with the agent locally, no bridge needed
npm test           # agent unit tests
npm run typecheck
```

The bridge is a separate package:

```bash
cd bridge
npm install
cp .env.example .env   # set EVE_URL + WHATSAPP_BRIDGE_SECRET at minimum
npm start              # prints a QR to scan from WhatsApp → Linked devices
```

## Make it yours

The template runs as-is with placeholder content. Swap in your own:

- **Persona:** `agent/lib/base-instructions.ts` (bot name, community, voice, "who's who"). The bot name should match `BOT_NAME` on the bridge.
- **Roster:** `bridge/members.ts` ships two fake members. This one file feeds both the bridge's DM allowlist and the agent's who-is/roster tools.
- **Chat archive:** `agent/lib/data/chat-data.ts` ships empty. Bake your own group export with `scripts/reingest-archive.ts` (see `scripts/README.md`). `search-chat` merges the bridge's live tail at query time, so recent messages work before you bake an archive.

See [AGENTS.md](AGENTS.md) for the project layout, commands, and gotchas.

## License

MIT, see [LICENSE](LICENSE).
