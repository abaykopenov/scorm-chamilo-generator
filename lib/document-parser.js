import { 
  TEXT_EXTENSIONS, 
  DOC_EXTENSIONS, 
  PDF_EXTENSIONS, 
  MAX_EXTRACTED_TEXT_CHARS,
  getExtension,
  isTextMime,
  isDocMime,
  isPdfMime
} from "./parser/constants.js";
import { 
  decodeText, 
  stripHtmlTags, 
  normalizeWhitespace, 
  truncateText, 
  tryFixUtf8Mojibake,
  withTempFile
} from "./parser/utils.js";
import { extractPdfTextWithPython } from "./parser/pdf-parser.js";
import { extractOfficeDocumentText } from "./parser/office-parser.js";

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

export async function parseDocumentText({ fileName, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Material file buffer is missing.");
  }

  if (!isSupportedTextMaterial({ fileName, mimeType })) {
    throw new Error(
      `Unsupported format for indexing: ${fileName || "unknown file"}. ` +
      "MVP parser supports txt, md, csv, json, html, xml, docx, doc, odt, rtf and pdf."
    );
  }

  const extension = getExtension(fileName);
  const rawText = await (async () => {
    if (TEXT_EXTENSIONS.has(extension) || isTextMime(mimeType)) {
      return decodeText(buffer);
    }

    if (DOC_EXTENSIONS.has(extension) || isDocMime(mimeType)) {
      return extractOfficeDocumentText({
        fileName,
        mimeType,
        extension,
        buffer,
        withTempFile
      });
    }

    if (PDF_EXTENSIONS.has(extension) || isPdfMime(mimeType)) {
      return withTempFile(buffer, extension || ".pdf", extractPdfTextWithPython);
    }

    return decodeText(buffer);
  })();

  const raw = truncateText(rawText, MAX_EXTRACTED_TEXT_CHARS, fileName || "material");
  const repaired = tryFixUtf8Mojibake(raw);
  const maybeHtml = extension === ".html" || extension === ".htm" || /<html[\s>]/i.test(raw);
  const normalized = normalizeWhitespace(maybeHtml ? stripHtmlTags(repaired) : repaired);

  if (!normalized) {
    throw new Error(`Material ${fileName || "file"} has no extractable text content.`);
  }

  return normalized;
}
