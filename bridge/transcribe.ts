/**
 * Speech-to-text for WhatsApp voice notes. The bridge downloads the audio and
 * sends it to an OpenAI-compatible transcription endpoint (OpenAI's
 * `gpt-4o-mini-transcribe` by default, or any compatible API via
 * TRANSCRIBE_BASE_URL / TRANSCRIBE_MODEL), then forwards the text to the agent
 * — mirroring how documents are flattened to text on the bridge. The feature is
 * off unless OPENAI_API_KEY is set, degrading to the plain [audio] placeholder
 * (and "I can't hear audio") exactly as before.
 *
 * The HTTP call is a dependency-free multipart `fetch` (Node's global
 * fetch/FormData/Blob), so there's no SDK to pull in.
 */

/** Minimal logger surface, matching how the bridge's pino logger is used here. */
interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface TranscribeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini-transcribe";

/**
 * Read the transcription config from the environment. Returns null when no
 * OPENAI_API_KEY is set, which is how the caller knows the feature is off.
 */
export const transcribeConfig = (
  env: NodeJS.ProcessEnv = process.env
): TranscribeConfig | null => {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const baseUrl = (env.TRANSCRIBE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/u,
    ""
  );
  const model = env.TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
};

// Map an audio mimetype to a file extension the STT API will recognise.
// WhatsApp voice notes are ogg/opus, which is also the fallback.
const AUDIO_EXT: Record<string, string> = {
  "application/ogg": "ogg",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/m4a": "m4a",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
};

/** Map an audio mimetype to a file extension the STT API will recognise. */
export const audioExtension = (mimetype: string): string => {
  const base = mimetype.split(";")[0].trim().toLowerCase();
  return AUDIO_EXT[base] ?? "ogg";
};

/**
 * Transcribe an audio buffer via the OpenAI-compatible `/audio/transcriptions`
 * endpoint. Returns the trimmed transcript, or null on any failure (network,
 * non-2xx, empty result) so the caller can degrade to the [audio] placeholder.
 */
export const transcribeAudio = async (
  buf: Uint8Array,
  mimetype: string,
  config: TranscribeConfig,
  opts: { logger?: WarnLogger; signal?: AbortSignal } = {}
): Promise<string | null> => {
  const type = mimetype.split(";")[0].trim() || "audio/ogg";
  const form = new FormData();
  const audio = new Uint8Array(buf.byteLength);
  audio.set(buf);
  form.append(
    "file",
    new Blob([audio], { type }),
    `audio.${audioExtension(mimetype)}`
  );
  form.append("model", config.model);
  form.append("response_format", "text");
  try {
    const res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      body: form,
      headers: { authorization: `Bearer ${config.apiKey}` },
      method: "POST",
      signal: opts.signal,
    });
    if (!res.ok) {
      opts.logger?.warn({ status: res.status }, "transcription request failed");
      return null;
    }
    const raw = await res.text();
    const text = raw.trim();
    return text || null;
  } catch (error) {
    opts.logger?.warn({ error }, "transcription request errored");
    return null;
  }
};
