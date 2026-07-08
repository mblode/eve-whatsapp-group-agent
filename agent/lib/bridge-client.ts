/**
 * Shared client for the Baileys bridge's authenticated HTTP API
 * (see `bridge/`). The bridge owns the live WhatsApp connection and exposes
 * recent messages, shared links, and per-group memory over HTTP; the tools and
 * memory helpers call it through here so the secret header and base-URL
 * handling live in one place.
 */

const SECRET_HEADER = "x-bridge-secret";

/** True only when both the bridge URL and shared secret are configured. */
export const bridgeConfigured = (): boolean =>
  Boolean(process.env.BRIDGE_URL && process.env.WHATSAPP_BRIDGE_SECRET);

/** Trimmed bridge base URL with any trailing slash stripped. */
const bridgeBase = (): string =>
  (process.env.BRIDGE_URL ?? "").trim().replace(/\/+$/u, "");

const secret = (): string => process.env.WHATSAPP_BRIDGE_SECRET ?? "";

/**
 * Per-request timeout for bridge calls. Without it a hung Railway bridge stalls
 * whatever called in: memory fetch at `session.started` blocks every reply, and
 * the read tools (`get-recent-messages` etc.) hang the turn. Callers already
 * treat a throw as "degrade" (serve base prompt / return unavailable), so an
 * aborted fetch just trips that path within the bound instead of waiting forever.
 * Override with `BRIDGE_TIMEOUT_MS`; falls back to 4s.
 */
const bridgeTimeoutMs = (): number => {
  const v = Number(process.env.BRIDGE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 4000;
};

/**
 * Self-healing retry: a single transient blip (network error, timeout, 429, or
 * 5xx from a Railway bridge that's reconnecting/restarting) gets one quick retry
 * before we let the caller's `catch` degrade the turn. 4xx (a real client/auth
 * problem) and an explicit non-retryable signal fail fast. This is the agent→
 * bridge mirror of the bridge→agent backoff in `bridge/index.js`.
 */
const withRetry = async <T>(attempt: () => Promise<T>): Promise<T> => {
  try {
    return await attempt();
  } catch (error) {
    if ((error as { retryable?: boolean })?.retryable === false) {
      throw error;
    }
    // One short pause, then a single retry.
    // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise-based equivalent
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    return await attempt();
  }
};

/** Throw with a `retryable` flag so `withRetry` knows whether to bother. */
const httpError = (
  method: string,
  path: string,
  status: number
): Error & { retryable: boolean } => {
  const err = new Error(`bridge ${method} ${path} → ${status}`) as Error & {
    retryable: boolean;
  };
  // 4xx (except 429) is a caller/auth problem: don't waste a retry on it.
  err.retryable = status === 429 || status >= 500;
  return err;
};

export const bridgeGet = <T>(path: string): Promise<T> =>
  withRetry(async () => {
    const res = await fetch(`${bridgeBase()}${path}`, {
      headers: { [SECRET_HEADER]: secret() },
      signal: AbortSignal.timeout(bridgeTimeoutMs()),
    });
    if (!res.ok) {
      throw httpError("GET", path, res.status);
    }
    return (await res.json()) as T;
  });

export const bridgePost = <T>(path: string, body: unknown): Promise<T> =>
  withRetry(async () => {
    const res = await fetch(`${bridgeBase()}${path}`, {
      body: JSON.stringify(body),
      headers: {
        [SECRET_HEADER]: secret(),
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(bridgeTimeoutMs()),
    });
    if (!res.ok) {
      throw httpError("POST", path, res.status);
    }
    return (await res.json()) as T;
  });
