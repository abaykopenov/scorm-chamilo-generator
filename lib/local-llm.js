import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";

function toPlainText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeBlocks(blocks, fallbackTitle, fallbackText) {
  const list = Array.isArray(blocks) ? blocks : [];
  const normalized = list
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }

      const type = ["text", "note", "list", "image"].includes(block.type) ? block.type : "text";
      if (type === "list") {
        const items = Array.isArray(block.items) ? block.items.map((item) => `${item}`.trim()).filter(Boolean) : [];
        return { type, items: items.length > 0 ? items : [fallbackText] };
      }
      if (type === "image") {
        return {
          type,
          src: toPlainText(block.src, ""),
          alt: toPlainText(block.alt, fallbackTitle)
        };
      }

      return {
        type,
        text: toPlainText(block.text, fallbackText)
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) {
    return normalized;
  }

  return [
    {
      type: "text",
      text: fallbackText
    }
  ];
}

function normalizeOptions(question, fallbackIndex) {
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  const options = rawOptions.length > 0
    ? rawOptions.map((option, optionIndex) => ({
      id: createId("option"),
      text: toPlainText(typeof option === "string" ? option : option?.text, `Вариант ${optionIndex + 1}`)
    }))
    : Array.from({ length: 4 }, (_, optionIndex) => ({
      id: createId("option"),
      text: `Вариант ${optionIndex + 1}`
    }));

  const answerIndex = Number.isFinite(Number(question?.correctOptionIndex))
    ? Math.max(0, Math.min(options.length - 1, Math.trunc(Number(question.correctOptionIndex))))
    : 0;

  return {
    options,
    correctOptionId: options[answerIndex]?.id ?? options[0].id,
    explanation: toPlainText(question?.explanation, `Вопрос ${fallbackIndex + 1} проверяет ключевое понимание темы.`)
  };
}

const SYSTEM_PROMPT = `Ты — эксперт по созданию e-learning курсов. Генерируй контент на русском языке строго в JSON формате.
ПРАВИЛА:
- Каждый "text" блок: 2-4 содержательных предложения по теме
- Каждый "note" блок: практический совет (1-2 предложения)
- Каждый "list" блок: 3-5 конкретных пунктов
- НЕ используй шаблонные фразы. Пиши как профессиональный методист.
- Ответ — ТОЛЬКО валидный JSON, без markdown и пояснений.`;

export function createModulePrompt(input, moduleIndex) {
  const { structure } = input;
  const goal = input.learningGoals[moduleIndex % input.learningGoals.length] || "Освоить ключевые идеи";

  return {
    system: SYSTEM_PROMPT,
    user: `Создай ОДИН модуль для курса "${input.titleHint}" (аудитория: ${input.audience}).
Это модуль ${moduleIndex + 1} из ${structure.moduleCount}. Цель модуля: "${goal}".

Структура: ${structure.sectionsPerModule} раздел(ов), по ${structure.scosPerSection} урок(ов), по ${structure.screensPerSco} экран(ов).
Каждый экран должен содержать 2-3 блока (text, note, или list) с подробным содержанием.

JSON формат:
{
  "title": "Название модуля",
  "sections": [
    {
      "title": "Название раздела",
      "scos": [
        {
          "title": "Название урока",
          "screens": [
            {
              "title": "Тема экрана",
              "blocks": [
                {"type": "text", "text": "Содержательный текст..."},
                {"type": "note", "text": "Совет..."},
                {"type": "list", "items": ["Пункт 1", "Пункт 2", "Пункт 3"]}
              ]
            }
          ]
        }
      ]
    }
  ]
}`
  };
}

