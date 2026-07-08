/**
 * Firecrawl-backed URL reader. The built-in `web_fetch` grabs raw HTML, so it
 * only gets the shell of a JS-rendered page and can't read a PDF at all (an
 * arxiv `/pdf/` link comes back as bytes). Firecrawl renders the page and
 * parses PDFs server-side, handing back clean markdown plus the title — so the
 * agent can actually summarise the thing a member pasted.
 *
 * Needs `FIRECRAWL_API_KEY`. Like the bridge tools, it degrades gracefully:
 * with no key it returns `{ available: false }`, and every bad URL, HTTP error,
 * timeout or empty result comes back as `{ found: false, note }` rather than
 * throwing, so the agent can say why instead of erroring the turn.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CHARS = 60_000;
const API_BASE = "https://api.firecrawl.dev";

/** Firecrawl is only usable when an API key is configured. */
export const firecrawlConfigured = (): boolean =>
  Boolean(process.env.FIRECRAWL_API_KEY);

const apiKey = (): string => process.env.FIRECRAWL_API_KEY ?? "";

/** Scrape base URL; overridable with `FIRECRAWL_API_URL`. */
const apiBase = (): string =>
  (process.env.FIRECRAWL_API_URL ?? API_BASE).trim().replace(/\/+$/u, "");

/** Per-request timeout; overridable with `FIRECRAWL_TIMEOUT_MS`, falls back to 30s. */
const timeoutMs = (): number => {
  const v = Number(process.env.FIRECRAWL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
};

/**
 * Normalise whatever a member pasted into an http(s) URL, prepending `https://`
 * when the scheme is missing. Returns null for anything that isn't a web URL
 * (bare words, mailto:, etc.).
 */
export const normaliseUrl = (input: string): string | null => {
  const s = input.trim();
  if (!s) {
    return null;
  }
  // An explicit non-http(s) scheme (mailto:, ftp:, tel:, …) is never a page to
  // read. The negative lookahead keeps a schemeless `host:port` from looking
  // like a scheme — a port is digits, a scheme name isn't.
  const scheme = /^(?<scheme>[a-z][a-z0-9+.-]*):(?![0-9])/iu
    .exec(s)
    ?.groups?.scheme?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    return null;
  }
  const hasHttp = /^https?:\/\//iu.test(s);
  try {
    const url = new URL(hasHttp ? s : `https://${s}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    // Require a dotted host so a stray word isn't turned into "https://word".
    if (!url.hostname.includes(".")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export interface ScrapeResult {
  /** False only when Firecrawl isn't configured (no API key). */
  available: boolean;
  found: boolean;
  /** Page content as markdown, when found. */
  markdown?: string;
  note?: string;
  /** The URL Firecrawl actually resolved (after redirects), when known. */
  sourceUrl?: string;
  title?: string;
  /** True when `markdown` was cut to `maxChars`. */
  truncated?: boolean;
}

interface ScrapeOptions {
  /** Injectable fetch for tests; defaults to the global. */
  fetch?: typeof fetch;
  /** Cap on returned markdown characters (default 60000). */
  maxChars?: number;
}

interface FirecrawlResponse {
  data?: {
    markdown?: string;
    metadata?: {
      error?: string;
      sourceURL?: string;
      statusCode?: number;
      title?: string;
    };
  };
  error?: string;
  success?: boolean;
}

/**
 * Do the actual Firecrawl call and hand back the parsed body, or a failed
 * `ScrapeResult` (HTTP error / network blip). Split out of `scrapeUrl` to keep
 * each function's branching simple.
 */
const fetchScrape = async (
  url: string,
  doFetch: typeof fetch
): Promise<FirecrawlResponse | ScrapeResult> => {
  try {
    const res = await doFetch(`${apiBase()}/v2/scrape`, {
      body: JSON.stringify({
        formats: ["markdown"],
        onlyMainContent: true,
        url,
      }),
      headers: {
        authorization: `Bearer ${apiKey()}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const detail = raw.trim().slice(0, 200);
      return {
        available: true,
        found: false,
        note: `Couldn't read that page (HTTP ${res.status}${
          detail ? `: ${detail}` : ""
        }).`,
        sourceUrl: url,
      };
    }
    return (await res.json()) as FirecrawlResponse;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      available: true,
      found: false,
      note: `Couldn't reach that page (${reason}).`,
      sourceUrl: url,
    };
  }
};

/** Turn a successful Firecrawl body into a `ScrapeResult`, capping markdown. */
const resultFromBody = (
  body: FirecrawlResponse,
  url: string,
  maxChars: number
): ScrapeResult => {
  if (body.success === false) {
    return {
      available: true,
      found: false,
      note: `Couldn't read that page (${body.error ?? "scrape failed"}).`,
      sourceUrl: url,
    };
  }

  const markdown = body.data?.markdown?.trim() ?? "";
  const meta = body.data?.metadata;
  const sourceUrl = meta?.sourceURL ?? url;
  if (!markdown) {
    return {
      available: true,
      found: false,
      note: meta?.error
        ? `Couldn't read that page (${meta.error}).`
        : "That page came back empty (nothing readable to extract).",
      sourceUrl,
      title: meta?.title,
    };
  }

  const truncated = markdown.length > maxChars;
  return {
    available: true,
    found: true,
    markdown: truncated ? `${markdown.slice(0, maxChars)}…` : markdown,
    sourceUrl,
    title: meta?.title,
    truncated,
  };
};

/**
 * Read a URL through Firecrawl and return its content as markdown. Handles
 * JS-rendered pages and PDFs. Never throws: unrecognised input, a missing key,
 * an HTTP error or an empty scrape all come back as a result with a plain
 * `note`.
 */
export const scrapeUrl = async (
  input: string,
  opts: ScrapeOptions = {}
): Promise<ScrapeResult> => {
  if (!firecrawlConfigured()) {
    return {
      available: false,
      found: false,
      note: "URL reading isn't configured (no Firecrawl key).",
    };
  }

  const url = normaliseUrl(input);
  if (!url) {
    return {
      available: true,
      found: false,
      note: "That doesn't look like a web URL.",
    };
  }

  const body = await fetchScrape(url, opts.fetch ?? fetch);
  if ("found" in body) {
    return body;
  }
  return resultFromBody(body, url, opts.maxChars ?? DEFAULT_MAX_CHARS);
};
