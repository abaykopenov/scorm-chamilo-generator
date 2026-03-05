import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";
import { buildCourseFromOutline, createLinePlanFromLocalLlm, createOutlineFromLocalLlm } from "./local-llm.js";
import { buildRagContext } from "./rag-service.js";
import { normalizeGenerateInput } from "./validation.js";

function pickGoal(goals, index) {
  if (goals.length === 0) {
    return "Освоить ключевые идеи курса";
  }
  return goals[index % goals.length];
}

function buildBlocks({ moduleIndex, sectionIndex, scoIndex, screenIndex, goal, audience }) {
  const label = `${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
  return [
    {
      type: "text",
      text: `Экран ${label} раскрывает цель "${goal}" для аудитории "${audience}".`
    },
    {
      type: "note",
      text: `Сфокусируйтесь на том, как тема применяется в реальной рабочей ситуации.`
    },
    {
      type: "list",
      items: [
        `Ключевая идея ${label}`,
        `Практический сценарий ${label}`,
        `Мини-вывод для закрепления ${label}`
      ]
    }
  ];
}

function buildQuestion(courseTitle, goal, index) {
  const questionId = createId("question");
  const options = [
    `Фокусируется на цели "${goal}" и применении в работе`,
    `Игнорирует цель и оставляет тему без сценариев`,
    `Переносит решение на внешнюю систему без обучения`,
    `Не требует никакой оценки результата`
  ].map((text) => ({ id: createId("option"), text }));

  return {
    id: questionId,
    prompt: `Что лучше всего отражает изучение темы "${courseTitle}" в вопросе ${index + 1}?`,
    options,
    correctOptionId: options[0].id,
    explanation: `Правильный ответ связан с практическим достижением цели "${goal}".`
  };
}

function buildTemplateDraft(payload) {
  const input = normalizeGenerateInput(payload);

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => ({
    id: createId("module"),
    title: `Модуль ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
    order: moduleIndex + 1,
    sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
      id: createId("section"),
      title: `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`,
      order: sectionIndex + 1,
      scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
        id: createId("sco"),
        title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
        order: scoIndex + 1,
        screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => ({
          id: createId("screen"),
          title: `Экран ${screenIndex + 1}`,
          order: screenIndex + 1,
          blocks: buildBlocks({
            moduleIndex,
            sectionIndex,
            scoIndex,
            screenIndex,
            goal: pickGoal(input.learningGoals, moduleIndex + sectionIndex + scoIndex + screenIndex),
            audience: input.audience
          })
        }))
      }))
    }))
  }));

  const finalTest = {
    id: createId("final_test"),
    enabled: input.finalTest.enabled,
    title: "Итоговый тест",
    questionCount: input.finalTest.questionCount,
    passingScore: input.finalTest.passingScore,
    attemptsLimit: input.finalTest.attemptsLimit,
    maxTimeMinutes: input.finalTest.maxTimeMinutes,
    questions: Array.from({ length: input.finalTest.questionCount }, (_, index) =>
      buildQuestion(input.titleHint, pickGoal(input.learningGoals, index), index)
    )
  };

  return {
    id: createId("course"),
    title: input.titleHint,
    description: `Автоматически созданный курс для аудитории "${input.audience}". Длительность: около ${input.durationMinutes} минут.`,
    language: input.language,
    generation: input.generation,
    rag: input.rag,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest
  };
}

function attachRagMetadata(course, input, ragContext) {
  const contextDocuments = Array.isArray(ragContext?.documents) ? ragContext.documents : [];
  const sourceDocuments = contextDocuments.map((document) => ({
    id: document.id,
    fileName: document.fileName,
    status: document.status
  }));
  const existingRetrieval = course?.rag?.retrieval || {};

  return {
    ...course,
    rag: {
      ...input.rag,
      retrieval: {
        enabled: Boolean(ragContext?.enabled),
        topK: existingRetrieval.topK || ragContext?.topK || input.rag.topK,
        query: existingRetrieval.query || ragContext?.query || "",
        chunksCount: existingRetrieval.chunksCount || (Array.isArray(ragContext?.chunks) ? ragContext.chunks.length : 0),
        message: existingRetrieval.message || ragContext?.message || "",
        mode: existingRetrieval.mode || course?.generation?.mode || "llm"
      }
    },
    sourceDocuments
  };
}

