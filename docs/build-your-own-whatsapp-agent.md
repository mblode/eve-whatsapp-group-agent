# Build your own WhatsApp group agent (an eve + Baileys guide)

A weekend guide. By the end you'll have a Claude-powered agent that lives in a WhatsApp group and replies when you @mention it.

Two deployables:

```
WhatsApp group ──► Baileys bridge (Railway) ──HTTP──► eve agent (Vercel)
       ▲                                                    │
       └─────────────────── reply ◄──────────────────────────┘
```

- **eve agent**: the brain. TypeScript, deploys to **Vercel**. Persona, tools, and model live here.
- **Baileys bridge**: the hands. A small Node service that logs into a real WhatsApp account, listens for group messages, forwards them to the agent, and posts the reply back. It holds a live WhatsApp socket, so it needs a long-running host: **Railway** (Vercel functions are too short-lived).

Why two pieces? The official WhatsApp Business API doesn't support group chats. To join a group you have to drive a normal WhatsApp account, and that's what [Baileys](https://github.com/WhiskeySockets/Baileys) does.

> ⚠️ **Use a burner number, not your personal one.** Automating a normal WhatsApp account is against WhatsApp's Terms of Service and the number can be banned. Treat it as disposable.

## What you'll need

- A GitHub account (Vercel and Railway both deploy from a repo).
- A [Vercel](https://vercel.com) account with **AI Gateway** enabled. This is what lets the agent call Claude: eve routes models like `anthropic/claude-sonnet-5` through it.
- A [Railway](https://railway.app) account (the free trial is plenty).
- A burner phone number that can receive WhatsApp (step 0).
- Node 24 for the agent, Node ≥ 20 for the bridge.

## Step 0: Get a burner number

You need a WhatsApp account that isn't your personal one.

A cheap prepaid eSIM works well for a fresh number. Register it on WhatsApp Business on a spare phone, or on the same phone as regular WhatsApp. Business vs regular doesn't matter to the bridge; Business just keeps it separate from your personal WhatsApp.

You only need the number long enough to register WhatsApp and scan a "link a device" QR. After that the bridge holds the session.

## Step 1: Get the agent running locally

The agent is an [eve](https://vercel.com/eve) project. eve is Vercel's agent framework ("like Next.js, but for agents"): Markdown for instructions, TypeScript for tools, durable execution on Vercel. This repo started as `npx eve@latest init` plus the WhatsApp channel, tools, and bridge, so start from the template rather than a fresh scaffold: click **Use this template** on GitHub, then clone your copy.

```bash
git clone https://github.com/<you>/<your-copy>
cd <your-copy>
npm install
npm run dev        # eve dev TUI, hot-reloads the agent
```

### How an eve project is laid out

Convention over configuration: drop a file in the right folder and it auto-registers, no manual wiring.

| Path | What it is |
| --- | --- |
| `agent/instructions.ts` (or `instructions.md`) | The agent's persona / system prompt. |
| `agent/agent.ts` | Optional model + runtime config. |
| `agent/tools/*.ts` | One callable tool per file (filename = tool name). |
| `agent/channels/*.ts` | Platform integrations (web, the WhatsApp bridge endpoint, …). |
| `agent/schedules/*.ts` | CRON jobs. |
| `agent/skills/*.md` | Markdown playbooks loaded contextually. |

`agent.ts` is tiny, basically just the model choice:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5", // routed via Vercel AI Gateway
  modelOptions: {
    providerOptions: {
      anthropic: { thinking: { type: "adaptive" } },
    },
  },
});
```

The model string is resolved by the AI Gateway, so you never hand-wire an Anthropic key. Vercel handles the routing and billing.

### The WhatsApp channel

The bridge doesn't talk to the model directly; it POSTs to a channel route the agent exposes. That's `agent/channels/whatsapp.ts`, a `defineChannel` with a single route (abridged):

```ts
import { defineChannel, POST } from "eve/channels";

const BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET;

export default defineChannel({
  routes: [
    POST("/eve/v1/whatsapp/message", async (req, { send }) => {
      // 1. Auth: shared secret, identical on bridge + agent.
      if (!BRIDGE_SECRET) return Response.json({ error: "…" }, { status: 503 });
      if (req.headers.get("x-bridge-secret") !== BRIDGE_SECRET)
        return new Response("unauthorized", { status: 401 });

      const { token, message, sender, senderName, context } = await req.json();

      // 2. Build an auth object. The group JID rides in attributes so tools
      //    and per-group memory can resolve which chat this is.
      const auth = {
        attributes: { groupJid: token, ...(senderName && { senderName }) },
        authenticator: "whatsapp-bridge",
        principalId: sender ?? token,
        principalType: "user",
      } as const;

      // 3. Fresh session per message: a unique continuation token so the
      //    event stream yields exactly THIS turn (no stale replay).
      const session = await send(
        { context, message },
        { auth, continuationToken: `${token}#${crypto.randomUUID()}` }
      );

      // 4. Drain the stream to the final assistant message, then normalise
      //    Markdown → WhatsApp plain text before replying.
      const reply = cleanReply(
        await drainStream(await session.getEventStream())
      );
      return Response.json({ reply });
    }),
  ],
});
```

Three details worth copying:

- **Shared-secret gate** (`x-bridge-secret`): `503` if unset, `401` if wrong. Same contract as the bridge's own HTTP API.
- **Fresh session per message** (unique continuation token). eve's event stream replays from index 0; reuse the token and you'd get a prior turn's reply forever. The trade-off, no in-thread memory, is covered by grounding tools (search, recent-messages) and injected group memory.
- **`cleanReply` on the way out** normalises the model's Markdown into clean WhatsApp text. Format once at the channel boundary, not in tools.

The other channel, `agent/channels/eve.ts`, is the built-in `eveChannel` that lets the eve TUI and your Vercel deployments reach the agent.

### Tools degrade, never throw

Each tool is a `defineTool` with a Zod `inputSchema` and an `execute`. One convention worth keeping: a tool that needs the bridge or a group context returns `{ available: false }` instead of throwing, so the same tool is safe from the eve TUI (no group) and from a live group:

```ts
export default defineTool({
  description: "Get the most recent messages from this WhatsApp group…",
  inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  async execute(input, ctx) {
    const jid = groupJidFromAuth(ctx.session.auth); // from the auth above
    if (!bridgeConfigured() || !jid) return { available: false, messages: [] }; // graceful, no throw
    const { messages } = await bridgeGet(
      `/messages?group=${jid}&n=${input.limit ?? 50}`
    );
    return { available: true, messages };
  },
});
```

(Import bridge helpers via the `#lib/…js` alias; eve maps `#*` → `agent/*`.)

### Deploy it

1. **Import your repo into Vercel** (it's already on GitHub from step 1).
2. Make sure **AI Gateway** is enabled on the Vercel project (this authorises the `anthropic/claude-sonnet-5` calls).
3. Add the shared secret you'll reuse on the bridge:
   ```bash
   vercel env add WHATSAPP_BRIDGE_SECRET production   # any long random string
   vercel deploy --prod
   ```
4. Note your deployment URL, e.g. `https://your-agent.vercel.app`. The bridge posts to `…/eve/v1/whatsapp/message` on this host.

## Step 2: Run the bridge locally and log in

Log in once locally so your first QR scan isn't inside Railway deploy logs:

```bash
cd bridge
npm install
EVE_URL=https://your-agent.vercel.app \
WHATSAPP_BRIDGE_SECRET=<same value as on Vercel> \
AUTH_DIR=./auth \
npm start
```

A QR code prints in the terminal. On the burner phone: **WhatsApp → Settings → Linked devices → Link a device**, then scan it. The login is saved under `./auth`.

Prefer a code to a QR? Set `PAIRING_NUMBER=15551234567` (international, no `+`) and it logs an 8-digit pairing code instead.

## Step 3: Deploy the bridge (Railway)

1. **New service** on Railway from your repo; set the service **Root Directory** to `bridge`.
2. **Add a volume mounted at `/data`.** This keeps the WhatsApp login alive across restarts and redeploys; without it you re-scan the QR every deploy.
3. Set **variables**:
   - `EVE_URL=https://your-agent.vercel.app`
   - `WHATSAPP_BRIDGE_SECRET=` the **same value as on Vercel**. It guards both message forwarding and the bridge's HTTP API.
   - `AUTH_DIR=/data/auth` so the login lives on the volume.
   - `TRIGGER_MODE=mention` to reply only when @mentioned or quote-replied. Other modes: `prefix` (replies to `!bot …`) and `all` (test groups only).
   - `BOT_NAME=Robin`, the name attributed to the bot's own messages.
   - Optional: `VISION_ENABLED=true` to let it see shared images, `PAIRING_NUMBER=`, `ALLOWED_GROUPS=`.
4. **Deploy**, open the deploy **logs**, and scan the QR (or read the pairing code) just like step 2. The volume keeps you logged in afterward.

### Let the agent call back into the bridge

The agent reads recent messages, shared links, and memory back from the bridge, so give the bridge a public URL and tell the agent about it:

1. Railway → bridge service → **Settings → Networking → Generate Domain**. You get something like `your-bridge-production.up.railway.app`.
2. On **Vercel**, set `BRIDGE_URL` to that domain and redeploy. With the matching `WHATSAPP_BRIDGE_SECRET`, the agent's tools can now read the buffer.

## Step 4: Add it to a group and say hi

In WhatsApp, **add the burner number to your group**, then **@mention it**. With `TRIGGER_MODE=mention` it stays quiet until summoned, then replies in clean WhatsApp text.

## Debugging

Every bridge request except `GET /health` carries an `x-bridge-secret: <WHATSAPP_BRIDGE_SECRET>` header. Wrong or missing secret gets a `401`; secret not configured at all gets a `503`. Quick checks:

- `GET https://your-bridge…/health` returns `{ ok: true }` when the bridge is up.
- Bot silent in the group? Check `TRIGGER_MODE` and that you actually @mentioned it. Railway logs show the forwarded message.
- Bot replies but knows nothing about recent chat? `BRIDGE_URL` on Vercel is missing or the secrets don't match.
- Re-scanning the QR every deploy? The `/data` volume isn't mounted, or `AUTH_DIR` doesn't point at it.

## Gotchas

- **Burner, always.** Don't risk your personal number.
- **The volume is everything.** No volume, no persisted login: QR every restart.
- **Secrets must match exactly** on Vercel and Railway, or the two sides `401` each other silently.
- **DMs vs groups.** A 1:1 DM is always treated as addressed to the bot; `TRIGGER_MODE` only governs groups. (This repo also gates DM replies to a member allowlist; that part is optional for you.)

That's it. Use the template, set six env vars, scan one QR, @mention it. 🚀
