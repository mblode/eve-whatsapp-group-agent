import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { Logger } from "pino";

import type { InviteRequest } from "./invite.js";
import type { FeatureReport } from "./report.js";
import type { Store } from "./store.js";

/**
 * Authenticated read/write HTTP API on the bridge.
 *
 * The bridge captures every group message and shared link into the buffer
 * (store.js). This server lets the eve agent read that buffer back (recap,
 * resources) and read/write per-group memory, via tools that call in here.
 *
 * Every request except GET /health must carry `x-bridge-secret` equal to the
 * shared secret. All responses are JSON.
 */

// 1MB cap on POST bodies.
const MAX_BODY = 1024 * 1024;

/** Write a JSON response with the given status. */
const send = (
  res: ServerResponse,
  status: number,
  obj: unknown
): ServerResponse => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  return res.end(body);
};

/**
 * Constant-time secret check. Hashing both sides to fixed-length sha256 digests
 * keeps `timingSafeEqual` from throwing on length mismatch and stops a caller
 * learning the secret's length (or matching prefix) from response timing.
 */
const secretMatches = (provided: string, expected: string): boolean => {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};

/** Collect a request body, capped at MAX_BODY, and parse it as JSON. */
const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  // oxlint-disable-next-line avoid-new
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

/** Clamp `n` from the query string into [min, max], falling back to `def`. */
const clampN = (
  value: unknown,
  def: number,
  min: number,
  max: number
): number => {
  const n = Number(value ?? def);
  if (!Number.isFinite(n)) {
    return def;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** Handle GET routes that return a list of records (messages, resources, reactions). */
const handleGetRecords = async (
  url: URL,
  store: Store,
  res: ServerResponse
): Promise<ServerResponse | null> => {
  const { pathname } = url;
  const group = url.searchParams.get("group");

  if (pathname === "/messages") {
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const n = clampN(url.searchParams.get("n"), 150, 1, 2000);
    const messages = await store.recentMessages(group, n);
    return send(res, 200, { messages });
  }

  if (pathname === "/resources") {
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const n = clampN(url.searchParams.get("n"), 40, 1, 200);
    const resources = await store.recentResources(group, n);
    return send(res, 200, { resources });
  }

  if (pathname === "/reactions") {
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const n = clampN(url.searchParams.get("n"), 200, 1, 5000);
    const reactions = await store.recentReactions(group, n);
    return send(res, 200, { reactions });
  }

  return null;
};

/** Handle GET/POST /memory routes. */
const handleMemory = async (
  req: IncomingMessage,
  url: URL,
  store: Store,
  logger: Logger,
  res: ServerResponse
): Promise<ServerResponse | null> => {
  const { method, pathname } = { method: req.method, pathname: url.pathname };
  const group = url.searchParams.get("group");

  if (method === "GET" && pathname === "/memory") {
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const memory = await store.readMemory(group);
    return send(res, 200, { memory });
  }

  if (method === "GET" && pathname === "/memory/history") {
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const n = clampN(url.searchParams.get("n"), 100, 1, 1000);
    const history = await store.readMemoryHistory(group, n);
    return send(res, 200, { history });
  }

  if (method === "POST" && pathname === "/memory") {
    const body = await readJson(req);
    const { group: bodyGroup, category, content, by, reason } = body;
    if (typeof bodyGroup !== "string" || !bodyGroup.trim()) {
      return send(res, 400, { error: "group required" });
    }
    if (typeof category !== "string" || !category.trim()) {
      return send(res, 400, { error: "category required" });
    }
    if (typeof content !== "string" || !content.trim()) {
      return send(res, 400, { error: "content required" });
    }
    await store.writeMemory(
      bodyGroup,
      category,
      content,
      by as string | undefined,
      reason as string | undefined
    );
    logger.info({ by, category, group: bodyGroup }, "memory saved");
    return send(res, 200, { saved: true });
  }

  return null;
};

/** Handle export and backfill routes. */
const handleDataOps = async (
  req: IncomingMessage,
  url: URL,
  store: Store,
  logger: Logger,
  onBackfill: ((group: string, n: number) => Promise<object>) | undefined,
  res: ServerResponse
): Promise<ServerResponse | null> => {
  const { pathname } = url;

  // Full stored history for a group (no recent-window cap), so the offline
  // reingest can bake backfilled deep history into the embedded archive.
  if (req.method === "GET" && pathname === "/export") {
    const group = url.searchParams.get("group");
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const messages = await store.allMessages(group);
    return send(res, 200, { messages });
  }

  // Ask WhatsApp for older history in a group (anchored on the oldest message
  // the bridge has seen). Results stream in via messaging-history.set.
  if (req.method === "POST" && pathname === "/backfill") {
    if (typeof onBackfill !== "function") {
      return send(res, 501, { error: "backfill not supported" });
    }
    const body = await readJson(req);
    const group = typeof body.group === "string" ? body.group.trim() : "";
    if (!group) {
      return send(res, 400, { error: "group required" });
    }
    const n = clampN(body.n, 200, 1, 2000);
    try {
      const result = await onBackfill(group, n);
      logger.info({ group, n }, "history backfill requested");
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      return send(res, 409, {
        error: String((error as { message?: unknown })?.message ?? error),
      });
    }
  }

  return null;
};

/** Forward a feature request / bug report to the maintainer. */
type OnReport = (
  report: FeatureReport
) => Promise<{ delivered: boolean; duplicate?: boolean }>;

/** Handle POST /report: forward a feature request or bug report to the maintainer. */
const handleReport = async (
  req: IncomingMessage,
  url: URL,
  logger: Logger,
  onReport: OnReport | undefined,
  res: ServerResponse
): Promise<ServerResponse | null> => {
  if (req.method !== "POST" || url.pathname !== "/report") {
    return null;
  }
  if (typeof onReport !== "function") {
    return send(res, 501, { error: "reporting not supported" });
  }
  const body = await readJson(req);
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  if (!summary) {
    return send(res, 400, { error: "summary required" });
  }
  const kind = body.kind === "bug" ? "bug" : "feature";
  const details =
    typeof body.details === "string" && body.details.trim()
      ? body.details.trim()
      : undefined;
  const requestedBy =
    typeof body.requestedBy === "string" && body.requestedBy.trim()
      ? body.requestedBy.trim()
      : undefined;
  try {
    const result = await onReport({ details, kind, requestedBy, summary });
    logger.info(
      { delivered: result.delivered, kind },
      "feature report received"
    );
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, {
      error: String((error as { message?: unknown })?.message ?? error),
    });
  }
};

/** Forward a member invite / referral to the maintainer. */
type OnInvite = (
  invite: InviteRequest
) => Promise<{ delivered: boolean; duplicate?: boolean }>;

/** A trimmed non-empty string, or undefined — for coercing optional body fields. */
const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Handle POST /invite: forward a member invite / referral to the maintainer. */
const handleInvite = async (
  req: IncomingMessage,
  url: URL,
  logger: Logger,
  onInvite: OnInvite | undefined,
  res: ServerResponse
): Promise<ServerResponse | null> => {
  if (req.method !== "POST" || url.pathname !== "/invite") {
    return null;
  }
  if (typeof onInvite !== "function") {
    return send(res, 501, { error: "inviting not supported" });
  }
  const body = await readJson(req);
  const fullName =
    typeof body.fullName === "string" ? body.fullName.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!fullName || !phone) {
    return send(res, 400, { error: "fullName and phone required" });
  }
  const source = body.source === "contact-card" ? "contact-card" : "form";
  try {
    const result = await onInvite({
      email: optionalString(body.email),
      fullName,
      linkedIn: optionalString(body.linkedIn),
      note: optionalString(body.note),
      phone,
      requestedBy: optionalString(body.requestedBy),
      source,
    });
    logger.info(
      { delivered: result.delivered, source },
      "member invite received"
    );
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, {
      error: String((error as { message?: unknown })?.message ?? error),
    });
  }
};

