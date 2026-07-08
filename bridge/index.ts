// ARCHITECTURE: this is the bridge's orchestrator and its largest file. Two
// cohesive slices are the proven seams to extract if it keeps growing: the
// media-ingestion pipeline (image/doc/audio download + caps + agent envelope)
// and the connection lifecycle (start / reconnect / shutdown). Extract one
// slice at a time, verified against a live socket — not a big-bang split.
import path from "node:path";

import {
  makeWASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import type {
  BaileysEventMap,
  ConnectionState,
  WASocket,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
  proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { createAgentClient } from "./agent-client.js";
import type { Media } from "./agent-client.js";
import { createCacheStore, createSentStore } from "./baileys-cache.js";
import { boundedMap, boundedSet } from "./bounded-set.js";
import {
  categorizeDocument,
  extractDocumentText,
  formatDocumentContext,
  pdfPageCount,
} from "./document.js";
import { buildInviteMessage, inviteDedupKey } from "./invite.js";
import type { InviteRequest } from "./invite.js";
import { createJidQueue } from "./jid-queue.js";
import {
  audioContent,
  classifyMessage,
  documentContent,
  extractText,
  mediaPlaceholder,
  messageTs,
  messageText,
  phoneNumberJid,
  resolveSenderInfo,
} from "./message-parse.js";
import { buildReportMessage, reportDedupKey } from "./report.js";
import type { FeatureReport } from "./report.js";
import { shouldReplyToChat } from "./routing.js";
import { startServer } from "./server.js";
import { createStore, extractUrls } from "./store.js";
import type { Anchors, MessageRecord } from "./store.js";
import { transcribeAudio, transcribeConfig } from "./transcribe.js";
import {
  userPart,
  getContextInfo,
  mentionsBot,
  triggerText,
  extractEdit,
  shouldReplyToEdit,
} from "./trigger.js";
import type { Bot } from "./trigger.js";
import { bindEvents } from "./wa-events.js";
import { createWhitelist } from "./whitelist.js";

const { dirname } = path;

/**
 * WhatsApp <-> eve bridge.
 *
 * Logs into a real WhatsApp account with Baileys, listens to group messages,
 * forwards them to the eve agent's /eve/v1/whatsapp/message endpoint, and posts
 * the agent's reply back into the group.
 *
 * This automates a normal WhatsApp account, which is against WhatsApp's Terms
 * of Service and can get the number banned. Use a dedicated/burner number.
 */

const {
  EVE_URL,
  WHATSAPP_BRIDGE_SECRET,
  AUTH_DIR = "./auth",
  // "mention" (default): reply only when the bot is @-mentioned.
  // "prefix": reply only to messages starting with TRIGGER_PREFIX.
  // "all": reply to every group message (noisy and risky).
  TRIGGER_MODE = "mention",
  TRIGGER_PREFIX = "!bot",
  // Optional comma-separated allowlist of group JIDs. Empty = all groups.
  ALLOWED_GROUPS = "",
  // Name attributed to the bot's own messages in the transcript.
  BOT_NAME = "Robin",
  // Optional: JID (e.g. 61400000000@s.whatsapp.net) the maintainer is DMed at
  // when a member files a feature request / bug report via the agent's
  // report-feature-request tool. Empty = reporting is accepted but not delivered.
  MAINTAINER_JID = "",
  // Optional: phone number in international format with no "+" to pair via code
  // instead of QR (e.g. 15551234567). Easier than scanning a QR from logs.
  PAIRING_NUMBER = "",
  // Where to persist the captured message/resource buffer. Defaults to the
  // parent of AUTH_DIR so it lands on the same Railway volume (/data).
  DATA_DIR = dirname(AUTH_DIR),
  LOG_LEVEL = "info",
  // Port for the bridge's read/write HTTP API. Railway injects PORT.
  PORT = "8080",
  // Vision: forward shared images to the agent so it can see them. Set "false"
  // to turn off. Images bigger than MAX_IMAGE_BYTES (after WhatsApp's own
  // compression) are skipped; Anthropic downsizes large images server-side.
  VISION_ENABLED = "true",
  MAX_IMAGE_BYTES = String(4 * 1024 * 1024),
  // Documents: forward shared files to the agent so it can read them. PDFs ride
  // as a native model file part (like images); text/code and office/OpenDocument
  // files are flattened to text and ride in as an untrusted context block.
  // Set "false" to turn off. Files bigger than MAX_DOC_BYTES are skipped.
  //
  // The cap is 3MB because the agent (eve on Vercel) is a Serverless Function
  // with a hard ~4.5MB request-body limit, and we base64 the file into the JSON
  // body — base64 inflates by 4/3, so 3MB raw ≈ 4MB encoded, comfortably under
  // the limit with room for the other fields. A bigger file would be rejected
  // with a 413 before it ever reached the agent, so we skip it here (keeping the
  // [document] placeholder) rather than fail the reply. Same body path as
  // images, hence the matched envelope.
  DOCS_ENABLED = "true",
  MAX_DOC_BYTES = String(3 * 1024 * 1024),
  // Anthropic rejects PDFs over 100 pages, which fails the whole agent turn. We
  // best-effort count pages and skip past this (keeping the placeholder) so an
  // oversized PDF degrades to "I can see a document" rather than no reply.
  MAX_PDF_PAGES = "100",
  // Audio: transcribe shared voice notes so the agent can answer their content.
  // Set "false" to turn off; also requires OPENAI_API_KEY (see transcribe.ts) —
  // without a key it stays off and audio keeps the [audio] placeholder. Files
  // over MAX_AUDIO_BYTES or longer than MAX_AUDIO_SECONDS are skipped to bound
  // transcription cost (OpenAI accepts up to 25MB per request).
  AUDIO_ENABLED = "true",
  MAX_AUDIO_BYTES = String(16 * 1024 * 1024),
  MAX_AUDIO_SECONDS = "600",
} = process.env;

if (!EVE_URL) {
  throw new Error("EVE_URL is required (e.g. https://your-agent.vercel.app)");
}
if (!WHATSAPP_BRIDGE_SECRET) {
  throw new Error("WHATSAPP_BRIDGE_SECRET is required");
}

const ENDPOINT = new URL("/eve/v1/whatsapp/message", EVE_URL).toString();
const allowedGroups = new Set(
  ALLOWED_GROUPS.split(",")
    .map((g) => g.trim())
    .filter(Boolean)
);

// Abort a forward to the agent that hangs, so a stalled agent can't wedge the
// bridge forever; a timeout counts as a transient failure and burns a retry.
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 40_000;
// Buffer caps. Messages/reactions get a large cap so a history backfill survives;
// resources/memory keep the default. All volume-backed, so they persist.
const MESSAGES_CAP = Number(process.env.MESSAGES_CAP) || 50_000;
const REACTIONS_CAP = Number(process.env.REACTIONS_CAP) || 50_000;
// How long shutdown waits for in-flight message handlers before closing.
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS) || 8000;
// Request WhatsApp's fuller history sync on link (set "false" to opt out).
const SYNC_FULL_HISTORY = process.env.SYNC_FULL_HISTORY !== "false";

const logger = pino({ level: LOG_LEVEL });
const store = createStore(DATA_DIR, {
  messagesCap: MESSAGES_CAP,
  reactionsCap: REACTIONS_CAP,
});
// member phone whitelist (gates 1:1 DMs; groups are already invite-only).
const whitelist = createWhitelist(logger);
// Serialize per-chat message handling so same-chat replies stay in order while
// different chats still run concurrently.
const chatQueue = createJidQueue();
// Recently sent messages + retry counters, so Baileys can answer a recipient's
// decryption-retry receipts (otherwise the recipient is stuck on "Waiting for
// this message"). In-memory: retry receipts arrive within seconds of the send.
const sentStore = createSentStore();
const msgRetryCounterCache = createCacheStore();

/** Download a message's media to a buffer, with the standard reupload options. */
const downloadBuffer = (sock: WASocket, msg: WAMessage): Promise<Buffer> =>
  downloadMediaMessage(
    msg,
    "buffer",
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );

/** Send a text message and remember it so decryption-retry receipts can be answered. */
const sendText = async (
  sock: WASocket,
  jid: string,
  text: string
): Promise<WAMessage | undefined> => {
  const sent = await sock.sendMessage(jid, { text });
  sentStore.record(sent);
  return sent;
};

// Live WhatsApp connection state, surfaced on GET /health for observability.
// "connecting" until the socket first opens; flips to "open"/"close" thereafter.
const health = { whatsapp: "connecting" };

// Live socket + lifecycle state, used by the HTTP API and graceful shutdown.
let currentSock: WASocket | null = null;
let server: ReturnType<typeof startServer> | null = null;
let shuttingDown = false;
let inFlight = 0;
// Oldest-known message per group (id + ts): the anchor for on-demand backfill.
const anchors: Anchors = {};
let anchorsDirty = false;
// Message ids already backfilled this process, so a re-sync doesn't re-store.
const historySeen = boundedSet(100_000);

/**
 * Ask the primary device for older history in a group, anchored on the oldest
 * message we've seen. Results arrive via the messaging-history.set handler.
 * Exposed to the HTTP API as POST /backfill.
 */
const requestBackfill = async (
  group: string,
  count: number
): Promise<{ anchor: string; requested: number }> => {
  if (!currentSock) {
    throw new Error("WhatsApp socket not connected");
  }
  if (typeof currentSock.fetchMessageHistory !== "function") {
    throw new TypeError(
      "fetchMessageHistory unavailable in this Baileys version"
    );
  }
  const anchor = anchors[group];
  if (!anchor?.id) {
    throw new Error("no anchor message yet for this group; let it sync first");
  }
  const key = {
    fromMe: Boolean(anchor.fromMe),
    id: anchor.id,
    remoteJid: group,
  };
  logger.info(
    { anchor: anchor.id, count, group },
    "requesting history backfill"
  );
  await currentSock.fetchMessageHistory(count, key, anchor.ts);
  return { anchor: anchor.id, requested: count };
};

// Bounded set of recently forwarded report keys so the same feature request /
// bug report doesn't DM the maintainer twice. In-memory only: a short window is
// enough, and a restart simply allows a fresh forward.
const REPORTED_CAP = 200;
const reportedKeys = boundedSet(REPORTED_CAP);
// Same idea for member invites: don't DM the maintainer twice for the same
// person (keyed on name + phone digits, see inviteDedupKey).
const invitedKeys = boundedSet(REPORTED_CAP);

/**
 * Forward a feature request / bug report to the maintainer as a WhatsApp DM.
 * Exposed to the HTTP API as POST /report. Dedupes repeats and no-ops cleanly
 * when no maintainer JID is configured.
 */
const sendReport = async (
  report: FeatureReport
): Promise<{ delivered: boolean; duplicate?: boolean }> => {
  if (!MAINTAINER_JID) {
    logger.warn("report received but MAINTAINER_JID is not configured");
    return { delivered: false };
  }
  if (!currentSock) {
    throw new Error("WhatsApp socket not connected");
  }
  const key = reportDedupKey(report);
  if (reportedKeys.has(key)) {
    logger.info({ kind: report.kind }, "duplicate report, not re-sending");
    return { delivered: true, duplicate: true };
  }
  // Mark the key BEFORE awaiting the send so two concurrent identical reports
  // can't both pass the has() check and each DM the maintainer. If delivery
  // fails we drop the key again so a genuine retry can still get through.
  reportedKeys.add(key);
  try {
    await sendText(
      currentSock,
      MAINTAINER_JID,
      buildReportMessage(report, BOT_NAME)
    );
  } catch (error) {
    reportedKeys.delete(key);
    throw error;
  }
  logger.info(
    { from: report.requestedBy, kind: report.kind },
    "feature report forwarded to maintainer"
  );
  return { delivered: true };
};

/**
 * Forward a member invite / referral to the maintainer as a WhatsApp DM.
 * Exposed to the HTTP API as POST /invite. Dedupes repeats (by name + phone)
 * and no-ops cleanly when no maintainer JID is configured.
 */
const sendInvite = async (
  invite: InviteRequest
): Promise<{ delivered: boolean; duplicate?: boolean }> => {
  if (!MAINTAINER_JID) {
    logger.warn("invite received but MAINTAINER_JID is not configured");
    return { delivered: false };
  }
  if (!currentSock) {
    throw new Error("WhatsApp socket not connected");
  }
  const key = inviteDedupKey(invite);
  if (invitedKeys.has(key)) {
    logger.info({ source: invite.source }, "duplicate invite, not re-sending");
    return { delivered: true, duplicate: true };
  }
  // Mark the key BEFORE awaiting the send so two concurrent identical invites
  // can't both DM the maintainer. If delivery fails we drop the key again so a
  // genuine retry can still get through.
  invitedKeys.add(key);
  try {
    await sendText(
      currentSock,
      MAINTAINER_JID,
      buildInviteMessage(invite, BOT_NAME)
    );
  } catch (error) {
    invitedKeys.delete(key);
    throw error;
  }
  logger.info(
    { from: invite.requestedBy, source: invite.source },
    "member invite forwarded to maintainer"
  );
  return { delivered: true };
};

/** Deliver a proactive maintainer DM via POST /send. */
const sendProactive = async (
  jid: string,
  text: string
): Promise<{ sent: boolean }> => {
  const allowed = Boolean(MAINTAINER_JID && jid === MAINTAINER_JID);
  if (!allowed) {
    logger.warn({ jid }, "refusing proactive send to non-allowlisted jid");
    return { sent: false };
  }
  if (!currentSock) {
    throw new Error("WhatsApp socket not connected");
  }
  const sent = await sendText(currentSock, jid, text);
  await store.recordMessage(jid, {
    id: sent?.key?.id ?? undefined,
    n: BOT_NAME,
    role: "assistant",
    s: userPart(currentSock.user?.id ?? ""),
    surface: "dm",
    t: Math.floor(Date.now() / 1000),
    x: text,
  });
  return { sent: true };
};

// Read/write HTTP API the eve agent calls back into (recap, resources, memory).
// Shares this event loop with the Baileys socket. Guarded by WHATSAPP_BRIDGE_SECRET.
server = startServer({
  getStatus: () => health,
  logger,
  onBackfill: requestBackfill,
  onInvite: sendInvite,
  onReport: sendReport,
  onSend: sendProactive,
  port: Number(PORT),
  secret: WHATSAPP_BRIDGE_SECRET,
  store,
});
logger.info({ port: Number(PORT) }, "bridge HTTP API listening");

// Bounded set of recently processed message ids. WhatsApp can redeliver, and the
// retry path means a single id must only ever be processed once. Insertion order
// is preserved by Set, so we evict the oldest (FIFO) once we exceed the cap. The
// set is seeded from disk on boot and flushed back, so a restart/redeploy doesn't
// re-reply to messages WhatsApp redelivers.
const PROCESSED_CAP = 1000;
const processedIds = boundedSet(PROCESSED_CAP);
let processedDirty = 0;

const flushProcessed = async (): Promise<void> => {
  processedDirty = 0;
  try {
    await store.saveProcessedIds([...processedIds.values()]);
  } catch (error) {
    logger.warn({ error }, "failed to persist processed ids");
  }
};

const markProcessed = (id: string): void => {
  processedIds.add(id);
  // Debounce persistence: flush every 10 marks; the timer below catches the rest.
  processedDirty += 1;
  if (processedDirty >= 10) {
    flushProcessed();
  }
};

// Periodic flush of processed ids + backfill anchors. unref so it never holds
// the process open during shutdown.
const flushTimer = setInterval(async () => {
  if (processedDirty) {
    await flushProcessed();
  }
  if (anchorsDirty) {
    anchorsDirty = false;
    try {
      await store.saveAnchors(anchors);
    } catch (error) {
      logger.warn({ error }, "failed to persist anchors");
    }
  }
}, 15_000);
flushTimer.unref();

// Message ids we've already replied to (a fresh @-mention OR an edited-in
// mention), so an edit of an already-answered message can't double-reply.
// In-memory and bounded; a restart could at most allow one extra reply to a
// freshly-edited message, which is harmless.
const REPLIED_CAP = 1000;
const repliedIds = boundedSet(REPLIED_CAP);
const markReplied = (id: string | null | undefined): void => {
  if (!id) {
    return;
  }
  repliedIds.add(id);
};

// Reactions arrive on their own event with no pushName, so the reactor would
// otherwise be a bare user-part id. We learn names from messages (pushName) and
// resolve a reaction's reactor against this map at capture time. In-memory and
// bounded; it refills from incoming messages after a restart, and the agent also
// resolves names at read time, so a miss here just defers to that.
const NAME_CAP = 5000;
const nameByUser = boundedMap<string>(NAME_CAP);
const rememberName = (user: string, name: string | undefined | null): void => {
  const n = name?.trim();
  if (!user || !n) {
    return;
  }
  // boundedMap refreshes recency on set, so eviction is LRU-ish.
  nameByUser.set(user, n);
};

/** The bot's identity from the live socket (phone number + @lid). */
const getBot = (sock: WASocket): Bot => ({
  lid: userPart(sock.user?.lid ?? "") || null,
  number: userPart(sock.user?.id ?? ""),
});

/** Track the oldest known message per group, to anchor on-demand backfill. */
const updateAnchor = (jid: string, msg: WAMessage): void => {
  const ts = messageTs(msg);
  const cur = anchors[jid];
  if (!cur || ts < cur.ts) {
    anchors[jid] = { fromMe: Boolean(msg.key?.fromMe), id: msg.key?.id, ts };
    anchorsDirty = true;
  }
};

/** Dedup a history message id against the seen-set; returns false if already seen. */
const dedupeHistoryMsgId = (msgId: string | null | undefined): boolean => {
  // no id → can't dedup, allow through
  if (!msgId) {
    return true;
  }
  if (historySeen.has(msgId)) {
    return false;
  }
  historySeen.add(msgId);
  return true;
};

/** Record the text/media body of a history message plus any URL resources. */
const recordHistoryBody = async (
  jid: string,
  msg: WAMessage,
  msgId: string,
  isDM: boolean
): Promise<void> => {
  const text = extractText(msg.message);
  const placeholder = mediaPlaceholder(msg.message);
  if (!text && !placeholder) {
    return;
  }
  const ts = messageTs(msg);
  const sender = userPart(msg.key.participant ?? jid);
  const name = msg.pushName ?? undefined;
  rememberName(sender, name);
  const surface = isDM ? "dm" : "group";
  // oxlint-disable-next-line no-await-in-loop -- sequential: each message stored before next to preserve order
  await store.recordMessage(jid, {
    id: msgId,
    n: name,
    role: msg.key.fromMe ? "assistant" : "user",
    s: sender,
    surface,
    t: ts,
    x: text || (placeholder as string),
  });
  for (const url of extractUrls(text)) {
    // oxlint-disable-next-line no-await-in-loop -- sequential: resource records must preserve insertion order
    await store.recordResource(jid, { n: name, s: sender, t: ts, url });
  }
  updateAnchor(jid, msg);
};

/** Record reactions embedded on a history-synced message. */
const recordHistoryReactions = async (
  jid: string,
  reactions: proto.IReaction[],
  msgId: string,
  fallbackTs: number
): Promise<void> => {
  for (const r of reactions) {
    const reactor = userPart(r?.key?.participant ?? r?.key?.remoteJid ?? "");
    if (!reactor || !msgId) {
      continue;
    }
    const rt = Number(r?.senderTimestampMs);
    // oxlint-disable-next-line no-await-in-loop -- sequential: reaction records must preserve insertion order
    await store.recordReaction(jid, {
      emoji: r?.text || "",
      n: nameByUser.get(reactor) ?? null,
      s: reactor,
      t: Number.isFinite(rt) && rt > 0 ? Math.floor(rt / 1000) : fallbackTs,
      target: msgId,
    });
  }
};

/**
 * Record one history-synced message (and any reactions embedded on it) into the
 * buffer. Record-only — history never triggers a reply. Deduped within the
 * process via `historySeen`; downstream consumers (the /export reingest and
 * get-reactions) also dedup by content/reactor, so cross-restart re-syncs stay
 * clean. Reaction backfill is best-effort: WhatsApp includes whatever reactions
 * it has on the synced record, not a guaranteed-complete history.
 */
const recordHistoryMessage = async (msg: WAMessage): Promise<void> => {
  const jid = msg?.key?.remoteJid ?? "";
  const isGroup = jid.endsWith("@g.us");
  const isDM =
    !isGroup &&
    jid !== "" &&
    !jid.endsWith("@broadcast") &&
    !jid.endsWith("@newsletter");
  if (!isGroup && !isDM) {
    return;
  }
  if (isGroup && allowedGroups.size > 0 && !allowedGroups.has(jid)) {
    return;
  }

  const msgId = msg.key?.id;
  if (!dedupeHistoryMsgId(msgId)) {
    return;
  }

  await recordHistoryBody(jid, msg, msgId as string, isDM);

  // Reactions embedded on the synced message (best-effort snapshot at sync time).
  if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
    await recordHistoryReactions(
      jid,
      msg.reactions,
      msgId as string,
      messageTs(msg)
    );
  }
};

