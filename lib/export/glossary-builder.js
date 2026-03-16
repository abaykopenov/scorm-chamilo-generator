/**
 * Glossary builder for courses.
 * Extracts key technical terms from course content, then uses LLM
 * to generate proper definitions. Falls back to term-only mode if LLM unavailable.
 */

import { callProvider } from "../llm/providers.js";

const LOG_PREFIX = "[glossary]";

const STOP_WORDS_RU = new Set([
  // Pronouns, conjunctions, prepositions
  "и", "в", "на", "с", "по", "для", "из", "к", "от", "о", "а", "но", "что",
  "это", "как", "не", "да", "нет", "или", "при", "до", "за", "же", "так",
  "все", "его", "она", "они", "мы", "вы", "был", "быть", "этот", "также",
  "может", "будет", "если", "уже", "есть", "нужно", "можно", "нужен",
  "который", "которая", "которое", "которые", "более", "между", "через",
  "после", "перед", "только", "когда", "чтобы", "потому", "однако",
  // Structural words (course/book terms)
  "модуль", "экран", "тема", "глава", "раздел", "курс", "обучение",
  "введение", "заключение", "итог", "пример", "задание", "вопрос",
  // Common verbs that are NOT terms
  "использовать", "использует", "используется", "используют", "используя",
  "обеспечивает", "обеспечивать", "обеспечить",
  "представляет", "представляют", "представлять",
  "позволяет", "позволяют", "позволять",
  "является", "являются", "являться",
  "содержит", "содержат", "содержать",
  "работает", "работают", "работать",
  "выполняет", "выполняют", "выполнять",
  "создает", "создают", "создать", "создание",
  "запускает", "запускают", "запустить", "запуск",
  "включает", "включают", "включать",
  "описывает", "описывают", "описывать", "описание",
  "определяет", "определяют", "определять", "определение",
  "отвечает", "отвечают", "отвечать",
  "управляет", "управляют", "управлять", "управление",
  "поддерживает", "поддерживают",
  // Common nouns that are NOT terms
  "система", "системы", "программа", "программы",
  "инструмент", "инструментов", "инструменты",
  "компонент", "компоненты", "компонентов",
  "данные", "данных", "информация", "информации",
  "процесс", "процессы", "результат", "результаты",
  "функция", "функции", "метод", "методы",
  "объект", "объекты", "элемент", "элементы",
  "часть", "части", "набор", "наборы",
  "среда", "среды", "платформа", "платформы",
  "файл", "файлы", "папка", "папки", "каталог",
  "команда", "команды", "строка", "строки",
  "пользователь", "пользователи", "разработчик", "разработчики",
  "проект", "проекты", "приложение", "приложения",
  "параметр", "параметры", "значение", "значения",
  // Common adjectives
  "различные", "различных", "основной", "основные", "основных",
  "базовый", "базовые", "новый", "новые", "новая",
  "другой", "другие", "первый", "второй", "третий",
  "важный", "важные", "нужный", "нужные",
  "простой", "простые", "сложный", "сложные",
  "каждый", "каждая", "каждое", "любой", "любая",
  "следующий", "следующая", "следующее", "следующие",
  // Generic action words
  "необходимо", "возможно", "возможность", "помощью", "способ",
  "пример", "например", "случай", "случае", "результат"
]);

const STOP_WORDS_EN = new Set([
  "the", "a", "an", "in", "on", "at", "for", "to", "of", "and", "or", "is",
  "are", "was", "were", "be", "been", "has", "have", "had", "do", "does",
  "will", "can", "may", "with", "from", "by", "that", "this", "it", "not",
  "also", "each", "more", "when", "which", "about", "into", "than", "then",
  "should", "would", "could", "module", "screen", "chapter", "topic",
  // Common verbs
  "use", "used", "uses", "using", "provide", "provides", "allow", "allows",
  "include", "includes", "create", "creates", "run", "runs", "start", "starts",
  "define", "defines", "contain", "contains", "support", "supports",
  "work", "works", "make", "makes", "need", "needs", "set", "sets",
  // Common nouns
  "system", "file", "data", "information", "process", "result", "function",
  "method", "object", "element", "part", "user", "example", "step",
  "command", "line", "way", "time", "name", "type", "value", "number",
  // Common adjectives  
  "new", "different", "first", "main", "basic", "simple", "important",
  "following", "next", "other", "various", "specific", "available"
]);

function isStopWord(word) {
  const lower = word.toLowerCase();
  return STOP_WORDS_RU.has(lower) || STOP_WORDS_EN.has(lower);
}

