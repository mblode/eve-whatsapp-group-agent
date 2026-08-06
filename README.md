<div align="center">

# Eve WhatsApp Group Agent

**An AI agent that lives in your WhatsApp group and replies when someone @mentions it**

Built on [eve](https://vercel.com/eve) with a [Baileys](https://github.com/WhiskeySockets/Baileys) bridge, since the official WhatsApp Business API can't join group chats.

</div>

## Install

Click **Use this template** on GitHub to make your own copy, clone it, then install both packages:

```bash
npm install
(cd bridge && npm install)
```

The agent needs Node 24 and the bridge needs Node 20 or later.

## Quickstart

Chat with the agent in a local TUI, with no WhatsApp involved:

```bash
npm run dev
```

To put it in a real group, start the bridge and scan the QR from WhatsApp > Linked devices:

```bash
cd bridge
cp .env.example .env   # set EVE_URL and WHATSAPP_BRIDGE_SECRET at minimum
npm start
```

The full walkthrough, from burner number to Vercel and Railway deploys, is in [docs/build-your-own-whatsapp-agent.md](docs/build-your-own-whatsapp-agent.md).

## What you get

- **A group member, not a help desk:** it replies only when @mentioned or quote-replied, in clean WhatsApp plain text.
- **Web research:** live `web_search` and `web_fetch`, a Firecrawl-backed `read-url` for JS-heavy pages and PDFs, and `get-youtube-transcript` for video summaries.
- **Group grounding:** `search-chat` runs BM25 over the chat history, alongside recaps, shared resources, reaction and message-count analytics, and `who-is` over a member roster.
- **Per-group memory:** durable prose facts stored on the bridge, admin-gated, with an on-demand health audit and reactive self-healing rather than crons.
- **Reads what's shared:** images and screenshots, PDFs and office documents, voice notes transcribed through an OpenAI-compatible endpoint, and contact cards for member referrals.
- **A real bridge:** Baileys 7 with LID sessions, QR or pairing-code login, volume-persisted auth, and everything from bot name to group allowlist set by environment variable.

## Make it yours

The template runs as-is on placeholder content. Three files carry your group:

- **Persona:** `agent/lib/base-instructions.ts` holds the bot name, the community, the voice, and the who's who. The name should match `BOT_NAME` on the bridge.
- **Roster:** `bridge/members.ts` ships two fake members. This one file feeds both the bridge's DM allowlist and the agent's who-is and roster tools.
- **Chat archive:** `agent/lib/data/chat-data.ts` ships empty. Bake your own group export in with `scripts/reingest-archive.ts`. `search-chat` merges the bridge's live tail at query time, so recent messages work before you bake anything.

## License

MIT

---

Crafted by [<img src="https://blode.co/avatar-circle.png" width="20" align="top" />](https://blode.co) [Matthew Blode](https://blode.co)
