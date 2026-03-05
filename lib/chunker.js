import { createId } from "./ids.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeChunkingOptions(options) {
  const maxChars = clamp(Math.trunc(Number(options?.maxChars) || 1000), 400, 4000);
  const overlapChars = clamp(Math.trunc(Number(options?.overlapChars) || 180), 0, Math.floor(maxChars / 2));
  const minChars = clamp(Math.trunc(Number(options?.minChars) || 160), 80, maxChars);
  return { maxChars, overlapChars, minChars };
}

function cleanParagraphs(text) {
  return `${text || ""}`
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
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
  const trimmedText = `${text || ""}`.trim();
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
