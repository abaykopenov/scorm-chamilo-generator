// ---------------------------------------------------------------------------
// lib/generation/quality-checks.js — Screen and course quality evaluation
// ---------------------------------------------------------------------------
import { jaccardSimilarity } from "../course-utils.js";
import {
  cleanEvidenceText,
  looksNoisyEvidence,
  looksGarbledText,
  hasEvidenceGrounding
} from "./evidence-helpers.js";

export function hasBadFormatting(value) {
  const text = `${value || ""}`;
  if (!text) return false;
  if (/(?:\b|\s)(?:\p{L}\s){3,}\p{L}(?:\b|\s)/u.test(text)) {
    return true;
  }
  if (/(\p{So}|\p{Sc}|\p{Sm}){5,}/u.test(text) || /[<>{}~`\\]{5,}/.test(text)) {
    return true;
  }
  const cjkTokens = (text.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  if (cjkTokens > 15) {
    return true;
  }
  return false;
}

export function evaluateDeepScreenQuality({ bodyLong, evidencePack, previousBody, minChars }) {
  const text = `${bodyLong || ""}`.trim();
  const problems = [];

  if (text.length < minChars) {
    problems.push({
      code: "too-short",
      severity: "critical",
      detail: `Текст ${text.length} символов, минимум ${minChars}. Экран должен содержать развёрнутый учебный материал.`
    });
  }

  if (looksGarbledText(text)) {
    problems.push({
      code: "garbled-text",
      severity: "critical",
      detail: "Обнаружены слипшиеся слова (артефакт PDF-извлечения). Текст нечитаем."
    });
  }

  if (looksNoisyEvidence(text)) {
    problems.push({
      code: "noise",
      severity: "critical",
      detail: "Текст содержит нетекстовый контент (код, спецсимволы, техническую разметку)."
    });
  }

  if (hasBadFormatting(text)) {
    problems.push({
      code: "bad-formatting",
      severity: "critical",
      detail: "Обнаружены галлюцинации форматирования: пробелы между буквами, лишние спецсимволы."
    });
  }

  const sentences = text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20);
  if (sentences.length >= 3) {
    const uniqueSentences = new Set(sentences.map(s => s.slice(0, 60)));
    const uniqueRatio = uniqueSentences.size / sentences.length;
    if (uniqueRatio < 0.6) {
      problems.push({
        code: "repetitive",
        severity: "major",
        detail: `Повторяющиеся предложения: ${Math.round((1 - uniqueRatio) * 100)}% текста дублируется.`
      });
    }
  }

  if (!hasEvidenceGrounding(text, evidencePack)) {
    problems.push({
      code: "not-grounded",
      severity: "major",
      detail: "Текст не опирается на исходные материалы."
    });
  }

  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (words.length >= 20) {
    const uniqueWords = new Set(words);
    const wordDiversity = uniqueWords.size / words.length;
    if (wordDiversity < 0.35) {
      problems.push({
        code: "low-vocabulary",
        severity: "major",
        detail: `Бедный словарный запас: ${Math.round(wordDiversity * 100)}% уникальных слов.`
      });
    }
  }

  if (`${previousBody || ""}`.trim()) {
    const similarity = jaccardSimilarity(previousBody, text);
    if (similarity > 0.75) {
      problems.push({
        code: "duplicate",
        severity: "critical",
        detail: `Совпадение ${Math.round(similarity * 100)}% с предыдущим экраном.`
      });
    }
  }

  if (text.length > 0 && text.length < 100 && !text.includes(" ")) {
    problems.push({
      code: "title-only",
      severity: "critical",
      detail: "Экран содержит только заголовок без учебного контента."
    });
  }

  const criticalProblems = problems.filter(p => p.severity === "critical");
  const majorProblems = problems.filter(p => p.severity === "major");
  const ok = criticalProblems.length === 0 && majorProblems.length <= 1;

  if (problems.length > 0) {
    const summary = problems.map(p => `[${p.severity}] ${p.code}: ${p.detail}`).join(" | ");
    console.log(`[critic] ${ok ? "PASS (with warnings)" : "REJECT"}: ${summary}`);
  }

  return {
    ok,
    reason: ok ? "" : (criticalProblems[0]?.code || majorProblems[0]?.code || "quality"),
    problems,
    summary: problems.map(p => p.detail).join("; ")
  };
}

export function collectScreenBodyText(screen) {
  const blocks = Array.isArray(screen?.blocks) ? screen.blocks : [];
  return blocks
    .filter((block) => block?.type === "text" || block?.type === "note")
    .map((block) => `${block?.text || ""}`.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function flattenScreens(modules) {
  const result = [];
  for (const moduleItem of modules || []) {
    for (const section of moduleItem.sections || []) {
      for (const sco of section.scos || []) {
        for (const screen of sco.screens || []) {
          result.push(screen);
        }
      }
    }
  }
  return result;
}

export function computeCourseQualityMetrics(course) {
  const screens = flattenScreens(course?.modules || []);
  const total = screens.length;
  if (total === 0) {
    return { avgScreenChars: 0, evidenceCoverage: 0, duplicateRatio: 0 };
  }

  const lengths = screens.map((screen) => `${screen?.bodyLong || collectScreenBodyText(screen) || ""}`.length);
  const avgScreenChars = Math.round(lengths.reduce((sum, value) => sum + value, 0) / total);
  const withEvidence = screens.filter((screen) => Array.isArray(screen?.evidence) && screen.evidence.length > 0).length;
  const evidenceCoverage = Number((withEvidence / total).toFixed(4));

  let duplicates = 0;
  let previous = "";
  for (const screen of screens) {
    const current = `${screen?.bodyLong || collectScreenBodyText(screen) || ""}`;
    if (previous && jaccardSimilarity(previous, current) > 0.86) {
      duplicates += 1;
    }
    previous = current;
  }
  const duplicateRatio = Number((duplicates / total).toFixed(4));

  return { avgScreenChars, evidenceCoverage, duplicateRatio };
}

export function containsTemplatePlaceholders(course) {
  const placeholderRegex = /(?:screen\s+\d+.*(?:explains|introduces)|this screen introduces|focus topic|key points?:|practical (?:step|takeaway))/i;
  let placeholders = 0;
  let totalTextBlocks = 0;

  for (const moduleItem of course.modules || []) {
    for (const section of moduleItem.sections || []) {
      for (const sco of section.scos || []) {
        for (const screen of sco.screens || []) {
          for (const block of screen.blocks || []) {
            if (block?.type !== "text" && block?.type !== "note") {
              continue;
            }
            totalTextBlocks += 1;
            if (placeholderRegex.test(`${block?.text || ""}`)) {
              placeholders += 1;
            }
          }
        }
      }
    }
  }

  if (totalTextBlocks === 0) {
    return true;
  }
  return placeholders / totalTextBlocks > 0.25;
}
