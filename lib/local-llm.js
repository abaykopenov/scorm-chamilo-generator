import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";

function toPlainText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function looksLikeEmbeddingModel(modelName) {
  return /(embed|embedding|bge|e5|mxbai|nomic-embed)/i.test(`${modelName || ""}`);
}

function buildSourceContext(input, limits = {}) {
  const maxItems = Math.max(1, Math.min(12, Number(limits.maxItems) || Math.min(8, Number(input?.rag?.topK) || 6)));
  const maxChars = Math.max(200, Math.min(1400, Number(limits.maxChars) || 900));

  return Array.isArray(input?.ragContext?.chunks)
    ? input.ragContext.chunks.slice(0, maxItems).map((chunk, index) => ({
        order: index + 1,
        source: chunk.fileName || chunk.materialId || `source_${index + 1}`,
        score: chunk.score,
        text: `${chunk.text || ""}`.slice(0, maxChars)
      }))
    : [];
}

function parseJsonFromLlmText(raw) {
  if (typeof raw !== "string") {
    throw new Error("LLM returned non-text response.");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("LLM returned empty response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatches = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fencedMatches) {
    const unwrapped = block.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(unwrapped);
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  const preview = trimmed.slice(0, 120).replace(/\s+/g, " ");
  throw new Error(`Model did not return valid JSON. Preview: ${preview}`);
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

function createOutlineJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "modules", "finalTest"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      modules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "sections"],
          properties: {
            title: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "scos"],
                properties: {
                  title: { type: "string" },
                  scos: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["title", "screens"],
                      properties: {
                        title: { type: "string" },
                        screens: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["title", "blocks"],
                            properties: {
                              title: { type: "string" },
                              blocks: {
                                type: "array",
                                items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["type"],
                                  properties: {
                                    type: { type: "string", enum: ["text", "note", "list"] },
                                    text: { type: "string" },
                                    items: {
                                      type: "array",
                                      items: { type: "string" }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      finalTest: {
        type: "object",
        additionalProperties: false,
        required: ["title", "questions"],
        properties: {
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["prompt", "options", "correctOptionIndex", "explanation"],
              properties: {
                prompt: { type: "string" },
                options: {
                  type: "array",
                  minItems: 4,
                  items: { type: "string" }
                },
                correctOptionIndex: { type: "number" },
                explanation: { type: "string" }
              }
            }
          }
        }
      }
    }
  };
}

function createPrompt(input) {
  const sourceContext = buildSourceContext(input, { maxItems: 8, maxChars: 900 });

  const system = [
    "Сгенерируй JSON для e-learning курса без markdown и без пояснений.",
    "Ответ должен быть строго валидным JSON объектом.",
    "Соблюдай заданную структуру и количество элементов.",
    "Не добавляй лишние поля вне запрошенной схемы.",
    "Не используй шаблонные фразы вроде 'Экран X раскрывает тему/цель'. Пиши предметный контент.",
    sourceContext.length > 0
      ? "Используй sourceContext как первичный материал при формировании тем, экранов и вопросов."
      : "Если sourceContext пустой, опирайся только на бриф пользователя."
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
      sourceContext,
      schema: createOutlineJsonSchema()
    }
  };
}

function createRepairPrompt(input, invalidResponse, parseErrorMessage) {
  return {
    system: [
      "Твоя задача: преобразовать черновой ответ модели в строго валидный JSON курса.",
      "Верни только JSON-объект и ничего больше.",
      "Без markdown, без пояснений, без комментариев.",
      "Строго соблюдай schema."
    ].join(" "),
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      structure: input.structure,
      finalTest: input.finalTest,
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 16_000),
      schema: createOutlineJsonSchema()
    }
  };
}