/** Send a WhatsApp message to an allowlisted maintainer JID. */
type OnSend = (jid: string, text: string) => Promise<{ sent: boolean }>;

/**
 * Handle POST /send: deliver a proactive message to an allowlisted DM. The
 * target allowlist is enforced by the onSend implementation in index.ts, not here.
 */
const handleSend = async (
  req: IncomingMessage,
  url: URL,
  logger: Logger,
  onSend: OnSend | undefined,
  res: ServerResponse
): Promise<ServerResponse | null> => {
  if (req.method !== "POST" || url.pathname !== "/send") {
    return null;
  }
  if (typeof onSend !== "function") {
    return send(res, 501, { error: "sending not supported" });
  }
  const body = await readJson(req);
  const jid = typeof body.jid === "string" ? body.jid.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!jid || !text) {
    return send(res, 400, { error: "jid and text required" });
  }
  try {
    const result = await onSend(jid, text);
    if (!result.sent) {
      return send(res, 403, { error: "jid not allowlisted for sends" });
    }
    logger.info({ jid }, "proactive message sent");
    return send(res, 200, result);
  } catch (error) {
    return send(res, 502, {
      error: String((error as { message?: unknown })?.message ?? error),
    });
  }
};

/** Configuration for the bridge HTTP API. */
export interface StartServerArgs {
  store: Store;
  secret: string;
  port: number;
  logger: Logger;
  getStatus?: () => { whatsapp: string };
  onBackfill?: (group: string, n: number) => Promise<object>;
  onReport?: OnReport;
  onInvite?: OnInvite;
  onSend?: OnSend;
}

