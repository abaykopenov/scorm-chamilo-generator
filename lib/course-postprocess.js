import { createId } from "./ids.js";
import { rebuildCourseStructure } from "./structure-engine.js";
import { cleanNarrativeText, isRuText } from "./postprocess/text-utils.js";
import { repairKazakhText, repairKazakhTitle } from "./kazakh-text-repair.js";
import { normalizeHierarchyTitles } from "./postprocess/hierarchy-normalization.js";
import { normalizeScreens } from "./postprocess/screen-generation.js";
import {
  collectQuestionKnowledge,
  normalizeQuestion
} from "./postprocess/question-generation.js";

/**
 * Detect if text contains garbled/merged Cyrillic words (>17 consecutive Cyrillic chars).
 */
function hasGarbledWords(text) {
  if (!text) return false;
  return /[\u0400-\u04FF]{18,}/.test(text);
}

/**
 * Detect fragmented words — spaces incorrectly inserted inside words.
 * e.g. "при менения технологи и" → should be "применения технологии"
 */
function hasFragmentedWords(text) {
  if (!text) return false;
  // Many 1-3 char Cyrillic fragments separated by spaces in a row
  const fragments = text.match(/(?:^|\s)[\u0400-\u04FF]{1,3}(?=\s|$)/g);
  if (!fragments) return false;
  // If >40% of "words" are tiny fragments, text is likely garbled
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > 5 && (fragments.length / words.length) > 0.4;
}

/**
 * Detect if text looks like a table artifact (pipe-separated cells with garbled content).
 */
