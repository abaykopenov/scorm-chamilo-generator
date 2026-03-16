import { createId } from "./ids.js";
import { rebuildCourseStructure } from "./structure-engine.js";
import { cleanNarrativeText, isRuText } from "./postprocess/text-utils.js";
import { normalizeHierarchyTitles } from "./postprocess/hierarchy-normalization.js";
import { normalizeScreens } from "./postprocess/screen-generation.js";
import {
  collectQuestionKnowledge,
  normalizeQuestion
} from "./postprocess/question-generation.js";

/**
 * Detect if text contains garbled/merged Cyrillic words (>24 consecutive Cyrillic chars).
 */
function hasGarbledWords(text) {
  if (!text) return false;
  return /[\u0400-\u04FF]{25,}/.test(text);
}

/**
 * Detect if text looks like a table artifact (pipe-separated cells with garbled content).
 */
function looksLikeTableArtifact(text) {
  if (!text) return false;
  const pipeCount = (text.match(/\|/g) || []).length;
  if (pipeCount >= 2 && hasGarbledWords(text)) return true;
  return false;
}

/**
 * Fix merged Russian prepositions where PDF extraction removed spaces.
 * Examples: "мониторингав" → "мониторинга в", "модулидля" → "модули для"
 */
function fixMergedPrepositions(text) {
  if (!text) return text;
  let fixed = text;

  // Multi-char prepositions glued to preceding word
  const prepositions = ["для", "при", "без", "под", "над", "про", "между"];
  for (const prep of prepositions) {
    const re = new RegExp(`([\\u0400-\\u04FF]{3,})(${prep})(?=\\s|[.,;:!?)]|$)`, "giu");
    fixed = fixed.replace(re, `$1 ${prep}`);
    const reRight = new RegExp(`(?<=\\s|^)(${prep})([\\u0400-\\u04FF]{3,})`, "giu");
    fixed = fixed.replace(reRight, `${prep} $2`);
  }

  // 2-char prepositions glued to preceding word (only if word before is >3 chars)
  const shortPreps = ["на", "по", "за", "от", "из", "до"];
  for (const prep of shortPreps) {
    const re = new RegExp(`([\\u0400-\\u04FF]{4,})(${prep})\\s+([\\u0400-\\u04FF])`, "giu");
    fixed = fixed.replace(re, `$1 ${prep} $3`);
  }

  // Single-char prepositions: в, и, с, к, о, у
  fixed = fixed.replace(/([а-яё]{4,})(в|и|с|к|о|у)\s+([а-яёА-ЯЁ])/gi, (match, word, prep, next) => {
    return `${word} ${prep} ${next}`;
  });

  return fixed;
}

/**
 * Fix mixed Cyrillic ↔ Latin encoding in technical terms.
 * Common OCR/PDF artifacts: node_пате → node_name, расkage → package.
 */