const maxImageBytes = Number(MAX_IMAGE_BYTES) || 4 * 1024 * 1024;

/**
 * Download the image on a message and return it as a data URL the agent can
 * hand to the model, or null if there's no image, it's over the size cap, or
 * the download fails. We don't resize: WhatsApp already compresses images and
 * Anthropic downsizes anything large server-side.
 */
const downloadImage = async (
  sock: WASocket,
  msg: WAMessage
): Promise<Media | null> => {
  const image = msg.message?.imageMessage;
  if (!image) {
    return null;
  }
  try {
    const buf = await downloadBuffer(sock, msg);
    if (!buf?.length || buf.length > maxImageBytes) {
      logger.warn(
        { bytes: buf?.length ?? 0, cap: maxImageBytes },
        "image skipped (empty or over size cap)"
      );
      return null;
    }
    const mime = image.mimetype || "image/jpeg";
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, mime };
  } catch (error) {
    logger.warn({ error }, "failed to download image");
    return null;
  }
};

const maxDocBytes = Number(MAX_DOC_BYTES) || 3 * 1024 * 1024;
const maxPdfPages = Number(MAX_PDF_PAGES) || 100;

const maxAudioBytes = Number(MAX_AUDIO_BYTES) || 16 * 1024 * 1024;
const maxAudioSeconds = Number(MAX_AUDIO_SECONDS) || 600;
// Transcription config from the environment (null when OPENAI_API_KEY is
// unset); the STT call is bounded so a slow provider can't wedge a reply.
const transcribeCfg = transcribeConfig();
const TRANSCRIBE_TIMEOUT_MS =
  Number(process.env.TRANSCRIBE_TIMEOUT_MS) || 30_000;