function looksLikeTableArtifact(text) {
  if (!text) return false;
  const pipeCount = (text.match(/\|/g) || []).length;
  if (pipeCount >= 2) return true;
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

  // Remove pipe-separated table artifacts entirely
  cleaned = cleaned.replace(/[^|]*\|[^|]*\|[^|]*/g, " ");

  // Remove markdown heading markers from output
  cleaned = cleaned.replace(/^#{1,6}\s*/gm, "");

  // Remove university header ("ӘЛ-ФАРАБИ атындағы ҚАЗАҚ ҰЛТТЫҚ УНИВЕРСИТЕТІ")
  cleaned = cleaned.replace(/ӘЛ.?ФАРАБ\s*И?\s*атындағы\s*ҚАЗАҚ\s*ҰЛТТЫҚ\s*УНИВЕРСИТЕТ\s*І?\.?/giu, "");

  // Remove mathematical formula noise
  cleaned = cleaned.replace(/\b[hkn]\s*(?:chchch|chch|ch)\s*[^.]*?(?:,?\s*\d+\s*)+/gi, "");
  cleaned = cleaned.replace(/chchch|kchchch|hэлемент[а-яёәғқңөұүіһ]*/gi, "");
  cleaned = cleaned.replace(/,\s*\.\.\.\s*,\s*,?\s*(?:\d+\s*)+/g, "");
  cleaned = cleaned.replace(/\s+[A-Z][a-z]?[A-Z]\s+/g, " ");
  cleaned = cleaned.replace(/\bijo\b|\bChG\b/g, "");
  // Remove "Соңғы hэлементтерді kchchch" type noise
  cleaned = cleaned.replace(/Соңғы\s+h?элементтерді[^.]+/gi, "");

  // Apply comprehensive Kazakh text repair (fragments, merges, postpositions)
  cleaned = repairKazakhText(cleaned);

  // Fix merged prepositions
  cleaned = fixMergedPrepositions(cleaned);

  // Remove English fragments
  cleaned = removeEnglishFragments(cleaned);

  const garbledPattern = /[\u0400-\u04FF]{18,}/;
  const metadataPatterns = [
    /ISBN[\s:\-]*[\dXx\-]{10,}/i,
    /©\s*\d{4}/,
    /Член[\-\s]*корреспондент/i,
    /[Сс]вязаться\s+с\s+\S+\s+можно/i,
    /Научныйредактор/i,
    /Авторывыражают/i,
    /поблагодарить/i,
    // University header patterns
    /ӘЛ.?ФАРАБ/i,
    /ҚАЗАҚ\s*ҰЛТТЫҚ\s*УНИВЕРСИТЕТ/i,
  ];

  // Split into sentences and filter
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const result = sentences.filter(sentence => {
    if (garbledPattern.test(sentence)) return false;
    if (looksLikeTableArtifact(sentence)) return false;
    if (hasFragmentedWords(sentence)) return false;
    for (const pattern of metadataPatterns) {
      if (pattern.test(sentence)) return false;
    }
    // Skip very short sentences that are likely artifacts
    if (sentence.trim().length < 15) return false;
    // Skip sentences that are mostly formula noise
    if (/(?:chchch|kchchch|hэлемент|\bijo\b)/i.test(sentence)) return false;
    return true;
  });

  // Remove leading lowercase fragment at start of result
  let final = result.join(" ").replace(/\s+/g, " ").trim();
  final = final.replace(/^[а-яёәғқңөұүіһ]{1,4}\s+/i, "");

  return final;
}

/**
 * Clean a title. If the title is too long (>100 chars) or contains garbage,
 * try to extract a meaningful prefix.
 */
function cleanTitle(title, fallback) {
  if (!title) return fallback || "Untitled";

  let cleaned = title;

  // Remove markdown heading markers
  cleaned = cleaned.replace(/^#{1,6}\s*/, "");

  // If title is just a filename pattern like "А5_Монографи..." use fallback
  if (/^[АA]\d+[_\-]/.test(cleaned.trim())) {
    return fallback || "Untitled";
  }

  // Remove university header if it IS the title
  cleaned = cleaned.replace(/ӘЛ.?ФАРАБ\s*И?\s*атындағы\s*ҚАЗАҚ\s*ҰЛТТЫҚ\s*УНИВЕРСИТЕТ\s*І?\.?/giu, "").trim();

  // If title starts with lowercase Cyrillic, it's a word fragment from PDF
  if (/^[а-яёәғқңөұүіһ]/.test(cleaned.trim())) {
    return fallback || "Untitled";
  }

  // If title is empty or just dots/spaces after cleanup
  if (!cleaned || /^[\s.,:;]+$/.test(cleaned)) {
    return fallback || "Untitled";
  }

  // Apply Kazakh text repair to titles
  cleaned = repairKazakhTitle(cleaned);

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
              if (block.type === "table") {
                if (Array.isArray(block.columns)) {
                  block.columns = block.columns.map(col => cleanBlockText(`${col}`).substring(0, 150));
                }
                if (Array.isArray(block.rows)) {
                  block.rows = block.rows.map(row => 
                    Array.isArray(row) ? row.map(cell => cleanBlockText(`${cell}`)) : []
                  );
                }
              }
            }
            screen.blocks = screen.blocks.filter(block => {
              if ((block.type === "text" || block.type === "note") && !block.text) return false;
              if (block.type === "list" && (!Array.isArray(block.items) || block.items.length === 0)) return false;
              if (block.type === "table" && (!Array.isArray(block.rows) || block.rows.length === 0)) return false;
              return true;
            });
          }
          if (screen.bodyLong) {
            screen.bodyLong = cleanBlockText(screen.bodyLong);
          }
        }

        // Deduplicate progressively truncated screen titles within this SCO
        // Pattern: "лық алгоритм..." → "қ алгоритм..." → "алгоритм..." → "горитм..."
        if (sco.screens && sco.screens.length > 2) {
          const titles = sco.screens.map(s => s.title || "");
          let dupCount = 0;
          for (let i = 1; i < titles.length; i++) {
            const prev = titles[i - 1].toLowerCase().trim();
            const curr = titles[i].toLowerCase().trim();
            // Check if current title is a suffix/substring of previous, or vice versa
            if (prev.length > 5 && curr.length > 5 &&
                (prev.includes(curr) || curr.includes(prev) ||
                 prev.endsWith(curr.slice(0, 15)) || curr.endsWith(prev.slice(0, 15)))) {
              dupCount++;
            }
          }
          // If >40% of titles are duplicated variants, rename all with numbered titles
          if (dupCount >= Math.ceil(sco.screens.length * 0.4)) {
            const isKk = /[\u04D9\u0493\u049B\u04A3\u04E9\u04B1\u04AF\u0456\u04BB]/i.test(titles.join(" "));
            const baseLabel = isKk ? "Тақырып" : "Экран";
            for (let i = 0; i < sco.screens.length; i++) {
              sco.screens[i].title = `${baseLabel} ${i + 1}`;
            }
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
