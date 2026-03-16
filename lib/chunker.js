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

function looksMetadataParagraph(value) {
  const text = `${value || ""}`.trim();
  if (!text) {
    return false;
  }

  // ISBN, UDK, BBK — bibliographic codes
  if (/ISBN[\s:\-]*[\dXx\-]{10,}/i.test(text)) return true;
  if (/^[УуUu][ДдDd][КкKk]\s*[\d.]+/.test(text)) return true;
  if (/^[БбBb][БбBb][КкKk]\s*[\d.]+/.test(text)) return true;

  // Copyright / publisher info
  if (/©\s*\d{4}/.test(text) && text.length < 200) return true;
  if (/Все\s*права\s*защищены/i.test(text)) return true;
  if (/All\s*rights\s*reserved/i.test(text)) return true;

  // Publisher/printing info
  if (/(?:Издательств[оа]|Типография|Отпечатано\s*в|Тираж\s*\d+)/i.test(text) && text.length < 300) return true;

  // Contact info patterns
  if (/[Сс]вязаться\s+с\s+\S+\s+можно/i.test(text)) return true;

  // Author credentials block (dense regalia without educational content)
  const credentialPatterns = [
    /Член[\-\s]*корреспондент/i,
    /Почетный\s*работник/i,
    /Почётный\s*работник/i,
    /[Нн]аучный\s*редактор/i,
    /[Дд]октор\s*(?:технических|физико|экономических|наук)/i,
    /[Пп]рофессор\s*кафедры/i,
    /[Зз]аслуженный\s*деятель/i,
  ];
  const credentialHits = credentialPatterns.filter(p => p.test(text)).length;
  // If 2+ credential markers AND short text — it's an author bio, not content
  if (credentialHits >= 2 && text.length < 400) return true;

  // Table of contents entries (numbered lines like "Глава 1. ... 15")
  const tocLineCount = (text.match(/^\s*(?:Глава|Раздел|Часть)\s*\d+[\s.]/gim) || []).length;
  if (tocLineCount >= 3) return true;
  // Lines ending with page numbers: "Something ... 42"
  const pageRefLines = (text.match(/\S+\s*\.{2,}\s*\d+\s*$/gm) || []).length;
  if (pageRefLines >= 3) return true;

  return false;
}

