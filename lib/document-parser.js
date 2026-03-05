import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".xml"]);
const DOC_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".rtf"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript"
]);

const DOC_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf"
]);

const PDF_MIME_TYPES = new Set([
  "application/pdf"
]);

const MAX_EXTRACTED_TEXT_CHARS = 350_000;

function decodeText(buffer) {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function stripHtmlTags(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(text) {
  return `${text || ""}`
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function truncateText(text, maxChars, label) {
  const source = `${text || ""}`;
  if (source.length <= maxChars) {
    return source;
  }

  return `${source.slice(0, maxChars)}\n\n[${label} text truncated to ${maxChars} chars]`;
}

function getExtension(fileName) {
  return path.extname(`${fileName || ""}`).toLowerCase();
}

function isTextMime(mimeType) {
  const mime = `${mimeType || ""}`.toLowerCase();
  if (mime.startsWith("text/")) {
    return true;
  }

  return TEXT_MIME_TYPES.has(mime);
}

function isDocMime(mimeType) {
  return DOC_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

function isPdfMime(mimeType) {
  return PDF_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

function withTempFile(buffer, extension, callback) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "rag-material-"));
  const ext = /^[.a-z0-9_-]+$/i.test(`${extension || ""}`) ? extension : ".bin";
  const filePath = path.join(tmpRoot, `input${ext}`);
  writeFileSync(filePath, buffer);

  try {
    return callback(filePath);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function runTextutilToText(filePath) {
  try {
    return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000
    });
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Failed to parse office document via textutil.${details}`);
  }
}

function extractPdfTextWithPython(filePath) {
  const script = [
    "import sys",
    "from Foundation import NSURL",
    "from Quartz import PDFDocument",
    "path = sys.argv[1]",
    "max_chars = int(sys.argv[2])",
    "url = NSURL.fileURLWithPath_(path)",
    "doc = PDFDocument.alloc().initWithURL_(url)",
    "if doc is None:",
    "    raise RuntimeError('PDFDocument init failed')",
    "parts = []",
    "total = 0",
    "for i in range(doc.pageCount()):",
    "    if total >= max_chars:",
    "        break",
    "    page = doc.pageAtIndex_(i)",
    "    if page is None:",
    "        continue",
    "    text = page.string()",
    "    if text:",
    "        piece = str(text)",
    "        remain = max_chars - total",
    "        if remain <= 0:",
    "            break",
    "        if len(piece) > remain:",
    "            piece = piece[:remain]",
    "        parts.append(piece)",
    "        total += len(piece)",
    "print('\\n\\n'.join(parts))"
  ].join("\n");

  try {
    return execFileSync("python3", ["-", filePath, String(MAX_EXTRACTED_TEXT_CHARS)], {
      input: script,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 25_000
    });
  } catch (error) {
    const details = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      "Failed to parse PDF. Python with Quartz/PDFKit is required in this environment." + details
    );
  }
}

export function isSupportedTextMaterial({ fileName, mimeType }) {
  const extension = getExtension(fileName);
  return (
    TEXT_EXTENSIONS.has(extension) ||
    DOC_EXTENSIONS.has(extension) ||
    PDF_EXTENSIONS.has(extension) ||
    isTextMime(mimeType) ||
    isDocMime(mimeType) ||
    isPdfMime(mimeType)
  );
}

export function parseDocumentText({ fileName, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Material file buffer is missing.");
  }

  if (!isSupportedTextMaterial({ fileName, mimeType })) {
    throw new Error(
      `Unsupported format for indexing: ${fileName || "unknown file"}. ` +
      "MVP parser supports txt, md, csv, json, html, xml, docx and pdf."
    );
  }

  const extension = getExtension(fileName);
  const rawText = (() => {
    if (TEXT_EXTENSIONS.has(extension) || isTextMime(mimeType)) {
      return decodeText(buffer);
    }
    if (DOC_EXTENSIONS.has(extension) || isDocMime(mimeType)) {
      return withTempFile(buffer, extension || ".docx", runTextutilToText);
    }
    if (PDF_EXTENSIONS.has(extension) || isPdfMime(mimeType)) {
      return withTempFile(buffer, extension || ".pdf", extractPdfTextWithPython);
    }
    return decodeText(buffer);
  })();

  const raw = truncateText(rawText, MAX_EXTRACTED_TEXT_CHARS, fileName || "material");
  const maybeHtml = extension === ".html" || extension === ".htm" || /<html[\s>]/i.test(raw);
  const normalized = normalizeWhitespace(maybeHtml ? stripHtmlTags(raw) : raw);

  if (!normalized) {
    throw new Error(`Material ${fileName || "file"} has no extractable text content.`);
  }

  return normalized;
}