function fixMixedEncoding(text) {
  if (!text) return text;

  // Cyrillic → Latin homoglyph map (chars that look similar)
  const cyrToLat = {
    "а": "a", "А": "A", "в": "b", "В": "B", "с": "c", "С": "C",
    "е": "e", "Е": "E", "Н": "H", "і": "i", "І": "I",
    "к": "k", "К": "K", "м": "m", "М": "M", "н": "n",
    "о": "o", "О": "O", "р": "p", "Р": "P", "п": "n",
    "т": "t", "Т": "T", "у": "y", "х": "x", "Х": "X"
  };

  // Common technical terms with known mixed-encoding patterns
  const techTermFixes = [
    [/node_пате/gi, "node_name"],
    [/node_паме/gi, "node_name"],
    [/расkage/gi, "package"],
    [/раскаge/gi, "package"],
    [/Торіс/gi, "Topics"],
    [/Соntents/gi, "Contents"],
    [/Рreface/gi, "Preface"],
    [/Сhapter/gi, "Chapter"],
    [/lаunсh/gi, "launch"],
    [/sеrviсе/gi, "service"],
    [/mеssаgе/gi, "message"],
    [/tорiс/gi, "topic"],
    [/rоslаunсh/gi, "roslaunch"],
    [/rоstорiс/gi, "rostopic"],
    [/расkаgе/gi, "package"],
  ];

  let fixed = text;
  for (const [pattern, replacement] of techTermFixes) {
    fixed = fixed.replace(pattern, replacement);
  }

  // Generic fix: words with mixed Latin+Cyrillic inside underscored identifiers
  // Pattern: word_part where part has mixed scripts → convert Cyrillic chars to Latin
  fixed = fixed.replace(/\b([a-zA-Z_]+[_.])([\u0400-\u04FFa-zA-Z_]+)\b/g, (match, prefix, suffix) => {
    const hasCyr = /[\u0400-\u04FF]/.test(suffix);
    const hasLat = /[a-zA-Z]/.test(suffix);
    if (!hasCyr || !hasLat) return match; // Not mixed
    // Convert Cyrillic chars to Latin homoglyphs
    const converted = suffix.split("").map(ch => cyrToLat[ch] || ch).join("");
    return prefix + converted;
  });

  // Fix "shouldwe" → "should we" (English words merged)
  fixed = fixed.replace(/\b(should|would|could|will|can|must|may|might|shall)(we|you|they|he|she|it|not|be|have|do)\b/gi, "$1 $2");
  fixed = fixed.replace(/\b(to|in|on|at|by|for|with|from|of|as|is|or|an)(the|a|an|this|that|each|one|all|my|your)\b/gi, "$1 $2");

  return fixed;
}

/**
 * Remove English text fragments embedded in Russian content.
 */
function removeEnglishFragments(text) {
  if (!text) return text;
  // Remove sequences of 5+ English words (likely from source material)
  let cleaned = text.replace(/(?:^|\s)([A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){4,}[.!?]?)(?:\s|$)/g, " ");
  // Remove merged English words (e.g., "designedand", "sectionsor")
  cleaned = cleaned.replace(/\b[A-Za-z]{2,}(?:[A-Z][a-z]+){2,}\b/g, "");
  return cleaned.trim();
}

/**
 * Clean a text block by removing garbled sentences, fixing merged prepositions, 
 * and filtering metadata fragments.
 */
