import { strFromU8, unzipSync } from "fflate";

/**
 * Pure document-extraction helpers for the WhatsApp bridge. Given a downloaded
 * file's bytes plus its mime/filename, decide what kind of document it is and
 * pull readable text out of it where we can. No socket, no IO — so it's
 * unit-testable without booting Baileys (mirrors message-parse.ts / trigger.ts).
 *
 * The bridge forwards the result two ways: PDFs ride to the model as a native
 * file part (handled in index.ts, not here), while text/code and
 * office/OpenDocument files are flattened to text here and ride in as an
 * untrusted context block. Anything we can't read keeps the [document]
 * placeholder.
 */

/** The lowercase extension of a filename, without the dot ("" if none). */
const extOf = (fileName: string | null | undefined): string => {
  const name = (fileName ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot !== -1 && dot < name.length - 1 ? name.slice(dot + 1) : "";
};

// Office Open XML + OpenDocument containers we unzip and flatten.
const OFFICE_EXTS = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods"]);

// Extensions we treat as plain UTF-8 text/code even when the mime is generic
// (WhatsApp often labels these application/octet-stream).
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "log",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sql",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "php",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "go",
  "rs",
  "swift",
  "sh",
  "bash",
  "zsh",
  "pl",
  "lua",
  "r",
  "dart",
  "vue",
  "svelte",
  "tex",
  "rst",
]);

// Mimes that are textual even though they don't start with "text/".
const TEXT_MIME_RE =
  /^application\/(?:json|xml|.*\+xml|javascript|x-javascript|x-sh|x-yaml|yaml|x-ndjson|sql|toml)/u;

/** Where the readable body lives inside each office/OpenDocument container. */
const officeBodyEntries = (ext: string, names: string[]): string[] => {
  if (ext === "docx") {
    return names.filter((n) => n === "word/document.xml");
  }
  if (ext === "pptx") {
    return names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/u.test(n))
      .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }
  if (ext === "xlsx") {
    return names
      .filter(
        (n) =>
          n === "xl/sharedStrings.xml" ||
          /^xl\/worksheets\/sheet\d+\.xml$/u.test(n)
      )
      .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }
  // odt / odp / ods
  return names.filter((n) => n === "content.xml");
};

/** What flavour of document we're looking at, which decides how we read it. */
export type DocumentKind = "pdf" | "text" | "office" | "binary";

/**
 * Classify a document by mime (preferred) then filename extension. PDFs go to
 * the model as a file part; text/office are flattened to text; everything else
 * is binary we can't read.
 */
export const categorizeDocument = (
  mime: string | null | undefined,
  fileName: string | null | undefined
): DocumentKind => {
  const m = (mime ?? "").toLowerCase();
  const ext = extOf(fileName);
  if (m.includes("pdf") || ext === "pdf") {
    return "pdf";
  }
  if (OFFICE_EXTS.has(ext)) {
    return "office";
  }
  if (m.startsWith("text/") || TEXT_MIME_RE.test(m) || TEXT_EXTS.has(ext)) {
    return "text";
  }
  return "binary";
};

/**
 * Flatten an office/OpenDocument body XML to rough plain text. Paragraph, row
 * and line-break boundaries become newlines; all other tags are dropped and the
 * common XML entities decoded. Best-effort: enough to read/summarise, not a
 * faithful render.
 */
export const xmlToText = (xml: string): string =>
  xml
    .replaceAll(
      /<\/(?:w:p|a:p|text:p|text:h)>|<\/tr>|<w:br\b[^>]*\/?>|<br\b[^>]*\/?>/gu,
      "\n"
    )
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll(/&#(?<dec>\d+);/gu, (_m, dec: string) =>
      String.fromCodePoint(Number(dec))
    )
    .replaceAll("&amp;", "&")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

// Bound the extracted text so a huge doc can't blow the agent's token budget.
const MAX_DOC_TEXT_CHARS = 100_000;

