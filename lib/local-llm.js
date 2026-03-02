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

function createPrompt(input) {
  const system = [
    "Сгенерируй JSON для e-learning курса без markdown и без пояснений.",
    "Ответ должен быть строго валидным JSON объектом.",
    "Соблюдай заданную структуру и количество элементов.",
    "Не добавляй лишние поля вне запрошенной схемы."
  ].join(" ");

  return {
    system,
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      structure: input.structure,
      finalTest: input.finalTest,
      schema: {
        title: "string",
        description: "string",
        modules: [
          {
            title: "string",
            sections: [
              {
                title: "string",
                scos: [
                  {
                    title: "string",
                    screens: [
                      {
                        title: "string",
                        blocks: [
                          {
                            type: "text | note | list",
                            text: "string for text/note",
                            items: ["string for list"]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ],
        finalTest: {
          title: "string",
          questions: [
            {
              prompt: "string",
              options: ["string", "string", "string", "string"],
              correctOptionIndex: 0,
              explanation: "string"
            }
          ]
        }
      }
    }
  };
}

async function callOllama(config, prompt) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format: "json",
      options: {
        temperature: config.temperature
      },
      prompt: `${prompt.system}\n\n${JSON.stringify(prompt.user, null, 2)}`
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return payload?.response ?? "";
}

async function callOpenAiCompatible(config, prompt) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: JSON.stringify(prompt.user, null, 2) }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content ?? "";
}

export async function createOutlineFromLocalLlm(input) {
  const config = input.generation;
  if (!config || config.provider === "template") {
    return null;
  }

  const prompt = createPrompt(input);

  try {
    const raw = config.provider === "openai-compatible"
      ? await callOpenAiCompatible(config, prompt)
      : await callOllama(config, prompt);

    console.log("LLM raw response (first 500 chars):", typeof raw, raw ? raw.slice(0, 500) : "(empty)");

    if (!raw || raw.trim().length === 0) {
      console.error("LLM returned empty response. Check model and prompt.");
      return null;
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      console.error("Could not parse JSON from LLM response. Raw:", raw.slice(0, 300));
    }
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.error("Local LLM generation failed, falling back to template draft.", error);
    return null;
  }
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
                const screenSource = scoSource.screens?.[screenIndex] ?? {};
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