function extractAllText(course) {
  const texts = [];
  const modules = Array.isArray(course.modules) ? course.modules : [];

  for (const mod of modules) {
    texts.push(mod.title || "");
    const sections = Array.isArray(mod.sections) ? mod.sections : [];
    for (const section of sections) {
      texts.push(section.title || "");
      const scos = Array.isArray(section.scos) ? section.scos : [];
      for (const sco of scos) {
        const screens = Array.isArray(sco.screens) ? sco.screens : [];
        for (const screen of screens) {
          texts.push(screen.title || "");
          const blocks = Array.isArray(screen.blocks) ? screen.blocks : [];
          for (const block of blocks) {
            if (block.text) texts.push(block.text);
            if (Array.isArray(block.items)) {
              for (const item of block.items) {
                texts.push(typeof item === "string" ? item : item?.text || "");
              }
            }
          }
        }
      }
    }
  }

  return texts.join(" ");
}

function countTerms(fullText) {
  const words = fullText.split(/[\s,.:;!?()\[\]{}"'«»\u2014\u2013\-\/\\]+/);
  const counts = new Map();

  for (const word of words) {
    const clean = word.replace(/[^\p{L}\p{N}_]/gu, "").trim();
    if (clean.length < 3) continue;
    if (isStopWord(clean)) continue;
    if (/^\d+$/.test(clean)) continue;

    const key = clean.toLowerCase();
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
      if (!entry.casings[clean]) entry.casings[clean] = 0;
      entry.casings[clean]++;
    } else {
      counts.set(key, { count: 1, casings: { [clean]: 1 } });
    }
  }

  return counts;
}

function computeTermScore(key, entry) {
  let score = 0;
  const count = entry.count;

  if (count >= 5) score += 3;
  else if (count >= 3) score += 2;
  else if (count >= 2) score += 1;
  else return 0;

  // Technical patterns
  if (/^[A-Z]{2,}$/.test(key)) score += 5;           // ROS, API, SLAM
  if (/^[a-z]+[A-Z]/.test(key)) score += 4;           // camelCase
  if (key.includes("_")) score += 4;                   // snake_case
  if (/\.(xml|json|yaml|py|cpp|js|launch)$/i.test(key)) score += 5;  // file extensions
  if (/^(ros|catkin|gazebo|rviz|moveit|urdf|slam|nav|tf|ament|colcon)/i.test(key)) score += 5;
  if (/^(node|topic|service|message|package|launch|subscriber|publisher|workspace|cmake)/i.test(key)) score += 3;
  if (/^(docker|git|pip|npm|python|linux|ubuntu|bash)/i.test(key)) score += 3;

  // Length bonus
  if (key.length >= 8) score += 1;
  if (key.length >= 12) score += 1;

  // Capitalized in original (likely proper noun/acronym)
  const bestCasing = Object.keys(entry.casings).sort((a, b) => entry.casings[b] - entry.casings[a])[0] || key;
  if (/^[A-Z]/.test(bestCasing) && !/^[А-ЯЁ]/.test(bestCasing)) score += 1;

  return score;
}

function selectGlossaryTerms(counts, maxTerms = 30) {
  const candidates = [];

  for (const [key, entry] of counts) {
    const score = computeTermScore(key, entry);
    if (score <= 0) continue;

    const bestCasing = Object.entries(entry.casings)
      .sort((a, b) => b[1] - a[1])[0][0];

    candidates.push({ term: bestCasing, count: entry.count, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxTerms);
}

// ── LLM-powered definitions ───────────────────────────────────────────────

function buildGlossaryPrompt(terms, courseTitle, language) {
  const termList = terms.map(t => t.term).join(", ");
  const lang = language === "ru" ? "русском" : "английском";
  const langFull = language === "ru" ? "Russian" : "English";

  return {
    system: [
      `Ты — технический редактор учебного курса. Твоя задача — написать краткие, точные определения для терминов глоссария.`,
      `Каждое определение должно быть 1-2 предложения.`,
      `ЯЗЫК: Все определения ДОЛЖНЫ быть на ${lang} языке. Терминыоставляй на оригинальном языке (ROS остаётся ROS), но определение пиши ТОЛЬКО на ${lang}.`,
      `НЕ переводи термины на другой язык. Если термин "catkin_make", оставь его как есть, но определение напиши на ${lang}.`,
      `Используй профессиональную терминологию, но понятно для студентов.`,
      `ВАЖНО: Включай ТОЛЬКО специализированные и технические термины, специфичные для предмета курса. НЕ включай в ответ обычные слова (моделировать, анализировать, обеспечивает, компонентами, взаимодействие, совместимость, дистрибутива). Если термин является обычным словом русского языка — просто НЕ включай его в ответ.`
    ].join(" "),
    user: `Курс: "${courseTitle}"

Напиши определения для следующих терминов из этого курса:
${terms.map((t, i) => `${i + 1}. ${t.term}`).join("\n")}

Ответ СТРОГО в JSON формате, без markdown:
[
  {"term": "название", "definition": "определение 1-2 предложения на ${lang} языке"},
  ...
]

Только JSON массив, ничего больше.`
  };
}

function parseGlossaryResponse(raw, terms) {
  if (typeof raw !== "string") return null;

  // Try direct JSON parse
  try {
    const parsed = JSON.parse(raw.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // Try extracting from code fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  // Try finding JSON array
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}

async function generateDefinitions(terms, courseTitle, generationConfig, fullText) {
  if (!generationConfig || !terms.length) return null;

  // Detect language from title AND content text (not just title)
  const textSample = `${courseTitle || ""} ${(fullText || "").slice(0, 2000)}`;
  const cyrCount = (textSample.match(/[\u0400-\u04FF]/g) || []).length;
  const latCount = (textSample.match(/[a-zA-Z]/g) || []).length;
  const language = cyrCount > latCount * 0.3 ? "ru" : "en";
  console.log(`${LOG_PREFIX} Detected language: ${language} (cyr=${cyrCount}, lat=${latCount})`);
  const prompt = buildGlossaryPrompt(terms, courseTitle, language);

  try {
    const response = await callProvider(generationConfig, prompt, {
      trace: { stage: "glossary" },
      temperature: 0.3,
      maxTokens: 2000
    });

    const content = typeof response === "string" ? response :
      response?.message?.content || response?.choices?.[0]?.message?.content || "";

    const definitions = parseGlossaryResponse(content, terms);
    if (!definitions || definitions.length === 0) {
      console.warn(`${LOG_PREFIX} LLM returned unparseable glossary response`);
      return null;
    }

    console.log(`${LOG_PREFIX} LLM generated ${definitions.length} definitions`);
    return definitions;
  } catch (error) {
    console.warn(`${LOG_PREFIX} LLM glossary generation failed: ${error?.message || error}`);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build glossary from course content.
 * Uses statistical extraction + LLM definitions.
 * @param {object} course - Course JSON
 * @param {object} options - { maxTerms, generationConfig }
 * @returns {Promise<{ terms: Array<{ term, definition, count }> }>}
 */
export async function buildGlossary(course, options = {}) {
  const maxTerms = Math.max(5, Math.min(50, Number(options.maxTerms) || 30));
  const fullText = extractAllText(course);
  const counts = countTerms(fullText);
  const candidates = selectGlossaryTerms(counts, maxTerms);

  console.log(`${LOG_PREFIX} Extracted ${candidates.length} glossary terms from ${counts.size} unique words`);

  // Try LLM definitions
  const generationConfig = options.generationConfig || resolveDefaultLlmConfig();
  const llmDefinitions = await generateDefinitions(candidates, course.title || "Course", generationConfig, fullText);

  // Merge definitions with candidates, filtering out SKIP entries
  const terms = candidates
    .map(candidate => {
      const llmEntry = llmDefinitions?.find(d =>
        d.term?.toLowerCase() === candidate.term.toLowerCase()
      );
      const def = llmEntry?.definition || "";
      // Filter out SKIP entries and empty definitions
      if (!def || /^\s*SKIP\s*$/i.test(def) || def.trim().length < 5) {
        return null;
      }
      return {
        term: candidate.term,
        definition: def,
        count: candidate.count
      };
    })
    .filter(Boolean);

  console.log(`${LOG_PREFIX} Final glossary: ${terms.length} terms (filtered from ${candidates.length} candidates)`);
  return { terms };
}

/**
 * Synchronous fallback: build glossary without LLM (term + count only).
 */
export function buildGlossarySync(course, options = {}) {
  const maxTerms = Math.max(5, Math.min(50, Number(options.maxTerms) || 30));
  const fullText = extractAllText(course);
  const counts = countTerms(fullText);
  const candidates = selectGlossaryTerms(counts, maxTerms);

  console.log(`${LOG_PREFIX} Extracted ${candidates.length} glossary terms (sync, no definitions)`);
  return {
    terms: candidates.map(c => ({ term: c.term, definition: "", count: c.count }))
  };
}

/**
 * Resolve default LLM config from environment.
 */
function resolveDefaultLlmConfig() {
  const provider = process.env.TELEGRAM_BOT_GENERATION_PROVIDER || "ollama";
  const model = process.env.TELEGRAM_BOT_GENERATION_MODEL || process.env.LOCAL_LLM_MODEL || "";
  const baseUrl = process.env.TELEGRAM_BOT_GENERATION_BASE_URL || process.env.LOCAL_LLM_BASE_URLS || "http://127.0.0.1:11434";

  if (!model) return null;

  return {
    provider,
    model,
    baseUrl
  };
}

/**
 * Attach glossary to course JSON (async with LLM).
 */
export async function attachGlossaryToCourse(course, options = {}) {
  const { terms } = await buildGlossary(course, options);
  course.glossary = { terms };
  return course;
}