const clampText = (text: string): string =>
  text.length > MAX_DOC_TEXT_CHARS
    ? `${text.slice(0, MAX_DOC_TEXT_CHARS)}\n…[truncated]`
    : text;

/** Decode an office container to text, or null if no readable body is found. */
const extractOfficeText = (buf: Uint8Array, ext: string): string | null => {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    return null;
  }
  const entries = officeBodyEntries(ext, Object.keys(files));
  const parts: string[] = [];
  for (const name of entries) {
    const data = files[name];
    if (!data?.length) {
      continue;
    }
    const text = xmlToText(strFromU8(data));
    if (text) {
      parts.push(text);
    }
  }
  const joined = parts.join("\n\n").trim();
  return joined || null;
};

/**
 * Extract readable text from a document's bytes, or null when there's nothing
 * we can read (PDF — handled as a file part elsewhere — unreadable binary, or an
 * empty office body). `buf` is the raw downloaded file.
 */
export const extractDocumentText = (
  buf: Uint8Array,
  mime: string | null | undefined,
  fileName: string | null | undefined
): string | null => {
  const kind = categorizeDocument(mime, fileName);
  if (kind === "text") {
    // A NUL byte means we were handed a binary mislabelled as text; bail so it
    // keeps the [document] placeholder rather than emitting mojibake.
    if (buf.includes(0)) {
      return null;
    }
    const text = strFromU8(buf).trim();
    return text ? clampText(text) : null;
  }
  if (kind === "office") {
    const text = extractOfficeText(buf, extOf(fileName));
    return text ? clampText(text) : null;
  }
  return null;
};

/**
 * Best-effort PDF page count from the raw bytes, or null when we can't tell.
 *
 * Anthropic rejects PDFs over 100 pages and that fails the whole agent turn, so
 * the bridge uses this to skip oversized PDFs (keeping the [document]
 * placeholder) instead of dropping the reply. It is deliberately conservative:
 * a flat byte scan can't see page objects packed into compressed object streams
 * (`/ObjStm`), so when those are present we return null ("unknown") rather than
 * an undercount — callers must not skip on null, only on a count they trust.
 * This is not a PDF parser; it's just enough to catch the obvious big ones.
 */
export const pdfPageCount = (buf: Uint8Array): number | null => {
  // Decode as latin1 so PDF's ASCII structure tokens map 1:1 to chars without
  // mangling the surrounding binary (UTF-8 decoding would corrupt offsets).
  const s = Buffer.from(buf).toString("latin1");
  // Object streams hide page objects from a flat scan, so tallying `/Type /Page`
  // would undercount; skip straight to the linearization hint or give up.
  const usesObjectStreams = /\/Type\s*\/ObjStm\b/u.test(s);
  if (!usesObjectStreams) {
    // Page objects are `<< … /Type /Page … >>`; the negative lookahead keeps us
    // off the page-tree root `/Type /Pages`.
    const pages = s.match(/\/Type\s*\/Page(?![a-zA-Z])/gu);
    if (pages && pages.length > 0) {
      return pages.length;
    }
  }
  // Linearized ("fast web view") PDFs carry the total page count as `/N` in the
  // first-object dict — readable even when the body uses object streams.
  const linearized = /\/Linearized\b[^>]*?\/N\s+(?<n>\d+)/su.exec(s);
  if (linearized?.groups?.n) {
    return Number(linearized.groups.n);
  }
  return null;
};

/**
 * Label extracted text with its filename + mime so the agent knows what it's
 * reading once the bridge fences it as an untrusted context block.
 */
export const formatDocumentContext = (
  fileName: string | null | undefined,
  mime: string | null | undefined,
  text: string
): string => {
  const name = (fileName ?? "").trim() || "file";
  const type = (mime ?? "").trim();
  const header = type
    ? `Shared document "${name}" (${type}):`
    : `Shared document "${name}":`;
  return `${header}\n${text}`;
};