function createLinePlanPrompt(input) {
  const sourceContext = buildSourceContext(input, { maxItems: 10, maxChars: 1000 });
  const screenCount =
    Number(input?.structure?.moduleCount || 1) *
    Number(input?.structure?.sectionsPerModule || 1) *
    Number(input?.structure?.scosPerSection || 1) *
    Number(input?.structure?.screensPerSco || 1);
  const topicCount = Math.max(4, Math.min(18, screenCount));
  const questionCount = Math.max(1, Number(input?.finalTest?.questionCount || 8));

  return {
    system: [
      "Сгенерируй план курса и тест строго в формате строк без JSON и без markdown.",
      "Нельзя добавлять пояснения до или после строк.",
      "Структура строк:",
      "TITLE|...",
      "DESCRIPTION|...",
      "TOPIC|<title>|<explanation>|<bullet1>; <bullet2>; <bullet3>",
      "QUESTION|<prompt>|<option1>|<option2>|<option3>|<option4>|<correctOptionIndex1to4>|<explanation>",
      "Все TOPIC и QUESTION должны опираться на sourceContext.",
      "Нельзя использовать шаблонные фразы вроде 'Экран X раскрывает цель'."
    ].join(" "),
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      requiredTopicCount: topicCount,
      requiredQuestionCount: questionCount,
      sourceContext
    }
  };
}

function createLinePlanRepairPrompt(input, invalidResponse, parseErrorMessage) {
  const sourceContext = buildSourceContext(input, { maxItems: 8, maxChars: 800 });
  const questionCount = Math.max(1, Number(input?.finalTest?.questionCount || 8));

  return {
    system: [
      "Переформатируй черновой ответ модели в строгие строки без JSON и без markdown.",
      "Разрешены только строки TITLE|, DESCRIPTION|, TOPIC| и QUESTION|.",
      "Сохрани предметный смысл и связь с sourceContext."
    ].join(" "),
    user: {
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 12_000),
      requiredQuestionCount: questionCount,
      sourceContext
    }
  };
}

export function parseLinePlanText(raw, input) {
  if (typeof raw !== "string") {
    throw new Error("LLM returned non-text response.");
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const topics = [];
  const questions = [];
  let title = "";
  let description = "";

  for (const line of lines) {
    if (line.startsWith("TITLE|")) {
      title = line.slice("TITLE|".length).trim();
      continue;
    }
    if (line.startsWith("DESCRIPTION|")) {
      description = line.slice("DESCRIPTION|".length).trim();
      continue;
    }
    if (line.startsWith("TOPIC|")) {
      const parts = line.split("|");
      const topicTitle = `${parts[1] || ""}`.trim();
      const topicText = `${parts[2] || ""}`.trim();
      const bulletText = parts.slice(3).join("|");
      const bullets = bulletText
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3);
      while (bullets.length < 3) {
        bullets.push(`Ключевой вывод ${bullets.length + 1}`);
      }
      topics.push({
        title: topicTitle || `Тема ${topics.length + 1}`,
        text: topicText || `Краткое объяснение темы ${topics.length + 1}.`,
        bullets
      });
      continue;
    }
    if (line.startsWith("QUESTION|")) {
      const parts = line.split("|");
      if (parts.length < 8) {
        continue;
      }
      const prompt = `${parts[1] || ""}`.trim();
      const optionTexts = [
        `${parts[2] || ""}`.trim(),
        `${parts[3] || ""}`.trim(),
        `${parts[4] || ""}`.trim(),
        `${parts[5] || ""}`.trim()
      ];
      const parsedIndex = Math.trunc(Number(parts[6])) - 1;
      const correctOptionIndex = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(3, parsedIndex)) : 0;
      const explanation = parts.slice(7).join("|").trim();
      const normalizedOptions = optionTexts.map((option, index) => option || `Вариант ${index + 1}`);

      questions.push({
        prompt: prompt || `Контрольный вопрос ${questions.length + 1}`,
        options: normalizedOptions,
        correctOptionIndex,
        explanation: explanation || `Пояснение к вопросу ${questions.length + 1}.`
      });
    }
  }

  const requiredQuestions = Math.max(1, Number(input?.finalTest?.questionCount || 8));
  while (questions.length < requiredQuestions) {
    questions.push({
      prompt: `Контрольный вопрос ${questions.length + 1}`,
      options: ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
      correctOptionIndex: 0,
      explanation: `Пояснение к вопросу ${questions.length + 1}.`
    });
  }

  if (topics.length === 0) {
    throw new Error("Plan output did not contain TOPIC lines.");
  }

  return {
    title: title || `${input?.titleHint || "Курс"}`.trim(),
    description: description || `Курс для аудитории "${input?.audience || "слушатели"}".`,
    topics,
    questions: questions.slice(0, requiredQuestions)
  };
}

