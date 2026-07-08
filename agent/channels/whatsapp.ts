import { randomUUID } from "node:crypto";

import type { UserContent } from "ai";
import { defineChannel, POST } from "eve/channels";

import { cleanReply } from "#lib/format-reply.js";

/**
 * WhatsApp group channel.
 *
 * WhatsApp groups are not reachable over the official Business API, so this
 * channel does not talk to WhatsApp directly. Instead a separate Baileys bridge
 * (see `bridge/`) logs into a real WhatsApp account, listens to group messages,
 * and POSTs them here. We run the agent and return the reply synchronously so
 * the bridge can post it back into the group.
 *
 * The bridge authenticates with a shared secret. The group JID is used as the
 * continuation token, so every group keeps its own running conversation.
 */

const BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET;

interface BridgePayload {
  /** WhatsApp group JID, e.g. `1203...@g.us`. Used as the continuation token. */
  token?: string;
  /** The message text to send to the agent. */
  message?: string;
  /** Sender JID of the person who wrote the message, for attribution. */
  sender?: string;
  /** The sender's phone-based identity (from senderPn), used for admin checks. */
  senderPhone?: string;
  /** Display name of the sender, surfaced to the agent as context. */
  senderName?: string;
  /** Extra context blocks from the bridge (e.g. recent messages, shared links). */
  context?: string[];
  /** Where the message came from: a 1:1 DM or the group. Absent on old calls. */
  surface?: "dm" | "group";
  /** Images attached to the message, as data URLs, so the agent can see them. */
  media?: { mime?: string; dataUrl?: string }[];
}

const buildContextBlock = (
  surface: string | undefined,
  token: string,
  senderName: string | undefined,
  sender: string | undefined
): string[] => {
  if (surface === "dm") {
    return [
      "<whatsapp_context>",
      "surface: whatsapp_dm",
      "response_instructions: This is a 1:1 DM with an existing member. Same voice as the group: plain text, concise, avoid Markdown tables/headings/code fences, ask at most one short follow-up. No concierge or FAQ framing, do not act like a help desk.",
      ...(senderName ? [`sender_name: ${senderName}`] : []),
      ...(sender ? [`sender_jid: ${sender}`] : []),
      "</whatsapp_context>",
    ];
  }
  return [
    "<whatsapp_context>",
    "surface: whatsapp_group",
    "response_instructions: Reply in plain text suitable for WhatsApp. Keep it concise, avoid Markdown tables/headings/code fences, and ask at most one short follow-up question.",
    `group_jid: ${token}`,
    ...(senderName ? [`sender_name: ${senderName}`] : []),
    ...(sender ? [`sender_jid: ${sender}`] : []),
    "</whatsapp_context>",
  ];
};

const buildContext = (
  surface: string | undefined,
  token: string,
  senderName: string | undefined,
  sender: string | undefined,
  extraContext: string[] | undefined
): string[] => {
  const contextBlock = buildContextBlock(surface, token, senderName, sender);
  const context = [contextBlock.join("\n")];

  // Append any context blocks the bridge attached (recent messages, links,
  // conversation tail). These are member-supplied content, so fence them as
  // untrusted: data for the agent to read, never instructions to follow.
  if (Array.isArray(extraContext)) {
    for (const block of extraContext) {
      if (typeof block === "string" && block.trim()) {
        context.push(`<untrusted_context>\n${block}\n</untrusted_context>`);
      }
    }
  }
  return context;
};

const buildUserMessage = (
  message: string,
  media: { mime?: string; dataUrl?: string }[] | undefined
): string | UserContent => {
  // With images attached, send a multimodal user turn (text + file parts) so
  // the model can see them; otherwise plain text. Cap at 2 images to bound
  // token cost.
  const images = (Array.isArray(media) ? media : [])
    .filter((m): m is { mime?: string; dataUrl: string } =>
      Boolean(m && typeof m.dataUrl === "string")
    )
    .slice(0, 2);
  if (!images.length) {
    return message;
  }
  return [
    { text: message, type: "text" },
    ...images.map((m) => ({
      data: m.dataUrl,
      mediaType: m.mime || "image/jpeg",
      type: "file" as const,
    })),
  ];
};

const drainStream = async (
  stream: ReadableStream<{ type: string; data: { message?: string } }>
): Promise<string> => {
  const reader = stream.getReader();
  // The model emits interim narration before each tool call ("Let me
  // search…"); only the final assistant message is the answer to send.
  let finalMessage = "";
  try {
    while (true) {
      // Sequential reads from a streaming reader — cannot be parallelised.
      // oxlint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.type === "message.completed" && value.data.message) {
        finalMessage = value.data.message;
      }
      if (value.type === "turn.completed" || value.type === "turn.failed") {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return finalMessage;
};

export default defineChannel({
  routes: [
    POST("/eve/v1/whatsapp/message", async (req, { send }) => {
      if (!BRIDGE_SECRET) {
        return Response.json(
          { error: "WHATSAPP_BRIDGE_SECRET is not configured." },
          { status: 503 }
        );
      }
      if (req.headers.get("x-bridge-secret") !== BRIDGE_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }

      let body: BridgePayload;
      try {
        body = (await req.json()) as BridgePayload;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      const {
        token,
        message,
        sender,
        senderPhone,
        senderName,
        context: extraContext,
        surface,
        media,
      } = body;
      if (!token || !message) {
        return Response.json(
          { error: "token and message are required" },
          { status: 400 }
        );
      }

      const auth = {
        attributes: {
          groupJid: token,
          ...(senderName ? { senderName } : {}),
          ...(senderPhone ? { senderPhone } : {}),
        },
        authenticator: "whatsapp-bridge",
        principalId: sender ?? token,
        principalType: "user",
      } as const;

      const context = buildContext(
        surface,
        token,
        senderName,
        sender,
        extraContext
      );

      // Fresh session per message. getEventStream replays from index 0 and is a
      // live tail that never emits `done`, so we must break on the first
      // `turn.completed` — but on a reused continuation token that first one is
      // a PRIOR turn, returning a stale reply (the same line forever). A unique
      // token gives the stream exactly one turn, so the first `turn.completed`
      // is this message's. Trade-off: no in-thread conversational memory; the
      // agent grounds answers via search-chat, the recent-messages tool, and
      // injected group memory instead. `groupJid` stays the real chat JID in
      // auth attributes, so those tools and memory still resolve.
      const continuationToken = `${token}#${randomUUID()}`;

      const userMessage = buildUserMessage(message, media);
      const session = await send(
        { context, message: userMessage },
        { auth, continuationToken }
      );

      const stream = await session.getEventStream();
      // getEventStream's element type is wider than drainStream's; the cast
      // narrows it to the event shape we consume (getEventStream is compatible).
      const finalMessage = await drainStream(
        stream as ReadableStream<{ type: string; data: { message?: string } }>
      );

      // Deterministic guardrail: the model drifts toward em/en dashes (read as
      // AI-written here) and Markdown emphasis that WhatsApp renders wrong, so
      // normalise on the way out. See cleanReply for the exact rules.
      const reply = cleanReply(finalMessage);

      return Response.json({ reply });
    }),
  ],
});