/**
 * Start the bridge HTTP API.
 *
 * @param {object} args - Server configuration options.
 * @param {ReturnType<import("./store.js").createStore>} args.store - Message and memory store.
 * @param {string} args.secret - Shared secret guarding every non-health route.
 * @param {number} args.port - Port to listen on.
 * @param {import("pino").Logger} args.logger - Pino logger instance.
 * @param {() => { whatsapp: string }} [args.getStatus] - Current WhatsApp connection state.
 * @param {(group: string, n: number) => Promise<object>} [args.onBackfill] - Request older history.
 * @returns {import("node:http").Server} The HTTP server instance.
 */
export const startServer = ({
  store,
  secret,
  port,
  logger,
  getStatus,
  onBackfill,
  onReport,
  onInvite,
  onSend,
}: StartServerArgs): Server => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    try {
      // Health is unauthenticated so platform probes don't need the secret.
      // Always 200 (process liveness) so a deploy isn't failed while the
      // WhatsApp socket is still pairing/connecting; the `whatsapp` field
      // surfaces the socket state for observability.
      if (req.method === "GET" && url.pathname === "/health") {
        const status = getStatus?.() ?? {};
        return send(res, 200, { ok: true, ...status });
      }

      if (!secret) {
        return send(res, 503, { error: "bridge secret not configured" });
      }
      const headerSecret = req.headers["x-bridge-secret"];
      const provided = Array.isArray(headerSecret)
        ? (headerSecret[0] ?? "")
        : (headerSecret ?? "");
      if (!secretMatches(provided, secret)) {
        return send(res, 401, { error: "unauthorized" });
      }

      logger.debug(
        { method: req.method, path: url.pathname },
        "bridge api request"
      );

      const recordsResult = await handleGetRecords(url, store, res);
      if (recordsResult !== null) {
        return recordsResult;
      }

      const memoryResult = await handleMemory(req, url, store, logger, res);
      if (memoryResult !== null) {
        return memoryResult;
      }

      const dataOpsResult = await handleDataOps(
        req,
        url,
        store,
        logger,
        onBackfill,
        res
      );
      if (dataOpsResult !== null) {
        return dataOpsResult;
      }

      const reportResult = await handleReport(req, url, logger, onReport, res);
      if (reportResult !== null) {
        return reportResult;
      }

      const inviteResult = await handleInvite(req, url, logger, onInvite, res);
      if (inviteResult !== null) {
        return inviteResult;
      }

      const sendResult = await handleSend(req, url, logger, onSend, res);
      if (sendResult !== null) {
        return sendResult;
      }

      return send(res, 404, { error: "not found" });
    } catch (error) {
      logger.error(
        { error, method: req.method, path: url.pathname },
        "bridge api error"
      );
      return send(res, 500, { error: String(error) });
    }
  });

  server.listen(port);
  return server;
};
