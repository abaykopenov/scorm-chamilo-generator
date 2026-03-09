import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";
import { buildCourseFromOutline, createLinePlanFromLocalLlm, createOutlineFromLocalLlm } from "./local-llm.js";
import { buildRagContext } from "./rag-service.js";
import { postprocessGeneratedCourse } from "./course-postprocess.js";
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

function finalizeGeneratedCourse(course, input, ragContext) {
  const normalized = postprocessGeneratedCourse(course, input);
  return attachRagMetadata(normalized, input, ragContext);
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

function evaluateLinePlanQuality(plan) {
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

  const sourceSentencePool = Array.isArray(input?.ragContext?.chunks)
    ? input.ragContext.chunks.flatMap((chunk) => sentencePoolFromText(chunk?.text || ""))
    : [];
  let sourceCursor = 0;
  const nextSourceSentence = () => {
    if (sourceSentencePool.length === 0) {
      return "";
    }
    const sentence = sourceSentencePool[sourceCursor % sourceSentencePool.length];
    sourceCursor += 1;
    return `${sentence || ""}`.trim();
  };

  const genericTopicTextPattern = /^(?:\u043a\u0440\u0430\u0442\u043a\u043e\u0435\s+\u043e\u0431\u044a\u044f\u0441\u043d\u0435\u043d\u0438\u0435\s+\u0442\u0435\u043c\u044b|topic\s+\d+|topic explanation|description of topic)/i;

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
            const rawTopicText = `${topic?.text || ""}`.trim();
            const bulletSeed = Array.isArray(topic?.bullets) ? topic.bullets.join(". ") : "";
            const sourceSeed = nextSourceSentence();
            const genericTopicText = !rawTopicText || genericTopicTextPattern.test(rawTopicText);
            const textSeed = genericTopicText
              ? (bulletSeed || sourceSeed || `${title}.`)
              : rawTopicText;
            const text = textSeed.length >= 120
              ? textSeed
              : [textSeed, sourceSeed].filter(Boolean).join(" ").trim();
            const bullets = toBulletItems(bulletSeed || text || rawTopicText);

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
    const moduleTopic = firstSentence(seed.text, stripExtension(seed.fileName) || `Тема ${moduleIndex + 1}`)
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim();
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
              title: firstSentence(
                summary.bullets?.[0] || snippet,
                `Тема ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`
              ).slice(0, 96),
              order: screenIndex + 1,
              blocks: [
                {
                  type: "text",
                  text: summary.text
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

async function generateCourseDraftLegacy(payload) {
  const input = normalizeGenerateInput(payload);
  const strictRag = isStrictRagRequested(input);

  const ragContext = await buildRagContext(input);
  if (strictRag && (!Array.isArray(ragContext.chunks) || ragContext.chunks.length === 0)) {
    throw new Error(
      `No context found for selected documents. ${ragContext.message || "Check indexing and embedding model."}`
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
    }, { strict: false, trace: { stage: "legacy-outline" } });
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
        }, { strict: false, trace: { stage: "legacy-lineplan-template-fallback" } });
      } catch (error) {
        linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
      }
      const planCourse = buildCourseFromLinePlan(input, linePlan);
      const linePlanQuality = evaluateLinePlanQuality(linePlan);
      if (planCourse && !containsTemplatePlaceholders(planCourse) && linePlanQuality.ok) {
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
        return finalizeGeneratedCourse(planCourse, input, ragContext);
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
        return finalizeGeneratedCourse(extractiveCourse, input, ragContext);
      }
      throw new Error("LLM вернула шаблонный контент. Увеличьте Top-K, проверьте книги и модель генерации.");
    }
    return finalizeGeneratedCourse(course, input, ragContext);
  }

  if (strictRag) {
    try {
      linePlan = await createLinePlanFromLocalLlm({
        ...input,
        ragContext
      }, { strict: false, trace: { stage: "legacy-lineplan-no-outline" } });
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
      return finalizeGeneratedCourse(planCourse, input, ragContext);
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
      return finalizeGeneratedCourse(extractiveCourse, input, ragContext);
    }
    throw new Error("LLM не вернула структуру курса и fallback по материалам не сработал.");
  }

  return finalizeGeneratedCourse(buildTemplateDraft(payload), input, ragContext);
}


function isLlmTimeoutErrorMessage(message) {
  return /timeout|aborted|timed out/i.test(`${message || ""}`);
}

function isLlmTransientConnectivityErrorMessage(message) {
  return /endpoint is unreachable|fetch failed|network error|econnreset|socket hang up|status 5\d\d/i.test(`${message || ""}`);
}