function isStrictRagRequested(input) {
  return Boolean(
    input?.rag?.enabled &&
    Array.isArray(input?.rag?.documentIds) &&
    input.rag.documentIds.length > 0
  );
}

function containsTemplatePlaceholders(course) {
  const placeholderRegex = /Экран\s+\d+(?:\.\d+){0,4}\s+раскрывает\s+(?:цель|тему)/i;
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

function stripExtension(fileName) {
  return `${fileName || ""}`.replace(/\.[^.]+$/, "").trim();
}

function firstSentence(text, fallback) {
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

function sentencePoolFromText(text) {
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

function summarizeChunkForScreen(text, fallback) {
  const sentences = sentencePoolFromText(text);
  if (sentences.length === 0) {
    return {
      text: fallback,
      bullets: ["Ключевая идея", "Практическая польза", "Что применить на практике"]
    };
  }

  const main = sentences.slice(0, 2).join(" ");
  const bullets = sentences.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`Ключевой вывод ${bullets.length + 1}`);
  }

  return {
    text: main.slice(0, 520),
    bullets
  };
}

function rotateList(values, offset) {
  const list = [...values];
  if (list.length === 0) {
    return list;
  }
  const shift = ((offset % list.length) + list.length) % list.length;
  return list.slice(shift).concat(list.slice(0, shift));
}

function toBulletItems(text) {
  const cleaned = `${text || ""}`.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return ["Ключевая идея из источника", "Практический вывод", "Что применить в работе"];
  }

  const parts = cleaned
    .split(/[.;!?]\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const bullets = parts.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`Ключевой вывод ${bullets.length + 1}`);
  }
  return bullets;
}

function normalizePlanOptionTexts(options, questionIndex) {
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
    const fallback = `Вариант ${result.length + 1} для вопроса ${questionIndex + 1}`;
    result.push(fallback);
  }

  return result;
}