function looksGarbledParagraph(value) {
  const text = `${value || ""}`.trim();
  if (!text || text.length < 30) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  let garbledCount = 0;
  for (const word of words) {
    // Detect merged Cyrillic words: single "word" with >20 Cyrillic chars
    const cyrillicRun = word.match(/[\u0400-\u04FF]+/g);
    if (cyrillicRun && cyrillicRun.some(run => run.length > 24)) {
      garbledCount++;
    }
  }

  // If >20% of words look garbled, the paragraph is broken
  return (garbledCount / words.length) > 0.20;
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

    // Filter metadata pages (title, author bios, TOC, publisher info)
    if (looksMetadataParagraph(paragraph)) {
      continue;
    }

    // Filter garbled/merged-word paragraphs
    if (looksGarbledParagraph(paragraph)) {
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

/**
 * Classify a chunk's content type based on pattern analysis.
 * @param {string} text - Chunk text
 * @returns {'code'|'command'|'definition'|'text'}
 */
function classifyChunkType(text) {
  const s = `${text || ""}`.trim();
  if (!s) return "text";

  // Code detection: indented blocks, braces, function/class keywords, semicolons
  const codeSignals = [
    /^\s{2,}(?:def |class |function |const |let |var |import |from |return )/m,
    /[{}]\s*$/m,
    /^\s*(?:if|for|while|try|catch)\s*\(/m,
    /=>\s*[{(]/,
    /\bfunction\s+\w+\s*\(/,
    /^\s*(?:#include|#define|#ifdef)/m,
    /^\s*(?:public|private|protected)\s+(?:static\s+)?\w+/m,
    /^```/m
  ];
  const codeHits = codeSignals.filter(p => p.test(s)).length;
  if (codeHits >= 2) return "code";

  // Command detection: shell commands, CLI invocations
  const commandSignals = [
    /^\s*\$\s+/m,
    /^\s*(?:sudo|apt|pip|npm|yarn|docker|git|cd|ls|mkdir|chmod|curl|wget|roslaunch|rosrun|catkin_make|colcon)\s/m,
    /^\s*(?:rostopic|rosnode|rosmsg|rosparam|rosservice)\s/m,
    /--[a-z][a-z-]+=?/,
    /\|\s*(?:grep|awk|sed|sort|head|tail|wc)/
  ];
  const cmdHits = commandSignals.filter(p => p.test(s)).length;
  if (cmdHits >= 2) return "command";

  // Definition detection: glossary-like patterns
  const defSignals = [
    /^\s*(?:[А-ЯA-Z][а-яa-z]+)\s*[—–-]\s*(?:это|is|are|означает|представляет)/m,
    /^\s*(?:Определение|Definition|Термин|Term)\s*[:.]\s/m,
    /(?:называется|определяется\s+как|is\s+defined\s+as|refers\s+to)/i
  ];
  const defHits = defSignals.filter(p => p.test(s)).length;
  if (defHits >= 1) return "definition";

  return "text";
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

/**
 * Semantic chunking: split text by logical boundaries.
 * Detects headings, code blocks, and topic shifts as chunk boundaries.
 */
function chunkBySemantic(text, options) {
  const lines = text.split("\n");
  const segments = [];
  let currentSegment = [];
  let currentType = "text";

  // Heading patterns
  const headingRe = /^(?:#{1,4}\s+|(?:Глава|Раздел|Часть|Chapter|Part|Section)\s+\d|^\d{1,2}\.\s+[А-ЯA-Z]|\d{1,2}\.\d{1,2}\.?\s+[А-ЯA-Zа-яa-z])/;
  // Code block start/end
  const codeBlockRe = /^```/;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Toggle code blocks
    if (codeBlockRe.test(trimmed)) {
      if (inCodeBlock) {
        // End of code block → finish segment
        currentSegment.push(line);
        segments.push({ text: currentSegment.join("\n"), type: "code" });
        currentSegment = [];
        inCodeBlock = false;
        currentType = "text";
        continue;
      } else {
        // Start of code block → save current, start code
        if (currentSegment.length > 0) {
          segments.push({ text: currentSegment.join("\n"), type: currentType });
          currentSegment = [];
        }
        inCodeBlock = true;
        currentType = "code";
        currentSegment.push(line);
        continue;
      }
    }

    if (inCodeBlock) {
      currentSegment.push(line);
      continue;
    }

    // Heading → new segment
    if (headingRe.test(trimmed) && trimmed.length > 3 && trimmed.length < 120) {
      if (currentSegment.length > 0) {
        segments.push({ text: currentSegment.join("\n"), type: currentType });
        currentSegment = [];
      }
      currentType = "text";
      currentSegment.push(line);
      continue;
    }

    // Double blank line → potential topic shift
    if (trimmed === "" && currentSegment.length > 0) {
      const prevLine = currentSegment[currentSegment.length - 1]?.trim() || "";
      if (prevLine === "" && currentSegment.join("\n").trim().length > options.minChars) {
        segments.push({ text: currentSegment.join("\n"), type: currentType });
        currentSegment = [];
        currentType = "text";
        continue;
      }
    }

    // Command lines → detect command segments
    if (/^\s*(?:\$\s+|sudo\s|apt\s|pip\s|npm\s|docker\s|git\s|ros|catkin)/.test(trimmed)) {
      if (currentType !== "command" && currentSegment.length > 3) {
        segments.push({ text: currentSegment.join("\n"), type: currentType });
        currentSegment = [];
      }
      currentType = "command";
    }

    currentSegment.push(line);

    // If current segment exceeds max, split it
    const currentLength = currentSegment.join("\n").length;
    if (currentLength > options.maxChars * 1.2) {
      segments.push({ text: currentSegment.join("\n"), type: currentType });
      currentSegment = [];
      currentType = "text";
    }
  }

  // Flush remaining
  if (currentSegment.length > 0) {
    segments.push({ text: currentSegment.join("\n"), type: currentType });
  }

  // Post-process: merge tiny segments with neighbors, split oversized ones
  const chunks = [];
  let pendingText = "";
  let pendingType = "text";

  for (const seg of segments) {
    const segText = seg.text.trim();
    if (!segText) continue;

    if (segText.length < options.minChars && segments.length > 1) {
      // Too small — merge with pending
      pendingText += (pendingText ? "\n\n" : "") + segText;
      pendingType = seg.type === "code" ? "code" : pendingType;
      continue;
    }

    // Flush pending first
    if (pendingText) {
      const combined = pendingText + "\n\n" + segText;
      if (combined.length <= options.maxChars) {
        pendingText = combined;
        pendingType = seg.type === "code" ? "code" : pendingType;
        continue;
      } else {
        // Pending too large, emit it
        if (pendingText.length > options.maxChars) {
          // Sub-chunk with sliding window
          const subChunks = chunkBySlidingWindow(pendingText, options);
          chunks.push(...subChunks);
        } else {
          chunks.push({ id: createId("chunk"), order: 0, text: pendingText, _type: pendingType });
        }
        pendingText = segText;
        pendingType = seg.type;
        continue;
      }
    }

    if (segText.length > options.maxChars) {
      // Oversized → sub-chunk with sliding window
      const subChunks = chunkBySlidingWindow(segText, options);
      chunks.push(...subChunks);
    } else {
      pendingText = segText;
      pendingType = seg.type;
    }
  }

  // Final flush
  if (pendingText) {
    if (pendingText.length > options.maxChars) {
      const subChunks = chunkBySlidingWindow(pendingText, options);
      chunks.push(...subChunks);
    } else {
      chunks.push({ id: createId("chunk"), order: 0, text: pendingText, _type: pendingType });
    }
  }

  // Re-number orders
  return chunks.map((chunk, i) => ({
    ...chunk,
    order: i + 1
  }));
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
  
  // Choose chunking strategy
  const useSemantic = options?.semantic !== false; // Semantic by default
  const rawChunks = useSemantic
    ? chunkBySemantic(source, normalized)
    : chunkBySlidingWindow(source, normalized);
  
  const chunks = rawChunks
    .filter((chunk) => chunk.text.length > 0)
    .map((chunk) => ({
      ...chunk,
      length: chunk.text.length,
      type: chunk._type || classifyChunkType(chunk.text)
    }));

  // Remove internal _type field
  for (const chunk of chunks) {
    delete chunk._type;
  }

  if (chunks.length === 0) {
    return [
      {
        id: createId("chunk"),
        order: 1,
        text: trimmedText.slice(0, normalized.maxChars),
        length: Math.min(trimmedText.length, normalized.maxChars),
        type: classifyChunkType(trimmedText.slice(0, normalized.maxChars))
      }
    ];
  }

  return chunks;
}