function getStructureSize(input) {
  const moduleCount = Math.max(1, Math.trunc(Number(input?.structure?.moduleCount) || 1));
  const sectionsPerModule = Math.max(1, Math.trunc(Number(input?.structure?.sectionsPerModule) || 1));
  const scosPerSection = Math.max(1, Math.trunc(Number(input?.structure?.scosPerSection) || 1));
  const screensPerSco = Math.max(1, Math.trunc(Number(input?.structure?.screensPerSco) || 1));
  const screensPerModule = sectionsPerModule * scosPerSection * screensPerSco;
  const totalScreens = moduleCount * screensPerModule;

  return {
    moduleCount,
    sectionsPerModule,
    scosPerSection,
    screensPerSco,
    screensPerModule,
    totalScreens
  };
}

function isLikelyLargeModel(modelName) {
  return /(?:^|[^\d])(3\d|4\d|5\d|6\d|7\d|8\d|9\d|1\d{2,3})b(?:$|[^\d])/i.test(`${modelName || ""}`);
}

function shouldPreferSegmentedGeneration(input) {
  const force = `${process.env.LLM_FORCE_SEGMENTED_GENERATION || ""}`.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(force)) {
    return true;
  }

  const size = getStructureSize(input);
  const moduleThresholdRaw = Number(process.env.LLM_SEGMENTED_MODULE_THRESHOLD);
  const totalScreensThresholdRaw = Number(process.env.LLM_SEGMENTED_TOTAL_SCREENS_THRESHOLD);
  const screensPerModuleThresholdRaw = Number(process.env.LLM_SEGMENTED_SCREENS_PER_MODULE_THRESHOLD);

  const moduleThreshold = Number.isFinite(moduleThresholdRaw) && moduleThresholdRaw > 0
    ? Math.trunc(moduleThresholdRaw)
    : 6;
  const totalScreensThreshold = Number.isFinite(totalScreensThresholdRaw) && totalScreensThresholdRaw > 0
    ? Math.trunc(totalScreensThresholdRaw)
    : 48;
  const screensPerModuleThreshold = Number.isFinite(screensPerModuleThresholdRaw) && screensPerModuleThresholdRaw > 0
    ? Math.trunc(screensPerModuleThresholdRaw)
    : 10;

  const largeModelPenalty = isLikelyLargeModel(input?.generation?.model) ? 0.75 : 1;

  return size.moduleCount >= Math.max(2, Math.floor(moduleThreshold * largeModelPenalty))
    || size.totalScreens >= Math.max(12, Math.floor(totalScreensThreshold * largeModelPenalty))
    || size.screensPerModule >= Math.max(4, Math.floor(screensPerModuleThreshold * largeModelPenalty));
}

function createRagContextSlice(ragContext, batchIndex, totalBatches) {
  const chunks = Array.isArray(ragContext?.chunks) ? ragContext.chunks : [];
  if (chunks.length === 0) {
    return ragContext;
  }

  const configured = Number(process.env.LLM_SEGMENT_RAG_CHUNKS);
  const dynamicDefault = Math.min(6, Math.max(3, Math.ceil(chunks.length / Math.max(1, totalBatches))));
  const perBatch = Number.isFinite(configured) && configured > 0
    ? Math.min(chunks.length, Math.max(2, Math.trunc(configured)))
    : dynamicDefault;

  const start = (batchIndex * perBatch) % chunks.length;
  const batchChunks = [];
  for (let index = 0; index < perBatch; index += 1) {
    batchChunks.push(chunks[(start + index) % chunks.length]);
  }

  return {
    ...ragContext,
    chunks: batchChunks,
    topK: Math.min(Number(ragContext?.topK) || perBatch, perBatch)
  };
}

async function quickLlmReachabilityProbe(config) {
  if (!config || config.provider === "template") {
    return { ok: true, message: "" };
  }

  const baseUrl = `${config.baseUrl || ""}`.replace(/\/$/, "");
  if (!baseUrl) {
    return { ok: false, message: "LLM base URL is empty." };
  }

  const configured = Number(process.env.LOCAL_LLM_CONNECT_CHECK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0
    ? Math.max(2_000, Math.min(60_000, configured))
    : 10_000;
  const url = config.provider === "openai-compatible"
    ? `${baseUrl}/models`
    : `${baseUrl}/api/tags`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return {
        ok: false,
        message: `LLM endpoint pre-check failed with status ${response.status} (${url}).`
      };
    }
    return { ok: true, message: "" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown network error";
    return {
      ok: false,
      message: `LLM endpoint is unreachable: ${url}. ${reason}`
    };
  }
}