function buildCourseFromLinePlan(input, plan) {
  const topics = Array.isArray(plan?.topics) ? plan.topics.filter(Boolean) : [];
  if (topics.length === 0) {
    return null;
  }

  let topicCursor = 0;
  const nextTopic = () => {
    const topic = topics[topicCursor % topics.length];
    topicCursor += 1;
    return topic;
  };

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => {
    const moduleSeed = nextTopic();
    const moduleTitle = `${moduleSeed?.title || ""}`.trim() || `Тема ${moduleIndex + 1}`;

    return {
      id: createId("module"),
      title: `Модуль ${moduleIndex + 1}: ${moduleTitle}`,
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
        id: createId("section"),
        title: `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`,
        order: sectionIndex + 1,
        scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
          id: createId("sco"),
          title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
          order: scoIndex + 1,
          screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
            const topic = nextTopic();
            const title = `${topic?.title || ""}`.trim() || `Тема ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
            const text = `${topic?.text || ""}`.trim() || `Краткое объяснение темы "${title}".`;
            const bullets = toBulletItems(Array.isArray(topic?.bullets) ? topic.bullets.join(". ") : topic?.text || "");

            return {
              id: createId("screen"),
              title,
              order: screenIndex + 1,
              blocks: [
                {
                  type: "text",
                  text: text.slice(0, 560)
                },
                {
                  type: "note",
                  text: `Фокус для аудитории "${input.audience}".`
                },
                {
                  type: "list",
                  items: bullets
                }
              ]
            };
          })
        }))
      }))
    };
  });

  const baseQuestions = Array.isArray(plan?.questions) ? plan.questions : [];
  const questions = Array.from({ length: input.finalTest.questionCount }, (_, questionIndex) => {
    const sourceQuestion = baseQuestions[questionIndex % Math.max(1, baseQuestions.length)] || {};
    const optionTexts = normalizePlanOptionTexts(sourceQuestion.options, questionIndex);
    const options = optionTexts.map((text) => ({
      id: createId("option"),
      text
    }));
    const parsedIndex = Math.trunc(Number(sourceQuestion.correctOptionIndex));
    const clampedIndex = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(options.length - 1, parsedIndex)) : 0;

    return {
      id: createId("question"),
      prompt: `${sourceQuestion.prompt || `Контрольный вопрос ${questionIndex + 1}`}`.slice(0, 240),
      options,
      correctOptionId: options[clampedIndex].id,
      explanation: `${sourceQuestion.explanation || `Проверка понимания по теме ${questionIndex + 1}.`}`.slice(0, 240)
    };
  });

  return {
    id: createId("course"),
    title: `${plan?.title || input.titleHint}`.trim() || input.titleHint,
    description: `${plan?.description || `Курс для аудитории "${input.audience}".`}`.trim(),
    language: input.language,
    generation: {
      ...input.generation,
      mode: "llm-line-plan"
    },
    rag: input.rag,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest: {
      id: createId("final_test"),
      enabled: input.finalTest.enabled,
      title: "Итоговый тест",
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}

function buildCourseFromRagChunks(input, ragContext) {
  const chunks = Array.isArray(ragContext?.chunks)
    ? ragContext.chunks.filter((chunk) => `${chunk?.text || ""}`.trim())
    : [];

  if (chunks.length === 0) {
    return null;
  }

  let cursor = 0;
  const nextChunk = () => {
    const chunk = chunks[cursor % chunks.length];
    cursor += 1;
    return chunk;
  };

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => {
    const seed = nextChunk();
    const moduleTopic = firstSentence(seed.text, stripExtension(seed.fileName) || `Тема ${moduleIndex + 1}`);
    return {
      id: createId("module"),
      title: `Модуль ${moduleIndex + 1}: ${moduleTopic}`,
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
        id: createId("section"),
        title: `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`,
        order: sectionIndex + 1,
        scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
          id: createId("sco"),
          title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
          order: scoIndex + 1,
          screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
            const source = nextChunk();
            const snippet = `${source.text || ""}`.trim().slice(0, 900);
            const sourceName = source.fileName || `source_${source.materialId || "unknown"}`;
            const summary = summarizeChunkForScreen(
              snippet,
              `Материал из источника ${sourceName}.`
            );
            return {
              id: createId("screen"),
              title: `Ключевые идеи ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`,
              order: screenIndex + 1,
              blocks: [
                {
                  type: "text",
                  text: summary.text
                },
                {
                  type: "note",
                  text: `Источник: ${sourceName}`
                },
                {
                  type: "list",
                  items: summary.bullets.length > 0 ? summary.bullets : toBulletItems(snippet)
                }
              ]
            };
          })
        }))
      }))
    };
  });

  const statementPool = chunks
    .flatMap((chunk) => sentencePoolFromText(chunk.text))
    .filter(Boolean);
  const fallbackStatements = chunks.map((chunk) =>
    firstSentence(chunk.text, "Ключевой тезис из источника.")
  );
  const allStatements = [...statementPool, ...fallbackStatements].filter(Boolean);

  const questions = Array.from({ length: input.finalTest.questionCount }, (_, index) => {
    const source = chunks[index % chunks.length];
    const correctStatement = allStatements[index % allStatements.length] || `Ключевой тезис ${index + 1}`;
    const wrongCandidates = allStatements.filter((item) => item !== correctStatement);
    const wrongOptions = wrongCandidates.slice(index % Math.max(1, wrongCandidates.length), (index % Math.max(1, wrongCandidates.length)) + 3);
    while (wrongOptions.length < 3) {
      wrongOptions.push(`Утверждение не соответствует содержанию материалов (${wrongOptions.length + 1})`);
    }

    const optionTexts = rotateList(
      [correctStatement, ...wrongOptions.slice(0, 3)],
      index % 4
    ).map((text) => `${text}`.slice(0, 180));

    const options = optionTexts.map((text) => ({
      id: createId("option"),
      text
    }));
    const correctOptionText = correctStatement.slice(0, 180);
    const correct = options.find((option) => option.text === correctOptionText) || options[0];

    return {
      id: createId("question"),
      prompt: `Какое утверждение соответствует материалам курса по вопросу ${index + 1}?`,
      options,
      correctOptionId: correct.id,
      explanation: `В источнике "${source?.fileName || "материал"}" поддерживается вариант: ${correctOptionText}`
    };
  });

  return {
    id: createId("course"),
    title: input.titleHint,
    description: `Курс построен на основе загруженных материалов (${chunks.length} релевантных фрагментов).`,
    language: input.language,
    generation: {
      ...input.generation,
      mode: "rag-extractive-fallback"
    },
    rag: input.rag,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest: {
      id: createId("final_test"),
      enabled: input.finalTest.enabled,
      title: "Итоговый тест",
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}

export async function generateCourseDraft(payload) {
  const input = normalizeGenerateInput(payload);
  const strictRag = isStrictRagRequested(input);

  const ragContext = await buildRagContext(input);
  if (strictRag && (!Array.isArray(ragContext.chunks) || ragContext.chunks.length === 0)) {
    throw new Error(
      `Не найден контекст из выбранных материалов. ${ragContext.message || "Проверьте индексацию книг и embedding model."}`
    );
  }

  let outline = null;
  let llmFailureMessage = "";
  let linePlan = null;
  let linePlanFailureMessage = "";
  try {
    outline = await createOutlineFromLocalLlm({
      ...input,
      ragContext
    }, { strict: false });
  } catch (error) {
    llmFailureMessage = error instanceof Error ? error.message : "LLM call failed";
  }

  if (outline) {
    const course = buildCourseFromOutline(input, outline);
    if (strictRag && containsTemplatePlaceholders(course)) {
      try {
        linePlan = await createLinePlanFromLocalLlm({
          ...input,
          ragContext
        }, { strict: false });
      } catch (error) {
        linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
      }
      const planCourse = buildCourseFromLinePlan(input, linePlan);
      if (planCourse) {
        planCourse.rag = {
          ...input.rag,
          retrieval: {
            enabled: true,
            topK: ragContext.topK,
            query: ragContext.query,
            chunksCount: ragContext.chunks.length,
            mode: "llm-line-plan",
            message: `LLM вернула шаблонный JSON. Применена генерация через line-plan с контекстом материалов.`
          }
        };
        return attachRagMetadata(planCourse, input, ragContext);
      }

      const extractiveCourse = buildCourseFromRagChunks(input, ragContext);
      if (extractiveCourse) {
        extractiveCourse.rag = {
          ...input.rag,
          retrieval: {
            enabled: true,
            topK: ragContext.topK,
            query: ragContext.query,
            chunksCount: ragContext.chunks.length,
            mode: "rag-extractive-fallback",
            message: `LLM вернула шаблонный контент, применен extractive fallback из материалов.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}`
          }
        };
        return attachRagMetadata(extractiveCourse, input, ragContext);
      }
      throw new Error("LLM вернула шаблонный контент. Увеличьте Top-K, проверьте книги и модель генерации.");
    }
    return attachRagMetadata(course, input, ragContext);
  }

  if (strictRag) {
    try {
      linePlan = await createLinePlanFromLocalLlm({
        ...input,
        ragContext
      }, { strict: false });
    } catch (error) {
      linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
    }
    const planCourse = buildCourseFromLinePlan(input, linePlan);
    if (planCourse) {
      planCourse.rag = {
        ...input.rag,
        retrieval: {
          enabled: true,
          topK: ragContext.topK,
          query: ragContext.query,
          chunksCount: ragContext.chunks.length,
          mode: "llm-line-plan",
          message: `LLM не вернула валидный JSON, применена генерация через line-plan с контекстом материалов.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}`
        }
      };
      return attachRagMetadata(planCourse, input, ragContext);
    }

    const extractiveCourse = buildCourseFromRagChunks(input, ragContext);
    if (extractiveCourse) {
      extractiveCourse.rag = {
        ...input.rag,
        retrieval: {
          enabled: true,
          topK: ragContext.topK,
          query: ragContext.query,
          chunksCount: ragContext.chunks.length,
          mode: "rag-extractive-fallback",
          message: `LLM не вернула валидный JSON, применен extractive fallback из материалов.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}`
        }
      };
      return attachRagMetadata(extractiveCourse, input, ragContext);
    }
    throw new Error("LLM не вернула структуру курса и fallback по материалам не сработал.");
  }

  return attachRagMetadata(buildTemplateDraft(payload), input, ragContext);
}
