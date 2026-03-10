// ---------------------------------------------------------------------------
// Course traversal & text quality utilities
// ---------------------------------------------------------------------------
// Extracted from course-generator.js to reduce monolith size and enable reuse.

import { createId } from "./ids.js";

// ── Course tree traversal ──────────────────────────────────────────────────

/**
 * Traverse all screens in a course structure, calling the callback for each.
 * Callback receives: (screen, indices) where indices = { moduleIndex, sectionIndex, scoIndex, screenIndex }
 */
export function traverseScreens(course, callback) {
  if (!course || !Array.isArray(course.modules)) {
    return;
  }
  for (let moduleIndex = 0; moduleIndex < course.modules.length; moduleIndex += 1) {
    const moduleItem = course.modules[moduleIndex];
    for (let sectionIndex = 0; sectionIndex < (moduleItem.sections || []).length; sectionIndex += 1) {
      const section = moduleItem.sections[sectionIndex];
      for (let scoIndex = 0; scoIndex < (section.scos || []).length; scoIndex += 1) {
        const sco = section.scos[scoIndex];
        for (let screenIndex = 0; screenIndex < (sco.screens || []).length; screenIndex += 1) {
          callback(sco.screens[screenIndex], { moduleIndex, sectionIndex, scoIndex, screenIndex });
        }
      }
    }
  }
}

/**
 * Count total screens in a course structure.
 */
export function countScreens(course) {
  let count = 0;
  traverseScreens(course, () => { count += 1; });
  return count;
}

// ── Text utilities ─────────────────────────────────────────────────────────

export function textKey(value) {
  return `${value || ""}`.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function jaccardSimilarity(a, b) {
  const leftTokens = new Set(textKey(a).split(" ").filter(Boolean));
  const rightTokens = new Set(textKey(b).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function screenTextValue(screen) {
  const textBlocks = Array.isArray(screen?.blocks)
    ? screen.blocks.filter((block) => block?.type === "text" || block?.type === "note").map((block) => `${block?.text || ""}`)
    : [];
  return textBlocks.join(" ").replace(/\s+/g, " ").trim();
}

export function firstSentence(text, fallback) {
  const value = `${text || ""}`.trim();
  if (!value) {
    return fallback;
  }
  const match = value.match(/^(.{40,220}?[.!?])(?:\s|$)/);
  if (match) {
    return match[1].trim();
  }
  return value.slice(0, 220).trim();
}

export function stripExtension(fileName) {
  return `${fileName || ""}`.replace(/\.[^.]+$/, "").trim();
}

export function sentencePoolFromText(text) {
  const cleaned = `${text || ""}`.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return [];
  }

  const parts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^[-*]\s+/, "").trim())
    .filter((part) => part.length >= 30);

  const seen = new Set();
  const unique = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(part.slice(0, 180));
    }
  }

  return unique;
}

export function summarizeChunkForScreen(text, fallback) {
  const sentences = sentencePoolFromText(text);
  if (sentences.length === 0) {
    return {
      text: fallback,
      bullets: ["Key concept", "Practical value", "Immediate next action"]
    };
  }

  const main = sentences.slice(0, 2).join(" ");
  const bullets = sentences.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`Key takeaway ${bullets.length + 1}`);
  }

  return {
    text: main.slice(0, 520),
    bullets
  };
}

export function toBulletItems(text) {
  const cleaned = `${text || ""}`.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return ["Key concept from source", "Practical takeaway", "How to apply at work"];
  }

  const parts = cleaned
    .split(/[.;!?]\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const bullets = parts.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`Key takeaway ${bullets.length + 1}`);
  }
  return bullets;
}

export function rotateList(values, offset) {
  const list = [...values];
  if (list.length === 0) {
    return list;
  }
  const shift = ((offset % list.length) + list.length) % list.length;
  return list.slice(shift).concat(list.slice(0, shift));
}

// ── Quality gate utilities ─────────────────────────────────────────────────

export function containsTemplatePlaceholders(course) {
  const placeholderPattern = /Screen \d+\.?\d*\.?\d*\.?\d* explains/i;
  let found = false;
  traverseScreens(course, (screen) => {
    if (found) return;
    const text = screenTextValue(screen);
    if (placeholderPattern.test(text)) {
      found = true;
    }
  });
  return found;
}

export function evaluateLinePlanQuality(plan) {
  const topics = Array.isArray(plan?.topics) ? plan.topics : [];
  if (topics.length === 0) {
    return { ok: false, reason: "no-topics", lowQualityRatio: 1, uniqueTitleRatio: 0 };
  }

  const genericTopicTextPattern = /^(?:\u043a\u0440\u0430\u0442\u043a\u043e\u0435\s+\u043e\u0431\u044a\u044f\u0441\u043d\u0435\u043d\u0438\u0435\s+\u0442\u0435\u043c\u044b|topic\s+\d+|topic explanation|description of topic)/i;
  let lowQualityTopics = 0;
  const uniqueTitles = new Set();

  for (const topic of topics) {
    const title = `${topic?.title || ""}`.trim().toLowerCase();
    if (title) {
      uniqueTitles.add(title);
    }

    const text = `${topic?.text || ""}`.replace(/\s+/g, " ").trim();
    const tooShort = text.length < 90;
    const generic = !text || genericTopicTextPattern.test(text);
    if (tooShort || generic) {
      lowQualityTopics += 1;
    }
  }

  const lowQualityRatio = lowQualityTopics / topics.length;
  const uniqueTitleRatio = uniqueTitles.size / topics.length;
  const ok = lowQualityRatio <= 0.3 && uniqueTitleRatio >= 0.6;

  return {
    ok,
    reason: ok ? "" : (lowQualityRatio > 0.3 ? "low-topic-quality" : "low-title-uniqueness"),
    lowQualityRatio,
    uniqueTitleRatio
  };
}

export function normalizePlanOptionTexts(options, questionIndex) {
  const base = Array.isArray(options) ? options : [];
  const result = [];
  const seen = new Set();

  for (const option of base) {
    const normalized = `${option || ""}`.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized.slice(0, 160));
    if (result.length >= 4) {
      break;
    }
  }

  while (result.length < 4) {
    result.push(`Option ${result.length + 1} for question ${questionIndex + 1}`);
  }

  return result;
}
