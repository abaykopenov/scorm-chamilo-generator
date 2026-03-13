import { createId } from "./ids.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeChunkingOptions(options) {
  const maxChars = clamp(Math.trunc(Number(options?.maxChars) || 1000), 400, 4000);
  const overlapChars = clamp(Math.trunc(Number(options?.overlapChars) || 80), 0, Math.floor(maxChars / 3));
  const minChars = clamp(Math.trunc(Number(options?.minChars) || 200), 80, maxChars);
  return { maxChars, overlapChars, minChars };
}

function normalizeChunkSourceText(text) {
  return `${text || ""}`
    .replace(/\r\n?/g, "\n")
    // Fix hyphenated word breaks at line endings: "обуче-\nния" → "обучения"
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    // Fix bare word breaks at line endings: "обучен\nия" → "обучения" (Cyrillic letters across newline)
    .replace(/(\p{L})\s*\n\s*(\p{Ll})/gu, "$1$2")
    // Fix spaces inside words from PDF rendering: "обучен ия" → "обучения"
    .replace(/(\p{Ll})\s+(\p{Ll}{1,3})(?=\s|[.,;:!?)]|$)/gu, (match, left, right) => {
      // Only join if the right part is very short (likely a broken suffix)
      if (right.length <= 3) return left + right;
      return match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeParagraphKey(value) {
  return `${value || ""}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksCorruptedParagraph(value) {
  const text = `${value || ""}`.trim();
  if (!text) {
    return true;
  }

  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters === 0) {
    return true;
  }

  const mojibake = (text.match(/[ÐÑÃ]/g) || []).length;
  const hasUnicodeCyrillic = /[\u0400-\u04FF]/.test(text);
  if (!hasUnicodeCyrillic && (mojibake / letters) >= 0.2) {
    return true;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1 && text.length < 10) {
    return true;
  }

  return false;
}

function cleanParagraphs(text) {
  const normalized = normalizeChunkSourceText(text);
  const rawParagraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const paragraphs = [];
  const seen = new Set();

  for (const part of rawParagraphs) {
    const paragraph = part
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!paragraph || looksCorruptedParagraph(paragraph)) {
      continue;
    }

    const key = normalizeParagraphKey(paragraph);
    if (!key || key.length < 12 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    paragraphs.push(paragraph);
  }

  return paragraphs;
}

function findSoftBreak(text, start, hardEnd, minEnd) {
  const segment = text.slice(start, hardEnd);
  if (!segment) {
    return hardEnd;
  }

  const minOffset = Math.max(0, minEnd - start);
  const separators = ["\n\n", "\n", ". ", "! ", "? ", "; "];

  let best = -1;
  for (const separator of separators) {
    const index = segment.lastIndexOf(separator);
    if (index >= minOffset) {
      best = Math.max(best, index + separator.length);
    }
  }

  if (best <= 0) {
    return hardEnd;
  }

  return start + best;
}

function chunkBySlidingWindow(text, options) {
  const chunks = [];
  const step = Math.max(1, options.maxChars - options.overlapChars);
  let start = 0;
  let guard = 0;

  while (start < text.length) {
    guard += 1;
    if (guard > 2000) {
      break;
    }

    const hardEnd = Math.min(text.length, start + options.maxChars);
    const minEnd = Math.min(hardEnd, start + options.minChars);
    const end = findSoftBreak(text, start, hardEnd, minEnd);
    const body = text.slice(start, end).trim();

    if (body.length > 0) {
      chunks.push({
        id: createId("chunk"),
        order: chunks.length + 1,
        text: body
      });
    }

    if (end >= text.length) {
      break;
    }

    let nextStart = Math.max(start + 1, end - options.overlapChars);

    if (nextStart <= start) {
      nextStart = start + step;
    }

    start = nextStart;
  }

  return chunks;
}

export function chunkText(text, options) {
  const normalized = normalizeChunkingOptions(options);
  const trimmedText = normalizeChunkSourceText(text);
  if (!trimmedText) {
    return [];
  }

  const paragraphs = cleanParagraphs(trimmedText);
  if (paragraphs.length === 0) {
    return [];
  }

  const source = paragraphs.join("\n\n");
  const chunks = chunkBySlidingWindow(source, normalized)
    .filter((chunk) => chunk.text.length > 0)
    .map((chunk) => ({
      ...chunk,
      length: chunk.text.length
    }));

  if (chunks.length === 0) {
    return [
      {
        id: createId("chunk"),
        order: 1,
        text: trimmedText.slice(0, normalized.maxChars),
        length: Math.min(trimmedText.length, normalized.maxChars)
      }
    ];
  }

  return chunks;
}

