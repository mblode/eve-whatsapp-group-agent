/**
 * Self-contained YouTube transcript fetching, no API key and no extra deps.
 *
 * The flow mirrors what a browser does: load the watch page, pull the embedded
 * `ytInitialPlayerResponse` JSON, read the caption-track list, then fetch the
 * track's `baseUrl` as json3 and flatten it to text. Everything below the
 * network calls is pure (id parsing, JSON extraction, track selection, json3 →
 * segments) so it unit-tests without hitting YouTube.
 *
 * `fetchTranscript` never throws: a bad URL, a video with captions disabled, a
 * login wall, or a network blip all come back as `{ found: false, note }` so
 * the tool can surface a plain reason instead of erroring the turn — matching
 * how the bridge tools degrade.
 */

// A real desktop UA: without it YouTube sometimes serves a stripped page with
// no player response, and the consent cookie skips the EU interstitial.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PAGE_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  cookie: "CONSENT=YES+1",
  "user-agent": USER_AGENT,
} as const;

const DEFAULT_TIMEOUT_MS = 8000;

/** Per-request timeout; overridable with `YOUTUBE_TIMEOUT_MS`, falls back to 8s. */
const timeoutMs = (): number => {
  const v = Number(process.env.YOUTUBE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
};

const ID_RE = /^[\w-]{11}$/u;
const isVideoId = (s: string): boolean => ID_RE.test(s);
const PATH_PREFIXES = new Set(["live", "embed", "shorts", "v"]);

/**
 * Pull an 11-char video id out of whatever a member pasted: a bare id, a
 * `youtu.be/ID` short link, `watch?v=ID`, or a `/live/`, `/embed/`, `/shorts/`,
 * `/v/` path. Returns null when nothing looks like a video.
 */
export const parseVideoId = (input: string): string | null => {
  const s = input.trim();
  if (!s.includes("/") && isVideoId(s)) {
    return s;
  }
  try {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    const host = url.hostname.replace(/^www\./u, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").find(Boolean) ?? "";
      return isVideoId(id) ? id : null;
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = url.searchParams.get("v");
      if (v && isVideoId(v)) {
        return v;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        parts.length >= 2 &&
        PATH_PREFIXES.has(parts[0]) &&
        isVideoId(parts[1])
      ) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * Extract the first balanced `{...}` object that follows `marker` in `text`,
 * parsed as JSON. Brace-matching (string- and escape-aware) beats a regex here
 * because the player response is deeply nested. Returns null if not found or
 * unparseable.
 */
export const extractJsonAfter = (text: string, marker: string): unknown => {
  const at = text.indexOf(marker);
  if (at === -1) {
    return null;
  }
  const start = text.indexOf("{", at);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

export interface CaptionTrack {
  baseUrl?: string;
  kind?: string;
  languageCode?: string;
  name?: { simpleText?: string };
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
  playabilityStatus?: { reason?: string; status?: string };
  videoDetails?: {
    author?: string;
    lengthSeconds?: string;
    title?: string;
  };
}

/**
 * Choose a caption track, preferring the requested language and human-authored
 * captions over YouTube's auto-generated (`kind: "asr"`) ones, then falling
 * back to any track at all. `preferred` is matched as a language-code prefix
 * ("en" matches "en", "en-US", "en-GB").
 */
export const pickCaptionTrack = (
  tracks: CaptionTrack[] | undefined,
  preferred = "en"
): CaptionTrack | null => {
  if (!tracks?.length) {
    return null;
  }
  const pref = preferred.toLowerCase();
  const langMatch = (t: CaptionTrack): boolean =>
    (t.languageCode ?? "").toLowerCase().startsWith(pref);
  return (
    tracks.find((t) => langMatch(t) && t.kind !== "asr") ??
    tracks.find((t) => langMatch(t)) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks[0]
  );
};

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  offset: number;
  text: string;
}

interface Json3Event {
  segs?: { utf8?: string }[];
  tStartMs?: number;
}

/** Flatten YouTube's json3 caption payload into timed text segments. */
export const parseJson3 = (data: unknown): TranscriptSegment[] => {
  const events = (data as { events?: Json3Event[] } | null)?.events ?? [];
  const segments: TranscriptSegment[] = [];
  for (const ev of events) {
    if (!ev.segs) {
      continue;
    }
    const text = ev.segs
      .map((s) => s.utf8 ?? "")
      .join("")
      .replaceAll(/\s+/gu, " ")
      .trim();
    if (text) {
      segments.push({ offset: Math.round((ev.tStartMs ?? 0) / 1000), text });
    }
  }
  return segments;
};

const appendFmtJson3 = (baseUrl: string): string =>
  baseUrl.includes("?") ? `${baseUrl}&fmt=json3` : `${baseUrl}?fmt=json3`;

export interface TranscriptResult {
  author?: string;
  found: boolean;
  /** Language code of the track actually used, e.g. "en", "en-US". */
  lang?: string;
  /** Total length of the video in seconds, when known. */
  lengthSeconds?: number;
  note?: string;
  segments?: TranscriptSegment[];
  /** Full transcript as one whitespace-joined string. */
  text?: string;
  title?: string;
  videoId?: string;
}

interface FetchOptions {
  /** Injectable fetch for tests; defaults to the global. */
  fetch?: typeof fetch;
  /** Preferred caption language-code prefix (default "en"). */
  lang?: string;
}

type Fetch = typeof fetch;

/** Load the watch page and parse out its embedded player response. */
const loadPlayer = async (
  videoId: string,
  doFetch: Fetch
): Promise<PlayerResponse | { note: string }> => {
  let html: string;
  try {
    const res = await doFetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { headers: PAGE_HEADERS, signal: AbortSignal.timeout(timeoutMs()) }
    );
    if (!res.ok) {
      return { note: `Couldn't load the video page (HTTP ${res.status}).` };
    }
    html = await res.text();
  } catch (error) {
    return { note: `Couldn't reach YouTube (${String(error)}).` };
  }
  const player = extractJsonAfter(
    html,
    "ytInitialPlayerResponse"
  ) as PlayerResponse | null;
  return (
    player ?? {
      note: "Couldn't read the video data (YouTube may have changed its page).",
    }
  );
};

/** Fetch a caption track as json3 and flatten it to segments. */
const loadSegments = async (
  baseUrl: string,
  doFetch: Fetch
): Promise<TranscriptSegment[] | { note: string }> => {
  try {
    const res = await doFetch(appendFmtJson3(baseUrl), {
      headers: PAGE_HEADERS,
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) {
      return { note: `Couldn't fetch the captions (HTTP ${res.status}).` };
    }
    const segments = parseJson3(await res.json());
    return segments.length > 0
      ? segments
      : { note: "Captions came back empty for this video." };
  } catch (error) {
    return { note: `Couldn't fetch the captions (${String(error)}).` };
  }
};

const playabilityNote = (player: PlayerResponse): string | null => {
  const status = player.playabilityStatus?.status;
  if (!status || status === "OK") {
    return null;
  }
  const reason = player.playabilityStatus?.reason;
  return reason
    ? `Video isn't playable: ${reason}.`
    : "Video isn't playable (may be private, age-restricted, or removed).";
};

/**
 * Fetch a video's transcript from a URL or id. Returns `found: false` with a
 * human-readable `note` for every failure mode (unrecognised input, page won't
 * load, no captions, login-walled) rather than throwing.
 */
export const fetchTranscript = async (
  input: string,
  opts: FetchOptions = {}
): Promise<TranscriptResult> => {
  const doFetch = opts.fetch ?? fetch;
  const videoId = parseVideoId(input);
  if (!videoId) {
    return {
      found: false,
      note: "That doesn't look like a YouTube URL or video id.",
    };
  }

  const player = await loadPlayer(videoId, doFetch);
  if ("note" in player) {
    return { found: false, note: player.note, videoId };
  }

  const details = player.videoDetails;
  const meta = {
    author: details?.author,
    lengthSeconds: details?.lengthSeconds
      ? Number(details.lengthSeconds)
      : undefined,
    title: details?.title,
    videoId,
  };

  const unplayable = playabilityNote(player);
  if (unplayable) {
    return { ...meta, found: false, note: unplayable };
  }

  const track = pickCaptionTrack(
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks,
    opts.lang
  );
  if (!track?.baseUrl) {
    return {
      ...meta,
      found: false,
      note: "No transcript/captions available for this video.",
    };
  }

  const segments = await loadSegments(track.baseUrl, doFetch);
  if ("note" in segments) {
    return { ...meta, found: false, note: segments.note };
  }
  return {
    ...meta,
    found: true,
    lang: track.languageCode,
    segments,
    text: segments.map((s) => s.text).join(" "),
  };
};