if (transcribeCfg) {
  logger.info(
    { model: transcribeCfg.model },
    "voice-note transcription enabled"
  );
}

/** What a downloaded document turns into for the agent. */
type DocResult =
  // A PDF, handed to the model as a native file part (like an image).
  | { kind: "media"; media: Media }
  // Text we extracted, to ride in as an untrusted context block.
  | { kind: "text"; text: string };

/**
 * Download the document on a message and turn it into something the agent can
 * use: PDFs become a file-part `Media`; text/code and office/OpenDocument files
 * are flattened to a labelled text block. Returns null when there's no document,
 * it's over the size cap, the download fails, or it's an unreadable binary (in
 * which case the transcript keeps the [document] placeholder). Baileys'
 * downloadMediaMessage unwraps documentWithCaptionMessage internally, so the
 * captioned shape downloads fine.
 */
const downloadDocument = async (
  sock: WASocket,
  msg: WAMessage
): Promise<DocResult | null> => {
  const doc = documentContent(msg.message);
  if (!doc) {
    return null;
  }
  const fileName = doc.fileName ?? null;
  const mime = doc.mimetype ?? null;
  try {
    const buf = await downloadBuffer(sock, msg);
    if (!buf?.length || buf.length > maxDocBytes) {
      logger.warn(
        { bytes: buf?.length ?? 0, cap: maxDocBytes, fileName },
        "document skipped (empty or over size cap)"
      );
      return null;
    }
    const kind = categorizeDocument(mime, fileName);
    if (kind === "pdf") {
      // Anthropic caps PDFs at 100 pages; over that the whole turn errors. The
      // count is best-effort (null when we can't tell, e.g. object-stream PDFs),
      // so we only skip on a count we're confident exceeds the cap — erring
      // toward forwarding rather than dropping a readable doc.
      const pages = pdfPageCount(buf);
      if (pages !== null && pages > maxPdfPages) {
        logger.info(
          { cap: maxPdfPages, fileName, pages },
          "pdf skipped (over page cap), keeping placeholder"
        );
        return null;
      }
      const pdfMime = mime || "application/pdf";
      return {
        kind: "media",
        media: {
          dataUrl: `data:${pdfMime};base64,${buf.toString("base64")}`,
          mime: pdfMime,
        },
      };
    }
    const text = extractDocumentText(buf, mime, fileName);
    if (text) {
      return {
        kind: "text",
        text: formatDocumentContext(fileName, mime, text),
      };
    }
    logger.info(
      { fileName, mime },
      "document not readable, keeping placeholder"
    );
    return null;
  } catch (error) {
    logger.warn({ error, fileName }, "failed to download document");
    return null;
  }
};

