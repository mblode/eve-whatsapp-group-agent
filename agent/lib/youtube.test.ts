import { describe, expect, it } from "vitest";

import {
  extractJsonAfter,
  fetchTranscript,
  parseJson3,
  parseVideoId,
  pickCaptionTrack,
} from "./youtube.js";

describe("video id parsing", () => {
  it("accepts a bare 11-char id", () => {
    expect(parseVideoId("mQ9-YoE9ykE")).toBe("mQ9-YoE9ykE");
  });

  it("pulls the id from common URL shapes", () => {
    const id = "mQ9-YoE9ykE";
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42s`,
      `https://youtu.be/${id}?si=lbu_1YSatwsdae6b`,
      `https://www.youtube.com/live/${id}?si=abc`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `youtube.com/watch?v=${id}`,
    ]) {
      expect(parseVideoId(url)).toBe(id);
    }
  });

  it("returns null for non-YouTube or malformed input", () => {
    expect(parseVideoId("https://vimeo.com/12345")).toBeNull();
    expect(parseVideoId("just some text")).toBeNull();
    expect(parseVideoId("https://youtube.com/watch?v=tooshort")).toBeNull();
  });
});

describe("balanced JSON extraction", () => {
  it("extracts a balanced object after the marker, ignoring braces in strings", () => {
    const html = `<script>var ytInitialPlayerResponse = {"a":1,"s":"a } b","n":{"x":2}};</script>`;
    expect(extractJsonAfter(html, "ytInitialPlayerResponse")).toStrictEqual({
      a: 1,
      n: { x: 2 },
      s: "a } b",
    });
  });

  it("returns null when the marker is absent or unparseable", () => {
    expect(
      extractJsonAfter("nothing here", "ytInitialPlayerResponse")
    ).toBeNull();
    expect(
      extractJsonAfter(
        "ytInitialPlayerResponse = {bad",
        "ytInitialPlayerResponse"
      )
    ).toBeNull();
  });
});

describe("caption track selection", () => {
  const en = { baseUrl: "u-en", kind: undefined, languageCode: "en" };
  const enAsr = { baseUrl: "u-en-asr", kind: "asr", languageCode: "en" };
  const fr = { baseUrl: "u-fr", languageCode: "fr" };

  it("prefers human-authored captions in the requested language", () => {
    expect(pickCaptionTrack([enAsr, en, fr], "en")).toBe(en);
  });

  it("falls back to auto-generated when that's all the language has", () => {
    expect(pickCaptionTrack([enAsr, fr], "en")).toBe(enAsr);
  });

  it("falls back to any track when the language is missing", () => {
    expect(pickCaptionTrack([fr], "en")).toBe(fr);
  });

  it("returns null for no tracks", () => {
    expect(pickCaptionTrack([], "en")).toBeNull();
  });
});

describe("json3 flattening", () => {
  it("flattens events into timed, whitespace-normalised segments", () => {
    const data = {
      events: [
        { segs: [{ utf8: "hello " }, { utf8: "world" }], tStartMs: 0 },
        // whitespace-only and seg-less events are dropped
        { segs: [{ utf8: "\n" }] },
        { tStartMs: 5000 },
        { segs: [{ utf8: "next  line" }], tStartMs: 5200 },
      ],
    };
    expect(parseJson3(data)).toStrictEqual([
      { offset: 0, text: "hello world" },
      { offset: 5, text: "next line" },
    ]);
  });

  it("handles missing/empty input", () => {
    expect(parseJson3(null)).toStrictEqual([]);
    expect(parseJson3({})).toStrictEqual([]);
  });
});

describe("end-to-end transcript fetching", () => {
  const id = "mQ9-YoE9ykE";
  const playerJson = JSON.stringify({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: "https://yt/caps?v=1", languageCode: "en" }],
      },
    },
    playabilityStatus: { status: "OK" },
    videoDetails: {
      author: "Some Channel",
      lengthSeconds: "610",
      title: "A debate",
    },
  });
  const watchHtml = `<html><script>var ytInitialPlayerResponse = ${playerJson};</script></html>`;
  const json3 = {
    events: [
      { segs: [{ utf8: "I think I fall in the middle" }], tStartMs: 0 },
      { segs: [{ utf8: "somewhere" }], tStartMs: 3000 },
    ],
  };

  const mockFetch = (handlers: {
    caps?: () => Response;
    watch?: () => Response;
  }): typeof fetch =>
    ((url: string) => {
      if (url.includes("/watch")) {
        return Promise.resolve(
          handlers.watch?.() ??
            ({ ok: true, text: () => Promise.resolve(watchHtml) } as Response)
        );
      }
      return Promise.resolve(
        handlers.caps?.() ??
          ({ json: () => Promise.resolve(json3), ok: true } as Response)
      );
    }) as typeof fetch;

  it("returns the title, channel and joined transcript on success", async () => {
    const res = await fetchTranscript(`https://youtu.be/${id}`, {
      fetch: mockFetch({}),
    });
    expect(res).toMatchObject({
      author: "Some Channel",
      found: true,
      lang: "en",
      lengthSeconds: 610,
      text: "I think I fall in the middle somewhere",
      title: "A debate",
      videoId: id,
    });
  });

  it("rejects an unrecognisable input without fetching", async () => {
    let called = false;
    const res = await fetchTranscript("not a video", {
      fetch: (() => {
        called = true;
        return Promise.resolve({} as Response);
      }) as typeof fetch,
    });
    expect(res.found).toBeFalsy();
    expect(called).toBeFalsy();
  });

  it("reports when no captions are available, keeping the title", async () => {
    const noCaps = JSON.stringify({
      playabilityStatus: { status: "OK" },
      videoDetails: { title: "Silent film" },
    });
    const res = await fetchTranscript(id, {
      fetch: mockFetch({
        watch: () =>
          ({
            ok: true,
            text: () =>
              Promise.resolve(
                `<script>ytInitialPlayerResponse = ${noCaps};</script>`
              ),
          }) as Response,
      }),
    });
    expect(res.found).toBeFalsy();
    expect(res.title).toBe("Silent film");
    expect(res.note).toMatch(/no transcript/iu);
  });

  it("reports an unplayable video with its reason", async () => {
    const walled = JSON.stringify({
      playabilityStatus: {
        reason: "Sign in to confirm your age",
        status: "LOGIN_REQUIRED",
      },
      videoDetails: { title: "Age gated" },
    });
    const res = await fetchTranscript(id, {
      fetch: mockFetch({
        watch: () =>
          ({
            ok: true,
            text: () =>
              Promise.resolve(
                `<script>ytInitialPlayerResponse = ${walled};</script>`
              ),
          }) as Response,
      }),
    });
    expect(res.found).toBeFalsy();
    expect(res.note).toMatch(/Sign in to confirm/iu);
  });

  it("degrades gracefully on an HTTP error from the watch page", async () => {
    const res = await fetchTranscript(id, {
      fetch: mockFetch({
        watch: () => ({ ok: false, status: 429 }) as Response,
      }),
    });
    expect(res.found).toBeFalsy();
    expect(res.note).toMatch(/429/u);
  });
});