function cleanBlockText(text) {
  if (!text) return text;

  let cleaned = text;

  // Fix merged prepositions first
  cleaned = fixMergedPrepositions(cleaned);

  // Remove English fragments
  cleaned = removeEnglishFragments(cleaned);

  const garbledPattern = /[\u0400-\u04FF]{25,}/;
  const metadataPatterns = [
    /ISBN[\s:\-]*[\dXx\-]{10,}/i,
    /©\s*\d{4}/,
    /Член[\-\s]*корреспондент/i,
    /[Сс]вязаться\s+с\s+\S+\s+можно/i,
  ];

  // Split into sentences and filter
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const result = sentences.filter(sentence => {
    if (garbledPattern.test(sentence)) return false;
    if (looksLikeTableArtifact(sentence)) return false;
    for (const pattern of metadataPatterns) {
      if (pattern.test(sentence)) return false;
    }
    return true;
  });
  return result.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Clean a title. If the title is too long (>100 chars) or contains garbage,
 * try to extract a meaningful prefix.
 */
function cleanTitle(title, fallback) {
  if (!title) return fallback || "Untitled";

  let cleaned = title;

  // Fix merged prepositions in titles too
  cleaned = fixMergedPrepositions(cleaned);

  // Remove English fragments  
  cleaned = removeEnglishFragments(cleaned);

  // ---  Strip TOC/structural noise from titles ---
  // Remove "Table of Contents", "Preface", "Chapter N", "Contents", "Index" etc.
  cleaned = cleaned.replace(/\b(?:Table\s*of\s*Contents|Preface\s*[xiv]*|Foreword|Acknowledgements?|Contents|Index|Appendix|Bibliography)\b/gi, "");
  cleaned = cleaned.replace(/\b(?:Chapter|Part|Section)\s*\d+\b/gi, "");
  cleaned = cleaned.replace(/(?:Предисловие|Оглавление|Содержание|Библиография|Приложение)/gi, "");
  // Remove page numbers and roman numerals (xi, xiv, etc.)
  cleaned = cleaned.replace(/\b[xivlcdm]{2,6}\b/gi, "");
  cleaned = cleaned.replace(/\b\d{1,4}\b/g, "");
  // Remove resulting dots and extra whitespace
  cleaned = cleaned.replace(/\.{2,}/g, " ").replace(/\s+/g, " ").trim();

  // --- Fix mixed Cyrillic ↔ Latin encoding in technical terms ---
  cleaned = fixMixedEncoding(cleaned);

  // If title contains pipe-separated table data, use fallback
  if (looksLikeTableArtifact(cleaned)) {
    return fallback || "Untitled";
  }

  // If title has garbled words, extract clean prefix
  if (hasGarbledWords(cleaned)) {
    const words = cleaned.split(/\s+/);
    const cleanWords = [];
    for (const word of words) {
      const cyrRuns = word.match(/[\u0400-\u04FF]+/g) || [];
      const hasLongRun = cyrRuns.some(run => run.length > 24);
      if (hasLongRun) break;
      cleanWords.push(word);
    }
    const result = cleanWords.join(" ").replace(/[\s,;:\-–—]+$/, "").trim();
    if (result.length >= 10) return result;
    return fallback || "Untitled";
  }

  // If title is too long (>100 chars), it's probably not a real title
  // but a sentence fragment from RAG context
  if (cleaned.length > 100) {
    // Try to cut at a natural boundary
    const cutPoints = [". ", ", ", " – ", " — "];
    for (const cut of cutPoints) {
      const pos = cleaned.indexOf(cut);
      if (pos > 10 && pos < 100) {
        return cleaned.slice(0, pos).trim();
      }
    }
    // Just truncate
    return cleaned.slice(0, 80).replace(/\s+\S*$/, "").trim() || fallback || "Untitled";
  }

  return cleaned;
}

/**
 * Strip garbled/merged-word fragments and metadata from ALL course elements.
 */
function stripGarbledFragments(modules) {
  for (const mod of modules || []) {
    mod.title = cleanTitle(mod.title, `Module ${mod.order || ""}`);

    for (const section of mod.sections || []) {
      section.title = cleanTitle(section.title, `Section ${section.order || ""}`);

      for (const sco of section.scos || []) {
        sco.title = cleanTitle(sco.title, `SCO ${sco.order || ""}`);

        for (const screen of sco.screens || []) {
          screen.title = cleanTitle(screen.title, `Screen ${screen.order || ""}`);

          if (Array.isArray(screen.blocks)) {
            for (const block of screen.blocks) {
              if ((block.type === "text" || block.type === "note") && block.text) {
                block.text = cleanBlockText(block.text);
              }
              if (block.type === "list" && Array.isArray(block.items)) {
                block.items = block.items
                  .map(item => cleanBlockText(item))
                  .filter(item => item && item.length > 5);
              }
            }
            screen.blocks = screen.blocks.filter(block => {
              if ((block.type === "text" || block.type === "note") && !block.text) return false;
              if (block.type === "list" && (!Array.isArray(block.items) || block.items.length === 0)) return false;
              return true;
            });
          }
          if (screen.bodyLong) {
            screen.bodyLong = cleanBlockText(screen.bodyLong);
          }
        }
      }
    }
  }
}

export function postprocessGeneratedCourse(course, input) {
  const structured = rebuildCourseStructure(course, input?.structure || {});

  structured.title = cleanNarrativeText(structured.title || input?.titleHint || "Course", 160) || (input?.titleHint || "Course");
  structured.description = cleanNarrativeText(
    structured.description
    || `Auto-generated course for audience "${input?.audience || "learners"}".`,
    460
  );

  normalizeHierarchyTitles(structured.modules || [], structured.title || input?.titleHint || "Course");
  normalizeScreens(structured.modules || [], input?.audience || "learners", structured.title || input?.titleHint || "Course");

  // Strip any remaining garbled fragments from ALL course elements
  stripGarbledFragments(structured.modules || []);

  // Also clean course-level title if garbled or too long
  if (hasGarbledWords(structured.title) || structured.title.length > 120) {
    structured.title = cleanTitle(structured.title, input?.titleHint || "Course");
  }

  const desiredQuestions = Math.max(0, Math.trunc(Number(input?.finalTest?.questionCount) || 0));
  const sourceQuestions = Array.isArray(structured?.finalTest?.questions) ? structured.finalTest.questions : [];

  const questionContext = {
    courseTitle: structured.title || input?.titleHint || "Course",
    ru: isRuText(structured.title || input?.titleHint || ""),
    knowledge: collectQuestionKnowledge(structured.modules || [], structured.title || input?.titleHint || "Course"),
    forceKnowledgeQuestions: true
  };

  const questions = Array.from({ length: desiredQuestions }, (_, questionIndex) =>
    normalizeQuestion(sourceQuestions[questionIndex], questionIndex, questionContext)
  );

  structured.finalTest = {
    ...(structured.finalTest || {}),
    id: `${structured?.finalTest?.id || createId("final_test")}`,
    enabled: Boolean(input?.finalTest?.enabled),
    title: cleanNarrativeText(structured?.finalTest?.title || "Final test", 120) || "Final test",
    questionCount: desiredQuestions,
    passingScore: Number(input?.finalTest?.passingScore) || 70,
    attemptsLimit: Number(input?.finalTest?.attemptsLimit) || 1,
    maxTimeMinutes: Number(input?.finalTest?.maxTimeMinutes) || 20,
    questions
  };

  // Deep sanitize: catch any [object Object] in text fields before SCORM packaging
  sanitizeCourseTexts(structured);

  return structured;
}

/**
 * Deep walk the course structure and ensure all text fields are strings.
 * Catches [object Object] from LLM returning nested objects instead of strings.
 */
function sanitizeCourseTexts(course) {
  function safeString(val) {
    if (val == null) return "";
    let s;
    if (typeof val === "string") s = val.replace(/\[object Object\]/gi, "").trim();
    else if (typeof val === "object") s = `${val.text || val.label || val.value || ""}`.trim();
    else s = String(val);
    // Apply mixed-encoding fix to ALL text fields
    return fixMixedEncoding(s);
  }

  for (const mod of Array.isArray(course?.modules) ? course.modules : []) {
    mod.title = safeString(mod.title);
    for (const sec of Array.isArray(mod?.sections) ? mod.sections : []) {
      sec.title = safeString(sec.title);
      for (const sco of Array.isArray(sec?.scos) ? sec.scos : []) {
        sco.title = safeString(sco.title);
        for (const screen of Array.isArray(sco?.screens) ? sco.screens : []) {
          screen.title = safeString(screen.title);
          for (const block of Array.isArray(screen?.blocks) ? screen.blocks : []) {
            if (block.text != null) block.text = safeString(block.text);
            if (Array.isArray(block.items)) {
              block.items = block.items.map(safeString);
            }
          }
        }
      }
    }
  }

  // Sanitize test questions
  const questions = course?.finalTest?.questions || [];
  for (const q of Array.isArray(questions) ? questions : []) {
    q.prompt = safeString(q.prompt);
    q.explanation = safeString(q.explanation);
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (typeof opt === "object" && opt !== null) {
          opt.text = safeString(opt.text);
        }
      }
    }
  }
}