/**
 * Download the voice note / audio on a message and transcribe it to text via an
 * OpenAI-compatible STT endpoint, mirroring how downloadDocument flattens a doc
 * to text. Returns the transcript, or null when there's no audio, transcription
 * isn't configured, it's over the size/duration cap, or the download/STT fails
 * (in which case the transcript keeps the [audio] placeholder). Claude can't
 * hear audio, so we transcribe here and forward the text.
 */
const downloadAudio = async (
  sock: WASocket,
  msg: WAMessage
): Promise<string | null> => {
  if (!transcribeCfg) {
    return null;
  }
  const audio = audioContent(msg.message);
  if (!audio) {
    return null;
  }
  const seconds = Number(audio.seconds ?? 0);
  if (seconds > maxAudioSeconds) {
    logger.info(
      { cap: maxAudioSeconds, seconds },
      "voice note skipped (over duration cap), keeping placeholder"
    );
    return null;
  }
  try {
    const buf = await downloadBuffer(sock, msg);
    if (!buf?.length || buf.length > maxAudioBytes) {
      logger.warn(
        { bytes: buf?.length ?? 0, cap: maxAudioBytes },
        "voice note skipped (empty or over size cap)"
      );
      return null;
    }
    const mime = audio.mimetype || "audio/ogg";
    const transcript = await transcribeAudio(buf, mime, transcribeCfg, {
      logger,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!transcript) {
      logger.info("voice note transcription empty, keeping placeholder");
    }
    return transcript;
  } catch (error) {
    logger.warn({ error }, "failed to download/transcribe voice note");
    return null;
  }
};

/**
 * Fetch any attachment on a message we're about to reply to: images and PDFs
 * become model file-part `media`; readable text/office docs become an untrusted
 * context block; a voice note is transcribed to text the agent answers as the
 * message. Done only once we know we're replying, so attachments shared in the
 * group don't each cost a fetch.
 */
const collectAttachments = async (
  sock: WASocket,
  msg: WAMessage,
  hasImage: boolean,
  hasDocument: boolean,
  hasAudio: boolean
): Promise<{ media?: Media[]; docContext?: string[]; transcript?: string }> => {
  let media: Media[] | undefined;
  let docContext: string[] | undefined;
  let transcript: string | undefined;
  if (VISION_ENABLED === "true" && hasImage) {
    const img = await downloadImage(sock, msg);
    if (img) {
      media = [img];
    }
  }
  if (DOCS_ENABLED === "true" && hasDocument) {
    const doc = await downloadDocument(sock, msg);
    if (doc?.kind === "media") {
      media = [...(media ?? []), doc.media];
    } else if (doc?.kind === "text") {
      docContext = [doc.text];
    }
  }
  if (AUDIO_ENABLED === "true" && hasAudio) {
    transcript = (await downloadAudio(sock, msg)) ?? undefined;
  }
  return { docContext, media, transcript };
};

/**
 * A neutral anchor when an attachment arrives with no caption, so the agent has
 * something to reply to. Empty string when there's no attachment.
 */
const noCaptionNote = (
  media: Media[] | undefined,
  docContext: string[] | undefined
): string => {
  if (media?.length) {
    return "(media shared with no caption)";
  }
  if (docContext?.length) {
    return "(document shared with no caption)";
  }
  return "";
};

/**
 * Build a "conversation so far" context block from the recent message buffer,
 * so the agent (which runs a fresh, memory-less session per message) can see
 * what was just said in this thread without us reintroducing the stale-reply
 * bug (that lived in the continuation token, not here).
 *
 * `records` are store rows oldest->newest. The LAST row is the current inbound
 * message (recorded before this runs) and is sent separately as `message`, so
 * we drop it to avoid duplicating it. Each remaining row becomes a `Name: text`
 * line; the bot's own lines (role "assistant") are labelled with BOT_NAME.
 * Returns null when there's nothing useful to show.
 */
const buildConversationContext = (
  records: MessageRecord[],
  { surface }: { surface?: string } = {}
): string | null => {
  if (records.length < 2) {
    return null;
  }
  // Drop the last row: it's the current message, already sent as `message`.
  const prior = records.slice(0, -1);
  const lines: string[] = [];
  for (const r of prior) {
    const raw = typeof r.x === "string" ? r.x.trim() : "";
    if (!raw) {
      continue;
    }
    const text = raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
    const who = r.role === "assistant" ? BOT_NAME : r.n || r.s || "someone";
    lines.push(`${who}: ${text}`);
  }
  if (lines.length === 0) {
    return null;
  }
  const header =
    surface === "dm"
      ? "Recent conversation (most recent last), for context only:"
      : "Recent group messages (you only see messages that tag you), most recent last, for context only:";
  return `${header}\n${lines.join("\n")}`;
};

const sleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line avoid-new, no-promise-executor-return -- wraps setTimeout callback API which cannot be awaited directly
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// The HTTP client for the eve agent (retry/backoff lives in agent-client.ts).
const askAgent = createAgentClient({
  endpoint: ENDPOINT,
  logger,
  secret: WHATSAPP_BRIDGE_SECRET,
  sleep,
  timeoutMs: AGENT_TIMEOUT_MS,
});

/** Record an inbound live message body and any extracted URL resources. */
const recordInboundMessage = async (
  jid: string,
  msg: WAMessage,
  msgId: string | null | undefined,
  sender: string,
  senderName: string | undefined,
  ts: number,
  surface: "dm" | "group",
  text: string,
  placeholder: string | null
): Promise<void> => {
  rememberName(sender, senderName);
  await store.recordMessage(jid, {
    id: msgId ?? undefined,
    n: senderName,
    role: "user",
    s: sender,
    surface,
    t: ts,
    x: text || (placeholder as string),
  });
  for (const url of extractUrls(text)) {
    // oxlint-disable-next-line no-await-in-loop -- sequential: resource records must preserve insertion order
    await store.recordResource(jid, { n: senderName, s: sender, t: ts, url });
  }
};

/**
 * Determine whether a live group/DM message should trigger a reply and return
 * the cleaned prompt text (or null to skip). Also logs the per-message debug
 * line and validates the DM whitelist gate.
 * Returns null when the message should not trigger a reply.
 */
const resolveAgentTrigger = (
  msg: WAMessage,
  isDM: boolean,
  isSelfChat: boolean,
  bot: Bot,
  text: string,
  hasImage: boolean,
  hasDocument: boolean,
  hasAudio: boolean,
  jid: string,
  sender: string,
  senderPhone: string | null
): {
  ctx: proto.IContextInfo | null;
  triggeredText: string | null;
} | null => {
  // Pick whether this message reaches the agent. Groups and the account's own
  // self-chat are allowed; other DMs are gated to members (null = no reply; the
  // message is already recorded above, so it's captured but unanswered).
  const ctx = getContextInfo(msg.message);
  const botMentioned = mentionsBot(ctx, bot);
  const allowed = shouldReplyToChat({
    isDM,
    isSelfChat,
    sender,
    senderPhone,
    whitelist,
  });
  if (!allowed) {
    logger.info({ jid, sender, senderPhone }, "ignoring DM from non-member");
    return null;
  }
  // In a DM the whole text is the prompt; strip a literal @-mention token when
  // present so the agent sees clean text (mirrors the group mention path).
  let triggeredText: string | null;
  if (!isDM) {
    triggeredText = triggerText(text, bot, ctx, {
      mode: TRIGGER_MODE,
      prefix: TRIGGER_PREFIX,
    });
  } else if (botMentioned) {
    triggeredText = text.replaceAll(/@\d+/gu, "").trim() || text;
  } else {
    triggeredText = text;
  }
  const isTriggered = isDM
    ? Boolean(text || hasImage || hasDocument || hasAudio)
    : triggeredText !== null;
  logger.debug(
    {
      botLid: bot.lid,
      botNumber: bot.number,
      from: sender,
      hasAudio,
      hasDocument,
      hasImage,
      jid,
      mentioned: (ctx?.mentionedJid ?? []).map(userPart),
      text: text.slice(0, 80),
      triggered: isTriggered,
    },
    "group message"
  );
  if (!isTriggered) {
    return null;
  }
  return { ctx, triggeredText };
};

/** Build context, call the agent, send the reply, and record it in the store. */
const sendAgentReply = async (
  sock: WASocket,
  bot: Bot,
  jid: string,
  prompt: string,
  media: Media[] | undefined,
  sender: string,
  senderName: string | undefined,
  surface: "dm" | "group",
  senderPhone: string | null,
  extraContext?: string[]
): Promise<void> => {
  const context: string[] = [];
  try {
    const recent = await store.recentMessages(jid, 12);
    const block = buildConversationContext(recent, { surface });
    if (block) {
      context.push(block);
    }
  } catch (contextError) {
    logger.warn(
      { err: contextError, jid },
      "failed to build conversation context"
    );
  }
  // Extracted document text (already labelled); the agent fences each block as
  // untrusted, so it reads as data, never instructions.
  if (extraContext?.length) {
    context.push(...extraContext);
  }
  logger.info({ hasMedia: Boolean(media), jid, sender }, "forwarding to agent");
  await sock.sendPresenceUpdate("composing", jid);
  const result = await askAgent({
    context: context.length ? context : undefined,
    media,
    message: prompt,
    sender,
    senderName,
    senderPhone,
    surface,
    token: jid,
  });
  await sock.sendPresenceUpdate("paused", jid);
  const { reply } = result;
  if (reply) {
    const sent = await sendText(sock, jid, reply);
    // Record the bot's own reply so the transcript is two-sided.
    await store.recordMessage(jid, {
      id: sent?.key?.id ?? undefined,
      n: BOT_NAME,
      role: "assistant",
      s: bot.number as string,
      surface,
      t: Math.floor(Date.now() / 1000),
      x: reply,
    });
  }
};

/**
 * Reply to an edited message when the edit added an @-mention of the bot (group
 * only) and we haven't already replied to that message. An edit's new content
 * rides in a protocolMessage / update rather than a fresh message body, so it
 * slips past the normal trigger path; this is the catch for it. Deduped via
 * repliedIds so it can never double-reply, and additive: normal messages are
 * untouched.
 */
const replyToEditIfMentioned = async (
  sock: WASocket,
  bot: Bot,
  jid: string,
  key: WAMessageKey,
  editedContent: proto.IMessage | null | undefined,
  targetId: string | null | undefined,
  senderName: string | undefined
): Promise<void> => {
  const triggeredText = shouldReplyToEdit({
    allowedGroups,
    bot,
    ctx: getContextInfo(editedContent),
    fromMe: key?.fromMe,
    jid,
    mode: TRIGGER_MODE,
    prefix: TRIGGER_PREFIX,
    repliedIds,
    targetId,
    text: extractText(editedContent),
  });
  if (triggeredText === null) {
    return;
  }
  markReplied(targetId);
  if (key?.id) {
    markProcessed(key.id);
  }
  const sender = userPart(key.participant ?? jid);
  // Resolve the phone-based identity from the key (modern WA uses an opaque
  // @lid for participant; the alt key fields carry the real phone) so the
  // agent's admin check works for edits, same as live messages.
  const senderPhone = userPart(phoneNumberJid(key) ?? "") || null;
  logger.info({ jid, targetId }, "replying to an edited-in mention");
  await sendAgentReply(
    sock,
    bot,
    jid,
    triggeredText,
    undefined,
    sender,
    senderName,
    "group",
    senderPhone
  );
};

/**
 * Collect any attachments (image/PDF media, document text, a transcribed voice
 * note), build the prompt to forward (caption / cleaned mention / transcript /
 * no-caption anchor), and dispatch the reply to the agent. Split out of
 * handleUpsertMessage to keep it under the complexity budget. Returns the
 * triggered result, or undefined when there was nothing worth sending.
 */
const collectAndDispatch = async (args: {
  bot: Bot;
  hasAudio: boolean;
  hasDocument: boolean;
  hasImage: boolean;
  isDM: boolean;
  jid: string;
  msg: WAMessage;
  msgId: string | null | undefined;
  sender: string;
  senderName: string | undefined;
  senderPhone: string | null;
  sock: WASocket;
  surface: "dm" | "group";
  text: string;
  triggeredText: string | null;
}): Promise<{ jid: string; triggered: true } | undefined> => {
  const { media, docContext, transcript } = await collectAttachments(
    args.sock,
    args.msg,
    args.hasImage,
    args.hasDocument,
    args.hasAudio
  );
  const prompt =
    (args.isDM ? args.text : args.triggeredText) ||
    transcript ||
    noCaptionNote(media, docContext);
  if (!prompt && !media && !docContext) {
    return;
  }
  await sendAgentReply(
    args.sock,
    args.bot,
    args.jid,
    prompt,
    media,
    args.sender,
    args.senderName,
    args.surface,
    args.senderPhone,
    docContext
  );
  markReplied(args.msgId);
  return { jid: args.jid, triggered: true };
};

/**
 * Handle a single message from messages.upsert. Extracted to reduce complexity
 * of the event handler.
 */
const handleUpsertMessage = async (
  msg: WAMessage,
  sock: WASocket,
  bot: Bot
): Promise<{ jid: string; triggered: true } | undefined> => {
  // Our own identities, so classifyMessage can recognise the account's
  // self-chat (the one place a fromMe message is kept).
  const selfIds = new Set([bot.number, bot.lid].filter(Boolean) as string[]);
  const classification = classifyMessage(msg, allowedGroups, selfIds, (info) =>
    logger.info(info, "inbound non-group message")
  );
  if (!classification) {
    return;
  }
  const { isDM, isSelfChat, jid } = classification;

  // Edits arrive as protocolMessages (no normal text body) and can reuse the
  // original message id, so catch them before the processed-id dedup below.
  const edit = extractEdit(msg.message);
  if (edit) {
    await replyToEditIfMentioned(
      sock,
      bot,
      jid,
      msg.key,
      edit.edited,
      edit.targetId,
      msg.pushName ?? undefined
    );
    return;
  }

  // Idempotency: skip ids we've already handled (redelivery / retry replay).
  // Guard a missing id by simply not deduping that message.
  const msgId = msg.key.id;
  // Loop guard for the self-chat: the bot's own reply is also a fromMe message
  // in the same chat, so it would re-enter here. Skip anything the bridge just
  // sent (recorded in sentStore on every send) before it can re-trigger or be
  // recorded a second time.
  if (msg.key.fromMe && sentStore.get({ id: msgId, remoteJid: jid })) {
    return;
  }
  if (msgId) {
    if (processedIds.has(msgId)) {
      logger.debug({ jid, msgId }, "skipping already-processed message");
      return;
    }
    markProcessed(msgId);
  }

  // Identity/time/surface are computed before the text check so media-only
  // messages can still be recorded into the transcript.
  const { sender, senderName, senderPhone, surface, ts } = resolveSenderInfo(
    msg,
    jid,
    isDM
  );
  updateAnchor(jid, msg);

  // messageText renders a shared contact card (no caption) into readable text so
  // it reaches the agent, which can then extract the details and forward an
  // invite to the maintainer; a plain message is just its caption / body.
  const text = messageText(msg.message);
  const placeholder = mediaPlaceholder(msg.message);
  const hasImage = Boolean(msg.message?.imageMessage);
  const hasDocument = Boolean(documentContent(msg.message));
  const hasAudio = Boolean(audioContent(msg.message));
  // Nothing we can record or act on (e.g. a protocol/system message).
  if (!text && !placeholder) {
    return;
  }

  // Capture every message into the buffer (powers recap + resources)
  // BEFORE any reply gating, so the transcript stays complete even for
  // DMs we won't answer. Caption-less media records as its typed placeholder.
  await recordInboundMessage(
    jid,
    msg,
    msgId,
    sender,
    senderName,
    ts,
    surface,
    text,
    placeholder
  );

  const trigger = resolveAgentTrigger(
    msg,
    isDM,
    isSelfChat,
    bot,
    text,
    hasImage,
    hasDocument,
    hasAudio,
    jid,
    sender,
    senderPhone
  );
  if (!trigger) {
    return;
  }

  const { triggeredText } = trigger;

  // Collect any attachments, build the prompt (caption / transcript / anchor)
  // and forward to the agent.
  return collectAndDispatch({
    bot,
    hasAudio,
    hasDocument,
    hasImage,
    isDM,
    jid,
    msg,
    msgId,
    sender,
    senderName,
    senderPhone,
    sock,
    surface,
    text,
    triggeredText,
  });
};

/** Resolve a unix-second timestamp from a reaction's senderTimestampMs (ms). */
const resolveReactionTs = (
  senderTimestampMs: proto.IReaction["senderTimestampMs"]
): number => {
  const ms = Number(senderTimestampMs);
  return Number.isFinite(ms) && ms > 0
    ? Math.floor(ms / 1000)
    : Math.floor(Date.now() / 1000);
};

/** Process one live reaction item from the messages.reaction event. */
const processReactionItem = async (
  item: BaileysEventMap["messages.reaction"][number]
): Promise<void> => {
  const key = item?.key ?? {};
  const reaction = item?.reaction ?? {};
  const reactorKey = reaction.key ?? {};
  const target = key.id;
  const jid = key.remoteJid ?? reactorKey.remoteJid ?? "";
  if (!target || !jid) {
    return;
  }
  // ignore the bot's own reactions
  if (reactorKey.fromMe) {
    return;
  }
  if (
    jid.endsWith("@g.us") &&
    allowedGroups.size > 0 &&
    !allowedGroups.has(jid)
  ) {
    return;
  }
  const reactor = userPart(
    reactorKey.participant ?? reactorKey.remoteJid ?? ""
  );
  await store.recordReaction(jid, {
    emoji: reaction.text || "",
    n: nameByUser.get(reactor) ?? null,
    s: reactor,
    t: resolveReactionTs(reaction.senderTimestampMs),
    target,
  });
};

/** Send a graceful failure note to the user and record it in the store. */
const sendGracefulFailure = async (
  sock: WASocket,
  bot: Bot,
  triggeredJid: string
): Promise<void> => {
  const note =
    "Something went wrong handling that one - give it a moment and try again.";
  try {
    await sendText(sock, triggeredJid, note);
  } catch (sendError) {
    logger.error(
      { err: sendError, jid: triggeredJid },
      "failed to send graceful failure note"
    );
  }
  // Record the note too, guarded separately so a logging failure can't crash the loop.
  try {
    await store.recordMessage(triggeredJid, {
      n: BOT_NAME,
      role: "assistant",
      s: bot.number as string,
      surface: triggeredJid.endsWith("@g.us") ? "group" : "dm",
      t: Math.floor(Date.now() / 1000),
      x: note,
    });
  } catch (recordError) {
    logger.error(
      { err: recordError, jid: triggeredJid },
      "failed to record graceful failure note"
    );
  }
};

/**
 * A closed connection's error carries the status code Baileys uses to decide
 * whether we were logged out. Baileys wraps it in a Boom error (`.output.statusCode`);
 * we name the shape locally rather than depend on @hapi/boom directly.
 */
type DisconnectError = Error & { output?: { statusCode?: number } };

/** Handle connection.update events on the Baileys socket. */
const handleConnectionUpdate = (update: Partial<ConnectionState>): void => {
  const { connection, lastDisconnect, qr } = update;
  if (qr && !PAIRING_NUMBER) {
    logger.info("Scan this QR code with WhatsApp > Linked devices:");
    qrcode.generate(qr, { small: true });
  }
  if (connection === "open") {
    health.whatsapp = "open";
    logger.info("Connected to WhatsApp.");
  }
  if (connection === "close") {
    health.whatsapp = "close";
    const code = (lastDisconnect?.error as DisconnectError | undefined)?.output
      ?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut;
    logger.warn(
      { code },
      loggedOut ? "logged out" : "connection closed, reconnecting"
    );
    if (!shuttingDown && !loggedOut) {
      // oxlint-disable-next-line prefer-await-to-then, prefer-await-to-callbacks, no-use-before-define -- fire-and-forget in sync event handler; cannot await; start defined later in module order
      start().catch((error) => logger.error({ error }, "reconnect failed"));
    }
  }
};

/** Handle messages.upsert events: route and reply to incoming messages. */
const handleMessagesUpsert = async (
  sock: WASocket,
  { messages, type }: BaileysEventMap["messages.upsert"]
): Promise<void> => {
  if (type !== "notify") {
    return;
  }
  if (shuttingDown) {
    return;
  }
  const bot = getBot(sock);

  // Handle each message on its chat's serial queue: same-chat messages stay in
  // delivery order (enqueued in batch order), different chats run concurrently.
  // inFlight is bumped synchronously so shutdown drains queued work too.
  const pending = messages.map((msg) => {
    const jid = msg.key.remoteJid ?? "";
    inFlight += 1;
    return chatQueue.run(jid, async () => {
      // Track whether this message triggered a reply, so the catch can decide
      // whether the user is owed a graceful failure note (vs silent capture).
      let triggeredJid = "";
      try {
        const result = await handleUpsertMessage(msg, sock, bot);
        if (result?.triggered) {
          triggeredJid = result.jid;
        }
      } catch (error) {
        const sender = userPart(msg.key.participant ?? "");
        logger.error(
          { error, jid, sender, triggered: Boolean(triggeredJid) },
          "failed to handle message"
        );
        // If a triggered message ultimately failed, don't leave the user in
        // silence. Send one short plain line.
        if (triggeredJid) {
          await sendGracefulFailure(sock, bot, triggeredJid);
        }
      } finally {
        inFlight -= 1;
      }
    });
  });
  await Promise.all(pending);
};

/**
 * Handle one messages.update entry: an edit that may @-mention the bot. Queued
 * on the same per-chat queue as upserts so an edited-in mention can't interleave
 * with an in-flight reply for the same chat. No-ops on receipt/status updates
 * with no edited body (the common case).
 */
const queueEditReply = (sock: WASocket, u: WAMessageUpdate): void => {
  const newMsg = u?.update?.message;
  if (!newMsg) {
    return;
  }
  const jid = u.key?.remoteJid ?? "";
  inFlight += 1;
  void chatQueue.run(jid, async () => {
    try {
      const bot = getBot(sock);
      const edit = extractEdit(newMsg);
      const editedContent = edit ? edit.edited : newMsg;
      const targetId = edit ? edit.targetId : u.key?.id;
      await replyToEditIfMentioned(
        sock,
        bot,
        jid,
        u.key,
        editedContent,
        targetId,
        u.update?.pushName ?? undefined
      );
    } catch (error) {
      logger.error({ error }, "failed to handle message update");
    } finally {
      inFlight -= 1;
    }
  });
};

/** Handle messaging-history.set events: backfill older messages into the store. */
const handleHistorySet = async ({
  messages: history,
}: BaileysEventMap["messaging-history.set"]): Promise<void> => {
  if (!Array.isArray(history) || history.length === 0) {
    return;
  }
  logger.info({ count: history.length }, "history sync: backfilling messages");
  for (const msg of history) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential: history messages must be stored in order
      await recordHistoryMessage(msg);
    } catch (error) {
      logger.warn({ error }, "failed to record history message");
    }
  }
  if (anchorsDirty) {
    anchorsDirty = false;
    try {
      await store.saveAnchors(anchors);
    } catch (error) {
      logger.warn({ error }, "failed to persist anchors");
    }
  }
};