async function fetchWithNetworkHint(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown network error";
    throw new Error(`${label} endpoint is unreachable: ${url}. ${reason}`);
  }
}

async function callOllama(config, prompt, options = {}) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const chatUrl = `${baseUrl}/api/chat`;
  try {
    const jsonFormat = options?.format;
    const response = await fetchWithNetworkHint(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        think: false,
        ...(jsonFormat ? { format: jsonFormat } : {}),
        options: {
          temperature: config.temperature
        },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: JSON.stringify(prompt.user) }
        ]
      })
    }, "Ollama");

    if (!response.ok) {
      throw new Error(`Ollama chat request failed with status ${response.status} (${chatUrl})`);
    }
    const payload = await response.json();
    const content = payload?.message?.content ?? "";
    if (content) {
      return content;
    }
    throw new Error("Ollama chat response is empty.");
  } catch {
    const url = `${baseUrl}/api/generate`;
    const jsonMode = options?.jsonMode !== false;
    const response = await fetchWithNetworkHint(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        ...(jsonMode ? { format: "json" } : {}),
        think: false,
        options: {
          temperature: config.temperature
        },
        prompt: `${prompt.system}\n\n${JSON.stringify(prompt.user, null, 2)}`
      })
    }, "Ollama");

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status} (${url})`);
    }

    const payload = await response.json();
    return payload?.response ?? "";
  }
}

async function callOpenAiCompatible(config, prompt, options = {}) {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const jsonMode = options?.jsonMode !== false;
  const response = await fetchWithNetworkHint(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: JSON.stringify(prompt.user, null, 2) }
      ]
    })
  }, "OpenAI-compatible");

  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed with status ${response.status} (${url})`);
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content ?? "";
}

async function callProvider(config, prompt, options = {}) {
  return config.provider === "openai-compatible"
    ? callOpenAiCompatible(config, prompt, options)
    : callOllama(config, prompt, options);
}

export async function checkLocalLlmConnection(config) {
  if (!config || config.provider === "template") {
    return {
      ok: true,
      provider: "template",
      message: "Шаблонный режим не требует внешнего подключения."
    };
  }

  const baseUrl = `${config.baseUrl || ""}`.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("Base URL for local LLM is required.");
  }

  if (config.provider === "ollama") {
    const tagsUrl = `${baseUrl}/api/tags`;
    const response = await fetchWithNetworkHint(tagsUrl, undefined, "Ollama");
    if (!response.ok) {
      throw new Error(`Ollama check failed with status ${response.status} (${tagsUrl})`);
    }
    const payload = await response.json();
    const names = Array.isArray(payload?.models) ? payload.models.map((model) => model.name).filter(Boolean) : [];
    const hasModel = names.includes(config.model);
    const embeddingWarning = looksLikeEmbeddingModel(config.model)
      ? " Внимание: это embedding-модель, она не подходит для генерации текста."
      : "";
    return {
      ok: true,
      provider: "ollama",
      message: hasModel
        ? `Ollama доступен. Модель ${config.model} найдена.${embeddingWarning}`
        : `Ollama доступен. Модель ${config.model} не найдена среди: ${names.slice(0, 5).join(", ") || "список пуст"}.${embeddingWarning}`
    };
  }

  const modelsUrl = `${baseUrl}/models`;
  const response = await fetchWithNetworkHint(modelsUrl, undefined, "OpenAI-compatible");
  if (!response.ok) {
    throw new Error(`OpenAI-compatible check failed with status ${response.status} (${modelsUrl})`);
  }
  const payload = await response.json();
  const modelIds = Array.isArray(payload?.data) ? payload.data.map((item) => item.id).filter(Boolean) : [];
  const hasModel = modelIds.includes(config.model);
  const embeddingWarning = looksLikeEmbeddingModel(config.model)
    ? " Внимание: это embedding-модель, она не подходит для генерации текста."
    : "";
  return {
    ok: true,
    provider: "openai-compatible",
    message: hasModel
      ? `OpenAI-compatible endpoint доступен. Модель ${config.model} найдена.${embeddingWarning}`
      : `Endpoint доступен. Модель ${config.model} не найдена среди: ${modelIds.slice(0, 5).join(", ") || "список пуст"}.${embeddingWarning}`
  };
}

