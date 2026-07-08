import type { Logger } from "pino";

/**
 * HTTP client for an eve agent. Forwards an inbound WhatsApp message to the
 * agent's /eve/v1/whatsapp/message endpoint and returns its reply text, with
 * bounded retry/backoff so a transient blip never drops accepted work.
 *
 * Split out of index.ts so the retry policy is one focused, testable unit; the
 * endpoint, secret, timeout, logger and sleep are injected by the caller so this
 * module owns no env or global state.
 */

/** An image downloaded off a message, ready to forward to the agent. */
export interface Media {
  dataUrl: string;
  mime: string;
}

/** Arguments forwarded to the eve agent. */
export interface AskAgentArgs {
  context?: string[];
  media?: Media[];
  message: string;
  sender: string;
  senderName: string | undefined;
  /** The sender's phone-based identity (from senderPn), used for admin checks. */
  senderPhone: string | null;
  surface: string;
  token: string;
}

/** What the agent returned. */
export interface AgentReply {
  reply: string;
}

/** Config for the agent client; injected so the module owns no env/global state. */
export interface AgentClientConfig {
  endpoint: string;
  secret: string;
  timeoutMs: number;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  /** Total attempts on transient failures. Defaults to 3. */
  maxAttempts?: number;
}

/** An error that may carry a `retryable` flag set by askAgent. */
type RetryableError = Error & { retryable?: boolean };

/**
 * Build an `askAgent(args)` bound to the given endpoint/secret/timeout.
 *
 * Transient failures (HTTP 429 / >=500, or network errors where fetch throws)
 * are retried up to `maxAttempts` total attempts with exponential backoff so we
 * never drop accepted work on a blip. Other non-OK statuses (4xx except 429)
 * are not retryable and throw immediately.
 */
export const createAgentClient =
  ({
    endpoint,
    secret,
    timeoutMs,
    logger,
    sleep,
    maxAttempts = 3,
  }: AgentClientConfig): ((args: AskAgentArgs) => Promise<AgentReply>) =>
  async ({
    context,
    media,
    message,
    sender,
    senderName,
    senderPhone,
    surface,
    token,
  }: AskAgentArgs): Promise<AgentReply> => {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential retry: each attempt depends on the previous one failing
        const res = await fetch(endpoint, {
          body: JSON.stringify({
            context,
            media,
            message,
            sender,
            senderName,
            senderPhone,
            surface,
            token,
          }),
          headers: {
            "content-type": "application/json",
            "x-bridge-secret": secret,
          },
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          // oxlint-disable-next-line no-await-in-loop -- sequential: must read response body after checking res.ok
          const data = (await res.json()) as {
            reply?: unknown;
          };
          return {
            reply: typeof data.reply === "string" ? data.reply.trim() : "",
          };
        }

        // oxlint-disable-next-line no-await-in-loop -- sequential: must read error body before deciding to retry
        const detail = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        const err: RetryableError = new Error(
          `eve responded ${res.status}: ${detail}`
        );
        err.retryable = retryable;
        // 4xx (except 429) is a caller/auth problem: fail fast, don't retry.
        if (!retryable) {
          throw err;
        }
        lastErr = err;
      } catch (error) {
        // Non-retryable HTTP errors are tagged so we rethrow without burning
        // the retry budget; everything else (network-level fetch failures, an
        // abort from the timeout, plus retryable HTTP statuses) is safe to retry.
        if ((error as RetryableError)?.retryable === false) {
          throw error;
        }
        if ((error as { name?: string })?.name === "TimeoutError") {
          logger.warn({ attempt, timeoutMs }, "askAgent attempt timed out");
        }
        lastErr = error;
      }

      if (attempt < maxAttempts) {
        // ~500ms, 1000ms, 2000ms, with a little jitter to avoid thundering herds.
        const backoff =
          500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        logger.warn(
          { attempt, backoff, err: lastErr },
          "askAgent retrying after transient failure"
        );
        // oxlint-disable-next-line no-await-in-loop -- sequential backoff: must wait between retry attempts
        await sleep(backoff);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