const start = async (): Promise<void> => {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      // Cache signal-key reads: the Baileys-recommended production setup, and it
      // reduces the file-store races that can corrupt Signal sessions.
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    // Answer a recipient's decryption-retry receipts by re-supplying the message
    // we sent, so it resolves instead of hanging on "Waiting for this message".
    // Logged so retry-receipt traffic (and store misses) is visible in prod.
    getMessage: (key) => {
      const msg = sentStore.get(key);
      logger.info(
        { hit: Boolean(msg), id: key.id, jid: key.remoteJid },
        "retry receipt: getMessage"
      );
      return Promise.resolve(msg);
    },
    logger,
    markOnlineOnConnect: false,
    msgRetryCounterCache,
    printQRInTerminal: false,
    // Pull WhatsApp's fuller history on link so backfill has something to ingest.
    shouldSyncHistoryMessage: () => true,
    syncFullHistory: SYNC_FULL_HISTORY,
    version,
  });
  currentSock = sock;

  // Pairing-code login (alternative to QR) for first run on a headless host.
  if (PAIRING_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        logger.info(`Pairing code for ${PAIRING_NUMBER}: ${code}`);
      } catch (error) {
        logger.error({ error }, "failed to request pairing code");
      }
    }, 3000);
  }

  // All handlers registered through one typed binder: each arg is typed against
  // Baileys' BaileysEventMap, so payloads get full IntelliSense/compile checks.
  bindEvents(sock, {
    "connection.update": handleConnectionUpdate,
    "creds.update": saveCreds,
    // Emoji reactions arrive on their own event. Capture them so the agent can
    // answer "most liked / most reacted" asks. Reactions never trigger a reply.
    "messages.reaction": async (items) => {
      for (const item of items ?? []) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential: reaction records must preserve insertion order
          await processReactionItem(item);
        } catch (error) {
          logger.error({ error }, "failed to record reaction");
        }
      }
    },
    // Edits delivered via messages.update (some clients/versions deliver the edit
    // here rather than as an upsert). Mirror the upsert edit path so a mention
    // typed in via an edit still triggers a reply.
    "messages.update": (updates) => {
      if (shuttingDown) {
        return;
      }
      for (const u of updates ?? []) {
        queueEditReply(sock, u);
      }
    },
    "messages.upsert": (payload) => handleMessagesUpsert(sock, payload),
    // History sync delivers older messages. Record-only: history never triggers a reply.
    "messaging-history.set": handleHistorySet,
  });
};