export async function createOutlineFromLocalLlm(input, options = {}) {
  const strict = Boolean(options?.strict);
  const config = input.generation;
  if (!config || config.provider === "template") {
    if (strict) {
      throw new Error("LLM provider is template mode. Switch provider to Ollama or OpenAI-compatible.");
    }
    return null;
  }

  if (looksLikeEmbeddingModel(config.model)) {
    const message = `Модель ${config.model} похожа на embedding-модель и не подходит для генерации курса. ` +
      "Выберите текстовую LLM (например qwen2.5, llama, mistral).";
    if (strict) {
      throw new Error(message);
    }
    console.error(message);
    return null;
  }

  const prompt = createPrompt(input);
  const schema = createOutlineJsonSchema();
  let raw = "";

  try {
    raw = await callProvider(config, prompt, { format: schema, jsonMode: true });
    const parsed = parseJsonFromLlmText(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("LLM response is not a JSON object.");
    }
    return parsed;
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : "Invalid LLM response";
    try {
      const repairPrompt = createRepairPrompt(input, raw, parseMessage);
      const repairedRaw = await callProvider(
        { ...config, temperature: Math.min(0.1, Number(config.temperature) || 0.1) },
        repairPrompt,
        { format: schema, jsonMode: true }
      );
      const repairedParsed = parseJsonFromLlmText(repairedRaw);
      if (repairedParsed && typeof repairedParsed === "object") {
        return repairedParsed;
      }
    } catch {}

    if (strict) {
      const message = error instanceof Error ? error.message : "Local LLM generation failed.";
      throw new Error(`Не удалось сгенерировать курс через LLM: ${message}`);
    }
    console.error("Local LLM generation failed; caller may apply fallback generation mode.", error);
    return null;
  }
}

export async function createLinePlanFromLocalLlm(input, options = {}) {
  const strict = Boolean(options?.strict);
  const config = input.generation;
  if (!config || config.provider === "template") {
    if (strict) {
      throw new Error("LLM provider is template mode. Switch provider to Ollama or OpenAI-compatible.");
    }
    return null;
  }

  if (looksLikeEmbeddingModel(config.model)) {
    const message = `Модель ${config.model} похожа на embedding-модель и не подходит для генерации курса. ` +
      "Выберите текстовую LLM (например qwen2.5, llama, mistral).";
    if (strict) {
      throw new Error(message);
    }
    console.error(message);
    return null;
  }

  const prompt = createLinePlanPrompt(input);
  let raw = "";

  try {
    raw = await callProvider(config, prompt, { jsonMode: false });
    return parseLinePlanText(raw, input);
  } catch (error) {
    const parseMessage = error instanceof Error ? error.message : "Invalid line-plan response";
    try {
      const repairPrompt = createLinePlanRepairPrompt(input, raw, parseMessage);
      const repairedRaw = await callProvider(
        { ...config, temperature: Math.min(0.1, Number(config.temperature) || 0.1) },
        repairPrompt,
        { jsonMode: false }
      );
      return parseLinePlanText(repairedRaw, input);
    } catch {}

    if (strict) {
      const message = error instanceof Error ? error.message : "Local LLM generation failed.";
      throw new Error(`Не удалось сгенерировать курс через LLM (line plan): ${message}`);
    }
    console.error("Local LLM line-plan generation failed; caller may apply fallback generation mode.", error);
    return null;
  }
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