export function createTestPrompt(input) {
  return {
    system: SYSTEM_PROMPT,
    user: `Создай итоговый тест для курса "${input.titleHint}" (аудитория: ${input.audience}).
Цели обучения: ${input.learningGoals.join(", ")}.
Нужно ${input.finalTest.questionCount} вопросов. У каждого 4 варианта ответа, 1 правильный.

JSON формат:
{
  "title": "Итоговый тест",
  "questions": [
    {
      "prompt": "Содержательный вопрос по теме курса?",
      "options": ["Правильный ответ", "Неправильный вариант 1", "Неправильный вариант 2", "Неправильный вариант 3"],
      "correctOptionIndex": 0,
      "explanation": "Пояснение почему ответ правильный"
    }
  ]
}`
  };
}

async function callOllama(config, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 min
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        format: "json",
        options: {
          temperature: config.temperature ?? 0.7,
          num_ctx: config.maxTokens >= 32000 ? 65536 : 32768,
          num_predict: config.maxTokens || 8192
        },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ]
      })
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Ollama: ${response.status} ${errText.slice(0, 200)}`);
    }
    const payload = await response.json();
    return payload?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAiCompatible(config, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens || 64000,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ]
      })
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI: ${response.status} ${errText.slice(0, 200)}`);
    }
    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

async function callLlm(config, prompt) {
  if (config.provider === "openai-compatible") {
    return await callOpenAiCompatible(config, prompt);
  }
  return await callOllama(config, prompt);
}

async function generateAndParse(config, prompt, label) {
  try {
    const raw = await callLlm(config, prompt);
    console.log(`[LLM] ${label}: response ${raw?.length || 0} chars`);
    if (!raw || raw.trim().length === 0) return null;
    const parsed = extractJson(raw);
    if (!parsed) console.error(`[LLM] ${label}: could not parse JSON`);
    return parsed;
  } catch (err) {
    console.error(`[LLM] ${label} failed:`, err.message);
    return null;
  }
}

export async function createOutlineFromLocalLlm(input, fileChunks = []) {
  const config = input.generation;
  if (!config || config.provider === "template") {
    return null;
  }

  const { structure } = input;
  const modules = [];

  if (fileChunks.length > 0) {
    console.log(`[LLM] Using ${fileChunks.length} file chunks as context`);
  }

  // Generate each module separately
  for (let i = 0; i < structure.moduleCount; i++) {
    console.log(`[LLM] Generating module ${i + 1}/${structure.moduleCount}...`);
    const prompt = createModulePrompt(input, i);
    // Inject file chunks into user prompt (max 3 per module to avoid context overflow)
    if (fileChunks.length > 0) {
      const chunksPerModule = Math.ceil(fileChunks.length / structure.moduleCount);
      const start = i * chunksPerModule;
      const relevantChunks = fileChunks.slice(start, start + chunksPerModule).slice(0, 3);
      if (relevantChunks.length > 0) {
        const contextText = relevantChunks.join("\n---\n");
        console.log(`[LLM] Module ${i + 1}: injecting ${relevantChunks.length} chunks (${contextText.length} chars)`);
        prompt.user += `\n\nИСПОЛЬЗУЙ ИСКЛЮЧИТЕЛЬНО ЭТОТ МАТЕРИАЛ КАК ОСНОВУ ДЛЯ КОНТЕНТА (НЕ ПРИДУМЫВАЙ ИНФОРМАЦИЮ, БЕРИ ТОЛЬКО ИЗ МАТЕРИАЛА):\n${contextText}`;
      }
    }
    const moduleData = await generateAndParse(config, prompt, `Module ${i + 1}`);
    modules.push(moduleData || null);
  }

  // Generate final test
  let finalTest = null;
  if (input.finalTest.enabled && input.finalTest.questionCount > 0) {
    console.log(`[LLM] Generating final test (${input.finalTest.questionCount} questions)...`);
    const testPrompt = createTestPrompt(input);
    finalTest = await generateAndParse(config, testPrompt, "Final test");
  }

  // Check if we got at least some content
  const validModules = modules.filter(Boolean);
  if (validModules.length === 0 && !finalTest) {
    console.error("[LLM] No content generated at all");
    return null;
  }

  console.log(`[LLM] Generated ${validModules.length}/${structure.moduleCount} modules, test: ${finalTest ? "yes" : "no"}`);

  return {
    title: input.titleHint,
    description: `Курс "${input.titleHint}" для аудитории "${input.audience}". Длительность: ${input.durationMinutes} минут.`,
    modules,
    finalTest
  };
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();

  // 1) Try direct parse
  try { return JSON.parse(trimmed); } catch { /* continue */ }

  // 2) Extract from ```json ... ``` code blocks
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()); } catch { /* continue */ }
  }

  // 3) Find first { ... } or [ ... ] block
  const start = trimmed.search(/[{\[]/);
  if (start >= 0) {
    const openChar = trimmed[start];
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === openChar) depth++;
      else if (trimmed[i] === closeChar) depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { break; }
      }
    }
  }

  return null;
}