/**
 * Drain in-flight handlers, flush state, and close cleanly so a Railway redeploy
 * doesn't drop work or force a QR re-pair. We end() the socket (drops the
 * connection) rather than logout() (which would unlink the device and re-pair).
 */
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down: draining in-flight work");
  const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
  // oxlint-disable-next-line no-unmodified-loop-condition -- inFlight is modified by concurrent async message handlers
  while (inFlight > 0 && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- sequential drain: must poll until in-flight handlers complete
    await sleep(200);
  }
  try {
    await store.saveProcessedIds([...processedIds.values()]);
  } catch (error) {
    logger.warn({ error }, "failed to flush processed ids on shutdown");
  }
  try {
    if (anchorsDirty) {
      await store.saveAnchors(anchors);
    }
  } catch (error) {
    logger.warn({ error }, "failed to flush anchors on shutdown");
  }
  try {
    // oxlint-disable-next-line avoid-new, no-promise-executor-return, prefer-await-to-callbacks -- wraps server.close() callback which cannot be awaited
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  } catch (error) {
    logger.warn({ error }, "error closing HTTP server");
  }
  try {
    currentSock?.end?.(new Error("shutdown"));
  } catch {
    // best-effort
  }
  logger.info("shutdown complete");
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const main = async (): Promise<void> => {
  // Seed cross-restart state so we don't re-reply to redelivered messages and
  // can anchor on-demand backfill from where we left off.
  try {
    for (const id of await store.loadProcessedIds()) {
      processedIds.add(id);
    }
    Object.assign(anchors, await store.loadAnchors());
  } catch (error) {
    logger.warn({ error }, "failed to load persisted state");
  }
  await start();
};

// oxlint-disable-next-line prefer-await-to-then, prefer-await-to-callbacks -- top-level entry; cannot be awaited at module scope
main().catch((error) => {
  logger.error({ error }, "fatal");
  process.exit(1);
});
