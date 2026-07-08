// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { strToU8, zipSync } from "fflate";

import {
  categorizeDocument,
  extractDocumentText,
  formatDocumentContext,
  pdfPageCount,
  xmlToText,
} from "./document.js";

test("categorizeDocument keys off mime then extension", () => {
  assert.equal(categorizeDocument("application/pdf", "a.pdf"), "pdf");
  assert.equal(categorizeDocument(null, "report.pdf"), "pdf");
  assert.equal(categorizeDocument("text/markdown", "PRD.md"), "text");
  assert.equal(
    categorizeDocument("application/octet-stream", "notes.txt"),
    "text"
  );
  assert.equal(categorizeDocument("application/json", "data"), "text");
  assert.equal(categorizeDocument(null, "deck.pptx"), "office");
  assert.equal(categorizeDocument(null, "sheet.xlsx"), "office");
  assert.equal(categorizeDocument(null, "doc.odt"), "office");
  assert.equal(categorizeDocument("image/png", "photo.png"), "binary");
  assert.equal(categorizeDocument(null, "mystery"), "binary");
});

test("extractDocumentText decodes UTF-8 text", () => {
  const buf = strToU8("# Heading\n\nsome notes");
  assert.equal(
    extractDocumentText(buf, "text/markdown", "PRD.md"),
    "# Heading\n\nsome notes"
  );
});

test("extractDocumentText returns null for a NUL-tainted 'text' file", () => {
  // bytes for "hi\0!" — a NUL byte marks it as binary
  const buf = new Uint8Array([0x68, 0x69, 0x00, 0x21]);
  assert.equal(extractDocumentText(buf, "text/plain", "weird.txt"), null);
});

test("extractDocumentText returns null for pdf and unknown binary", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(extractDocumentText(bytes, "application/pdf", "a.pdf"), null);
  assert.equal(extractDocumentText(bytes, "image/png", "a.png"), null);
});

test("extractDocumentText flattens a docx body to text", () => {
  const documentXml =
    '<?xml version="1.0"?><w:document><w:body>' +
    "<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>second line</w:t></w:r></w:p>" +
    "</w:body></w:document>";
  const docx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(documentXml),
  });
  assert.equal(
    extractDocumentText(docx, null, "notes.docx"),
    "Hello world\nsecond line"
  );
});

test("extractDocumentText returns null when the office body is empty/missing", () => {
  const docx = zipSync({ "[Content_Types].xml": strToU8("<Types/>") });
  assert.equal(extractDocumentText(docx, null, "empty.docx"), null);
});

test("xmlToText turns paragraph breaks into newlines and decodes entities", () => {
  assert.equal(
    xmlToText("<w:p><w:t>a &amp; b</w:t></w:p><w:p><w:t>c</w:t></w:p>"),
    "a & b\nc"
  );
});

test("pdfPageCount tallies /Type /Page in a flat (non-object-stream) PDF", () => {
  const pdf = strToU8(
    "%PDF-1.4\n" +
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n" +
      "3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n" +
      "4 0 obj << /Type/Page /Parent 2 0 R >> endobj\n"
  );
  // two /Type /Page objects; the /Type /Pages root must not be counted.
  assert.equal(pdfPageCount(pdf), 2);
});

test("pdfPageCount returns null for an object-stream PDF with no hint", () => {
  // Page objects live inside the compressed /ObjStm, invisible to a flat scan.
  const pdf = strToU8(
    "%PDF-1.7\n5 0 obj << /Type /ObjStm /N 4 >> stream\n…binary…\nendstream\n"
  );
  assert.equal(pdfPageCount(pdf), null);
});

test("pdfPageCount reads /N from a linearized PDF even with object streams", () => {
  const pdf = strToU8(
    "%PDF-1.7\n1 0 obj << /Linearized 1 /N 250 /O 4 >> endobj\n" +
      "2 0 obj << /Type /ObjStm /N 9 >> stream\n…\nendstream\n"
  );
  assert.equal(pdfPageCount(pdf), 250);
});

test("pdfPageCount returns null when there's nothing to read", () => {
  assert.equal(pdfPageCount(strToU8("not a pdf at all")), null);
});

test("formatDocumentContext labels the block with filename and mime", () => {
  assert.equal(
    formatDocumentContext("PRD.md", "text/markdown", "body"),
    'Shared document "PRD.md" (text/markdown):\nbody'
  );
});
