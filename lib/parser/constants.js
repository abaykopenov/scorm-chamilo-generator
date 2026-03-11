import path from "node:path";

export const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".xml"]);
export const DOC_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".rtf"]);
export const PDF_EXTENSIONS = new Set([".pdf"]);

export const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript"
]);

export const DOC_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf"
]);

export const PDF_MIME_TYPES = new Set([
  "application/pdf"
]);

export const MAX_EXTRACTED_TEXT_CHARS = 350_000;
export const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const ODT_MIME_TYPE = "application/vnd.oasis.opendocument.text";
export const RTF_MIME_TYPES = new Set(["application/rtf", "text/rtf"]);

export function getExtension(fileName) {
  return path.extname(`${fileName || ""}`).toLowerCase();
}

export function isTextMime(mimeType) {
  const mime = `${mimeType || ""}`.toLowerCase();
  return mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime);
}

export function isDocMime(mimeType) {
  return DOC_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

export function isPdfMime(mimeType) {
  return PDF_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

export function isDocxMaterial(extension, mimeType) {
  return extension === ".docx" || `${mimeType || ""}`.toLowerCase() === DOCX_MIME_TYPE;
}

export function isOdtMaterial(extension, mimeType) {
  return extension === ".odt" || `${mimeType || ""}`.toLowerCase() === ODT_MIME_TYPE;
}

export function isRtfMaterial(extension, mimeType) {
  return extension === ".rtf" || RTF_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}