async function generateCourseByBatchesWithReset(input, ragContext) {
  const size = getStructureSize(input);
  const sectionSplitThresholdRaw = Number(process.env.LLM_SEGMENT_SECTION_SPLIT_THRESHOLD);
  const scoSplitThresholdRaw = Number(process.env.LLM_SEGMENT_SCO_SPLIT_THRESHOLD);
  const sectionSplitThreshold = Number.isFinite(sectionSplitThresholdRaw) && sectionSplitThresholdRaw > 0
    ? Math.trunc(sectionSplitThresholdRaw)
    : 8;
  const scoSplitThreshold = Number.isFinite(scoSplitThresholdRaw) && scoSplitThresholdRaw > 0
    ? Math.trunc(scoSplitThresholdRaw)
    : 6;

  const splitBySection = size.sectionsPerModule > 1 && size.screensPerModule >= sectionSplitThreshold;
  const splitBySco = !splitBySection
    && size.scosPerSection > 1
    && (size.scosPerSection * size.screensPerSco) >= scoSplitThreshold;

  if (size.moduleCount <= 1 && !splitBySection && !splitBySco) {
    return null;
  }

  const totalBatches = splitBySection
    ? size.moduleCount * size.sectionsPerModule
    : (splitBySco
      ? size.moduleCount * size.sectionsPerModule * size.scosPerSection
      : size.moduleCount);

  const modules = [];

  for (let moduleIndex = 0; moduleIndex < size.moduleCount; moduleIndex += 1) {
    if (splitBySection) {
      const sectionPayloads = [];
      for (let sectionIndex = 0; sectionIndex < size.sectionsPerModule; sectionIndex += 1) {
        const batchIndex = (moduleIndex * size.sectionsPerModule) + sectionIndex;
        const sectionInput = {
          ...input,
          titleHint: `${input.titleHint} | Module ${moduleIndex + 1} | Section ${sectionIndex + 1}`,
          structure: {
            ...input.structure,
            moduleCount: 1,
            sectionsPerModule: 1
          },
          learningGoals: Array.isArray(input.learningGoals) && input.learningGoals.length > 0
            ? [input.learningGoals[(moduleIndex + sectionIndex) % input.learningGoals.length]]
            : input.learningGoals
        };

        const sectionOutline = await createOutlineFromLocalLlm({
          ...sectionInput,
          ragContext: createRagContextSlice(ragContext, batchIndex, totalBatches)
        }, {
          strict: true,
          trace: {
            stage: "segmented-section-outline",
            module: moduleIndex + 1,
            section: sectionIndex + 1,
            attempt: 1
          }
        });

        const sectionCourse = buildCourseFromOutline(sectionInput, sectionOutline);
        const sectionPayload = sectionCourse?.modules?.[0]?.sections?.[0] || null;
        if (!sectionPayload) {
          throw new Error(`Module ${moduleIndex + 1}, section ${sectionIndex + 1}: outline payload is empty.`);
        }

        sectionPayload.order = sectionIndex + 1;
        sectionPayloads.push(sectionPayload);
      }

      modules.push({
        id: createId("module"),
        title: `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
        order: moduleIndex + 1,
        sections: sectionPayloads
      });
      continue;
    }

    if (splitBySco) {
      const sectionPayloads = [];

      for (let sectionIndex = 0; sectionIndex < size.sectionsPerModule; sectionIndex += 1) {
        const scoPayloads = [];
        let sectionTitle = `Section ${moduleIndex + 1}.${sectionIndex + 1}`;

        for (let scoIndex = 0; scoIndex < size.scosPerSection; scoIndex += 1) {
          const batchIndex = (moduleIndex * size.sectionsPerModule * size.scosPerSection)
            + (sectionIndex * size.scosPerSection)
            + scoIndex;

          const scoInput = {
            ...input,
            titleHint: `${input.titleHint} | Module ${moduleIndex + 1} | Section ${sectionIndex + 1} | SCO ${scoIndex + 1}`,
            structure: {
              ...input.structure,
              moduleCount: 1,
              sectionsPerModule: 1,
              scosPerSection: 1
            },
            learningGoals: Array.isArray(input.learningGoals) && input.learningGoals.length > 0
              ? [input.learningGoals[(moduleIndex + sectionIndex + scoIndex) % input.learningGoals.length]]
              : input.learningGoals
          };

          const scoOutline = await createOutlineFromLocalLlm({
            ...scoInput,
            ragContext: createRagContextSlice(ragContext, batchIndex, totalBatches)
          }, {
            strict: true,
            trace: {
              stage: "segmented-sco-outline",
              module: moduleIndex + 1,
              section: sectionIndex + 1,
              sco: scoIndex + 1,
              attempt: 1
            }
          });

          const scoCourse = buildCourseFromOutline(scoInput, scoOutline);
          const generatedSection = scoCourse?.modules?.[0]?.sections?.[0] || null;
          const scoPayload = generatedSection?.scos?.[0] || null;
          if (!scoPayload) {
            throw new Error(`Module ${moduleIndex + 1}, section ${sectionIndex + 1}, SCO ${scoIndex + 1}: outline payload is empty.`);
          }

          if (generatedSection?.title && scoIndex === 0) {
            sectionTitle = generatedSection.title;
          }

          scoPayload.order = scoIndex + 1;
          scoPayloads.push(scoPayload);
        }

        sectionPayloads.push({
          id: createId("section"),
          title: sectionTitle,
          order: sectionIndex + 1,
          scos: scoPayloads
        });
      }

      modules.push({
        id: createId("module"),
        title: `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
        order: moduleIndex + 1,
        sections: sectionPayloads
      });
      continue;
    }

    const moduleInput = {
      ...input,
      titleHint: `${input.titleHint} | Module ${moduleIndex + 1}`,
      structure: {
        ...input.structure,
        moduleCount: 1
      },
      learningGoals: Array.isArray(input.learningGoals) && input.learningGoals.length > 0
        ? [input.learningGoals[moduleIndex % input.learningGoals.length]]
        : input.learningGoals
    };

    const moduleOutline = await createOutlineFromLocalLlm({
      ...moduleInput,
      ragContext: createRagContextSlice(ragContext, moduleIndex, totalBatches)
    }, {
      strict: true,
      trace: {
        stage: "segmented-module-outline",
        module: moduleIndex + 1,
        attempt: 1
      }
    });

    const moduleCourse = buildCourseFromOutline(moduleInput, moduleOutline);
    const modulePayload = Array.isArray(moduleCourse?.modules) ? moduleCourse.modules[0] : null;
    if (!modulePayload) {
      throw new Error(`Module ${moduleIndex + 1}: outline payload is empty.`);
    }

    modulePayload.order = moduleIndex + 1;
    modules.push(modulePayload);
  }

  const course = buildTemplateDraft(input);
  course.modules = modules;
  course.generation = {
    ...input.generation,
    mode: splitBySection
      ? "llm-outline-per-section"
      : (splitBySco ? "llm-outline-per-sco" : "llm-outline-per-module")
  };
  return course;
}
export async function generateCourseDraft(payload) {
  const input = normalizeGenerateInput(payload);
  const strictRag = isStrictRagRequested(input);

  const ragContext = await buildRagContext(input);
  if (strictRag && (!Array.isArray(ragContext.chunks) || ragContext.chunks.length === 0)) {
    throw new Error(
      `No context found for selected documents. ${ragContext.message || "Check indexing and embedding model."}`
    );
  }

  let outline = null;
  let llmFailureMessage = "";
  let linePlan = null;
  let linePlanFailureMessage = "";
  let moduleBatchFailureMessage = "";
  let skipLlmCalls = false;
  let segmentedAttempted = false;

  const preferSegmented = shouldPreferSegmentedGeneration(input);

  const trySegmentedGeneration = async (reason) => {
    if (segmentedAttempted) {
      return null;
    }
    segmentedAttempted = true;

    try {
      const segmentedCourse = await generateCourseByBatchesWithReset(input, ragContext);
      if (!segmentedCourse) {
        return null;
      }

      segmentedCourse.rag = {
        ...input.rag,
        retrieval: {
          enabled: Boolean(ragContext?.enabled),
          topK: ragContext.topK,
          query: ragContext.query,
          chunksCount: Array.isArray(ragContext?.chunks) ? ragContext.chunks.length : 0,
          mode: segmentedCourse?.generation?.mode || "llm-outline-per-module",
          message: reason
        }
      };

      return finalizeGeneratedCourse(segmentedCourse, input, ragContext);
    } catch (error) {
      moduleBatchFailureMessage = error instanceof Error ? error.message : "Segmented generation failed";
      return null;
    }
  };

  if (input?.generation?.provider && input.generation.provider !== "template") {
    const reachability = await quickLlmReachabilityProbe(input.generation);
    if (!reachability.ok) {
      llmFailureMessage = reachability.message || "LLM endpoint pre-check failed.";
      skipLlmCalls = true;
    }
  }

  if (!skipLlmCalls && preferSegmented) {
    const segmented = await trySegmentedGeneration(
      "Large course structure detected. Segmented generation mode was used to avoid long single-request timeouts."
    );
    if (segmented) {
      return segmented;
    }
  }

  if (!skipLlmCalls) {
    try {
      outline = await createOutlineFromLocalLlm({
        ...input,
        ragContext
      }, { strict: false, trace: { stage: "main-outline" } });
    } catch (error) {
      llmFailureMessage = error instanceof Error ? error.message : "LLM call failed";
    }
  }

  if (outline) {
    const course = buildCourseFromOutline(input, outline);
    if (strictRag && containsTemplatePlaceholders(course)) {
      try {
        linePlan = await createLinePlanFromLocalLlm({
          ...input,
          ragContext
        }, { strict: false, trace: { stage: "main-lineplan-template-fallback" } });
      } catch (error) {
        linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
      }
      const planCourse = buildCourseFromLinePlan(input, linePlan);
      const linePlanQuality = evaluateLinePlanQuality(linePlan);
      if (planCourse && !containsTemplatePlaceholders(planCourse) && linePlanQuality.ok) {
        planCourse.rag = {
          ...input.rag,
          retrieval: {
            enabled: true,
            topK: ragContext.topK,
            query: ragContext.query,
            chunksCount: ragContext.chunks.length,
            mode: "llm-line-plan",
            message: "LLM returned template-like JSON. Line-plan mode was used."
          }
        };
        return finalizeGeneratedCourse(planCourse, input, ragContext);
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
            message: "LLM returned template-like content. Extractive fallback was used."
          }
        };
        return finalizeGeneratedCourse(extractiveCourse, input, ragContext);
      }
      throw new Error("LLM returned template-like content and fallback could not recover.");
    }
    return finalizeGeneratedCourse(course, input, ragContext);
  }

  const transientFailure = isLlmTimeoutErrorMessage(llmFailureMessage)
    || isLlmTransientConnectivityErrorMessage(llmFailureMessage)
    || (preferSegmented && Boolean(llmFailureMessage));

  if (transientFailure) {
    const segmented = await trySegmentedGeneration(
      isLlmTimeoutErrorMessage(llmFailureMessage)
        ? "Main LLM request timed out. Course generated in segmented mode with timeout reset per batch."
        : "LLM endpoint was unstable. Course generated in segmented mode with shorter per-batch requests."
    );
    if (segmented) {
      return segmented;
    }
  }

  if (!skipLlmCalls) {
    try {
      linePlan = await createLinePlanFromLocalLlm({
        ...input,
        ragContext
      }, { strict: false, trace: { stage: "main-lineplan-no-outline" } });
    } catch (error) {
      linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
    }
  }

  const planCourse = buildCourseFromLinePlan(input, linePlan);
      const linePlanQuality = evaluateLinePlanQuality(linePlan);
      if (planCourse && !containsTemplatePlaceholders(planCourse) && linePlanQuality.ok) {
    planCourse.rag = {
      ...input.rag,
      retrieval: {
        enabled: true,
        topK: ragContext.topK,
        query: ragContext.query,
        chunksCount: ragContext.chunks.length,
        mode: "llm-line-plan",
        message: `LLM outline failed. Line-plan fallback was used.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${moduleBatchFailureMessage ? ` ${moduleBatchFailureMessage}` : ""}`
      }
    };
    return finalizeGeneratedCourse(planCourse, input, ragContext);
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
        message: `LLM fallback to extractive mode.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}${moduleBatchFailureMessage ? ` ${moduleBatchFailureMessage}` : ""}`
      }
    };
    return finalizeGeneratedCourse(extractiveCourse, input, ragContext);
  }

  if (strictRag) {
    throw new Error("LLM did not return a usable course and RAG fallbacks did not produce content.");
  }

  if (input?.generation?.provider && input.generation.provider !== "template") {
    const providerFailure = [llmFailureMessage, linePlanFailureMessage, moduleBatchFailureMessage]
      .filter(Boolean)
      .join(" ");
    const suffix = providerFailure ? ` ${providerFailure}` : "";
    throw new Error("LLM generation failed and no safe fallback content is available." + suffix);
  }

  return finalizeGeneratedCourse(buildTemplateDraft(payload), input, ragContext);
}
