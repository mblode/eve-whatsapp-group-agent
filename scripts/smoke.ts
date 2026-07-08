#!/usr/bin/env node
/**
 * End-to-end smoke test for the eve agent over its public HTTP session API.
 *
 * Drives the same `POST /eve/v1/session` + stream contract the dev TUI and the
 * WhatsApp bridge use, so it exercises the *live* agent (real model, real
 * instructions incl. the easter-egg prompt), not a mock. Each message runs as a
 * fresh DM-style session (no group JID), which is exactly the no-jid branch in
 * `agent/instructions.ts`.
 *
 * Targets either a local dev server or the deployed Vercel app:
 *   npm run dev                 # in one terminal (serves http://127.0.0.1:2000)
 *   node scripts/smoke.ts       # default: hits the local dev server
 *   node scripts/smoke.ts --url https://your-agent.vercel.app
 *   EVE_URL=https://… node scripts/smoke.ts "/elon" "what's the meta"
 *
 * With no message args it runs a default sweep of the easter-egg triggers plus
 * a "misfire" check (a normal question that merely mentions a persona name must
 * NOT trigger a persona). Exits non-zero if any reply is empty or errors, so it
 * doubles as a CI/manual gate.
 *
 * No deps: built-in global `fetch` (Node >= 18) and native TS stripping
 * (Node >= 23.6), like the other scripts here. Syntax-check with
 * `node --check scripts/smoke.ts`.
 *
 * Note: if the deployment protects the session API, pass a bearer token via
 * `EVE_AUTH` and it's sent as the `Authorization` header.
 */

// No runtime imports (uses global `fetch`), so mark this an ES module explicitly
// — otherwise `node --check` treats it as CommonJS and skips TS type stripping.

interface StreamEvent {
  type: string;
  data?: { message?: string; error?: unknown };
}

const DEFAULT_URL = "http://127.0.0.1:2000";
const TIMEOUT_MS = 90_000;

// The default sweep: one per easter-egg, then the misfire guard last.
const DEFAULT_MESSAGES = [
  "/elon",
  "/erlich",
  "/richard",
  "/gilfoyle",
  "/factorio",
  "/todo",
  "/ralph",
  "/firsttaste",
  "/nobodyknows",
  "/ultrathink",
  "/slop",
  "/vibecheck",
  "/eggs",
  // Misfire guard: mentions Musk but is a real question -> expect a normal,
  // non-persona answer (or an honest "couldn't confirm"), never an /elon bit.
  "what did elon musk say about grok recently?",
];

const parseArgs = (argv: string[]): { url: string; messages: string[] } => {
  let url = process.env.EVE_URL ?? DEFAULT_URL;
  const messages: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url" || arg === "-u") {
      i += 1;
      url = argv[i] ?? url;
    } else {
      messages.push(arg);
    }
  }
  return { messages, url: url.replace(/\/$/u, "") };
};

const authHeaders = (): Record<string, string> => {
  const token = process.env.EVE_AUTH;
  return token ? { authorization: `Bearer ${token}` } : {};
};

/** Cancel a stream reader, ignoring "already closed" errors. */
const cancelQuietly = async (
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // stream already closed
  }
};

/** Send one message, follow the stream, return the final assistant reply. */
const ask = async (baseUrl: string, message: string): Promise<string> => {
  const created = await fetch(`${baseUrl}/eve/v1/session`, {
    body: JSON.stringify({ message }),
    headers: { "content-type": "application/json", ...authHeaders() },
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!created.ok) {
    throw new Error(`session create failed: ${created.status}`);
  }
  const sessionId = created.headers.get("x-eve-session-id");
  await created.text();
  if (!sessionId) {
    throw new Error("no x-eve-session-id header on session create");
  }

  const stream = await fetch(`${baseUrl}/eve/v1/session/${sessionId}/stream`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!stream.ok || !stream.body) {
    throw new Error(`stream failed: ${stream.status}`);
  }

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  // The session stays open after `turn.completed` (it waits for a follow-up),
  // so we stop on turn/session end rather than blocking for `session.completed`.
  let done = false;
  while (!done) {
    // oxlint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially
    const { value, done: streamDone } = await reader.read();
    if (streamDone) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        continue;
      }
      if (event.type === "message.completed" && event.data?.message) {
        reply = event.data.message;
      }
      if (event.type === "turn.failed" || event.type === "session.failed") {
        throw new Error(`turn failed: ${JSON.stringify(event.data?.error)}`);
      }
      if (
        event.type === "turn.completed" ||
        event.type === "session.waiting" ||
        event.type === "session.completed"
      ) {
        done = true;
      }
    }
  }
  await cancelQuietly(reader);
  return reply.trim();
};

const main = async (): Promise<void> => {
  const { url, messages } = parseArgs(process.argv.slice(2));
  const sweep = messages.length > 0 ? messages : DEFAULT_MESSAGES;
  console.log(
    `smoke: ${url} (${sweep.length} message${sweep.length === 1 ? "" : "s"})\n`
  );

  let failures = 0;
  for (const message of sweep) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- smoke messages run sequentially on purpose
      const reply = await ask(url, message);
      if (!reply) {
        failures += 1;
        console.log(`✗ ${message}\n  (empty reply)\n`);
        continue;
      }
      console.log(`▸ ${message}\n${reply.replaceAll(/^/gmu, "  ")}\n`);
    } catch (error) {
      failures += 1;
      console.log(`✗ ${message}\n  ${(error as Error).message}\n`);
    }
  }

  if (failures > 0) {
    console.error(`${failures}/${sweep.length} failed`);
    process.exit(1);
  }
  console.log(`all ${sweep.length} ok`);
};

// oxlint-disable-next-line prefer-await-to-then, prefer-await-to-callbacks -- top-level script entry point
main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
