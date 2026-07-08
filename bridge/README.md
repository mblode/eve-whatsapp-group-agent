# WhatsApp group bridge

Connects a real WhatsApp account to the eve agent so it can take part in **group
chats**, which the official WhatsApp Business API does not support.

It logs in with [Baileys](https://github.com/WhiskeySockets/Baileys), listens to
group messages, forwards them to the eve agent's `/eve/v1/whatsapp/message`
endpoint, and posts the reply back into the group.

> ⚠️ This automates a normal WhatsApp account, which is against WhatsApp's Terms
> of Service. The number can be banned. **Use a dedicated/burner number, not your
> personal one.**

## How it fits together

```
WhatsApp group ──► Baileys bridge (Railway) ──HTTP──► eve agent (Vercel)
       ▲                                                     │
       └──────────────────── reply ◄─────────────────────────┘
```

The eve side lives in `../agent/channels/whatsapp.ts`. The two sides
authenticate with a shared secret (`WHATSAPP_BRIDGE_SECRET`) that must be
identical on both.

## HTTP API

Alongside the WhatsApp socket the bridge runs a small JSON HTTP API on `PORT`
(Railway injects this; defaults to `8080` locally). The eve agent calls back
into it — via tools — to read the captured message/resource buffer and to
read/write per-group memory.

Every request **except** `GET /health` must send the header
`x-bridge-secret: <WHATSAPP_BRIDGE_SECRET>` — the same shared secret that
guards message forwarding. A missing/wrong secret returns `401`; if the secret
isn't configured on the bridge at all, routes return `503`.

| Method | Route                               | Purpose                                                                                                                                                                                 |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                           | Liveness probe → `{ ok: true }` (no auth).                                                                                                                                              |
| `GET`  | `/messages?group=<jid>&n=<n>`       | Recent captured messages → `{ messages: [{ t, s, n, x }] }`. Records may also include `role` (`"user"`/`"assistant"`) and `surface` (`"dm"`/`"group"`). `n` default 150, clamped 1–500. |
| `GET`  | `/resources?group=<jid>&n=<n>`      | Recent shared links → `{ resources: [{ t, s, n, url }] }`. `n` default 40, clamped 1–200.                                                                                               |
| `GET`  | `/reactions?group=<jid>&n=<n>`      | Recent emoji reactions → `{ reactions: [{ t, s, target, emoji }] }` (`s` reactor, `target` reacted-to message id, empty `emoji` = removed). `n` default 200, clamped 1–1000.            |
| `GET`  | `/memory?group=<jid>`               | Per-group memory → `{ memory: { <category>: "<prose>" } }`.                                                                                                                             |
| `GET`  | `/memory/history?group=<jid>&n=<n>` | Memory write log (newest last) → `{ history: [{ t, category, by }] }` (prose omitted). Powers the agent's memory-freshness metric. `n` default 100, clamped 1–1000.                     |
| `POST` | `/memory`                           | Body `{ group, category, content, by }` → upsert a memory category. Returns `{ saved: true }`.                                                                                          |

`group` is the WhatsApp group JID (e.g. `1234567890-987654@g.us`); it's
required on every data route. The buffer lives on the Railway volume under
`<DATA_DIR>/{messages,resources,memory}/`.

### Pointing the agent at the bridge

The eve agent reaches this API over the public internet, so it needs the
bridge's **public** Railway URL:

1. Railway dashboard → the bridge service → **Settings → Networking → Generate
   Domain**. This creates a public HTTPS domain (e.g.
   `your-bridge-production.up.railway.app`).
2. On the **Vercel** (eve agent) project, set `BRIDGE_URL` to that domain and
   redeploy. With `WHATSAPP_BRIDGE_SECRET` matching on both sides, the agent's
   tools can now read the buffer and read/write memory.

## Trigger modes

By default the bot only replies when **@-mentioned** or when someone **replies to
one of its messages** — so it isn't noisy in a busy group.

- `TRIGGER_MODE=mention` (default) — reply on @mention or quote-reply.
- `TRIGGER_MODE=prefix` — reply to messages starting with `TRIGGER_PREFIX` (default `!bot`).
- `TRIGGER_MODE=all` — reply to every message (noisy; use only in a test group).

An image shared with the bot (in a DM, or @mentioning/replying to it in a group)
is downloaded and forwarded so the bot can see it — a caption-less image that
replies to the bot still triggers. Video and audio are logged as placeholders
only. See `VISION_ENABLED` below.

`TRIGGER_MODE` applies to **groups**. A 1:1 DM is always treated as addressed to
the bot, but the bot only **replies** to DMs from members — the phone whitelist
derived from `bridge/members.ts` (see `whitelist.js`). DMs from non-members are
still logged to the transcript — they just get no reply. If the roster is empty
the bridge fails open (replies to any DM), so add your members to gate DMs.

## Messaging yourself (self-chat console)

The linked account's own **"Message yourself"** chat is treated as a DM to the
agent — a handy personal console. Every message there is `fromMe`, which is
normally dropped, so it's special-cased: a DM whose JID matches one of the
account's own identities (its number or `@lid`) is kept and answered, bypassing
the member allowlist (you don't need to add your own number to `members.ts`).
The bot's own reply lands back in the same chat; it won't loop, because the
bridge skips any message it just sent. Outbound messages in every other chat
stay unanswered, unchanged.

## Run locally (first login)

```bash
cd bridge
cp .env.example .env        # fill in EVE_URL + WHATSAPP_BRIDGE_SECRET
npm install
AUTH_DIR=./auth npm start
```

A QR code prints in the terminal. On the burner phone: **WhatsApp → Settings →
Linked devices → Link a device**, then scan it. Login is saved to `./auth`.

Prefer a pairing code over QR? Set `PAIRING_NUMBER=15551234567` (international,
no `+`) and an 8-digit code is logged instead.

## Deploy to Railway

The bridge needs a long-running host (it holds a WhatsApp socket), so it runs on
Railway, not Vercel.

1. **New service** from this repo, set the service **Root Directory** to `bridge`.
2. **Add a volume** mounted at `/data` so the WhatsApp login survives restarts.
3. **Variables:**
   - `EVE_URL=https://your-agent.vercel.app`
   - `WHATSAPP_BRIDGE_SECRET=` (same value as on Vercel) — guards both message
     forwarding **and** the read/write HTTP API above.
   - `AUTH_DIR=/data/auth`
   - `TRIGGER_MODE=mention`
   - `BOT_NAME=Robin` — name attributed to the bot's own messages in the transcript.
   - `VISION_ENABLED=true` (default) — download images shared with the bot and
     forward them so it can see them; set `false` to disable. `MAX_IMAGE_BYTES`
     caps each image (default 4MB; WhatsApp pre-compresses and Anthropic
     downsizes large images server-side).
   - `OPENAI_API_KEY=` — enables voice-note transcription. When set, the bridge
     downloads a shared voice message, transcribes it via an OpenAI-compatible
     `/audio/transcriptions` endpoint, and forwards the text to the agent as the
     message (Claude can't hear audio). Unset = off, and audio keeps the plain
     `[audio]` placeholder. `TRANSCRIBE_BASE_URL` (default
     `https://api.openai.com/v1`) and `TRANSCRIBE_MODEL` (default
     `gpt-4o-mini-transcribe`) point it at a provider — e.g. Groq with
     `https://api.groq.com/openai/v1` + `whisper-large-v3-turbo` (the key still
     rides in `OPENAI_API_KEY`). `AUDIO_ENABLED=true`
     (default) gates the feature; `MAX_AUDIO_BYTES` (default 16MB),
     `MAX_AUDIO_SECONDS` (default 600) and `TRANSCRIBE_TIMEOUT_MS` (default 30000)
     bound cost and latency.
   - optionally `ALLOWED_GROUPS=`, `PAIRING_NUMBER=`
   - `PORT` is provided by Railway automatically; the HTTP API binds to it.
     After deploy, **Generate Domain** (see _Pointing the agent at the bridge_
     above) and set `BRIDGE_URL` on Vercel to the public domain.
4. **Deploy**, open the deploy **logs**, and scan the QR (or read the pairing
   code). The volume keeps you logged in across future deploys.
5. In WhatsApp, **add the burner number to the group** and @mention it.

## eve side (Vercel)

Set `WHATSAPP_BRIDGE_SECRET` on the Vercel project to the same value and
redeploy:

```bash
vercel env add WHATSAPP_BRIDGE_SECRET production
vercel deploy --prod
```