export function buildCourseFromOutline(input, outline) {
  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => {
    const moduleSource = outline?.modules?.[moduleIndex] ?? {};

    // Collect ALL screens from whatever nesting the LLM returned
    const allScreens = [];
    function collectScreens(obj) {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj.blocks)) {
        allScreens.push({ title: obj.title || "", blocks: obj.blocks });
        return;
      }
      for (const key of ["screens", "scos", "sections", "lessons", "slides", "pages"]) {
        if (Array.isArray(obj[key])) {
          for (const child of obj[key]) collectScreens(child);
        }
      }
    }
    collectScreens(moduleSource);

    let screenIdx = 0;
    return {
      id: createId("module"),
      title: toPlainText(moduleSource.title, `Модуль ${moduleIndex + 1}`),
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => {
        const sectionSource = moduleSource.sections?.[sectionIndex] ?? {};
        return {
          id: createId("section"),
          title: toPlainText(sectionSource.title, `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`),
          order: sectionIndex + 1,
          scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => {
            const scoSource = sectionSource.scos?.[scoIndex] ?? {};
            return {
              id: createId("sco"),
              title: toPlainText(scoSource.title, `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`),
              order: scoIndex + 1,
              screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
                // Try exact path first, then sequential from flattened list
                const exactScreen = scoSource.screens?.[screenIndex];
                const flatScreen = allScreens[screenIdx];
                screenIdx++;
                const screenSource = exactScreen?.blocks ? exactScreen : (flatScreen || {});
                const screenTitle = toPlainText(screenSource.title, `Экран ${screenIndex + 1}`);
                return {
                  id: createId("screen"),
                  title: screenTitle,
                  order: screenIndex + 1,
                  blocks: normalizeBlocks(
                    screenSource.blocks,
                    screenTitle,
                    `Экран ${screenIndex + 1} раскрывает тему "${input.titleHint}" для аудитории "${input.audience}".`
                  )
                };
              })
            };
          })
        };
      })
    };
  });

  const questions = Array.from({ length: input.finalTest.questionCount }, (_, questionIndex) => {
    const questionSource = outline?.finalTest?.questions?.[questionIndex] ?? {};
    const normalized = normalizeOptions(questionSource, questionIndex);
    return {
      id: createId("question"),
      prompt: toPlainText(questionSource.prompt, `Контрольный вопрос ${questionIndex + 1}`),
      options: normalized.options,
      correctOptionId: normalized.correctOptionId,
      explanation: normalized.explanation
    };
  });

  return {
    id: createId("course"),
    title: toPlainText(outline?.title, input.titleHint),
    description: toPlainText(
      outline?.description,
      `Автоматически созданный курс для аудитории "${input.audience}". Длительность: около ${input.durationMinutes} минут.`
    ),
    language: input.language,
    generation: input.generation,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest: {
      id: createId("final_test"),
      enabled: input.finalTest.enabled,
      title: toPlainText(outline?.finalTest?.title, "Итоговый тест"),
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}
