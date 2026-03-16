import { createId } from "../ids.js";
import { screenSlotId, getPlanSlotFacts } from "../generation-planner.js";
import { 
  firstSentence, 
  jaccardSimilarity, 
  screenTextValue, 
  textKey, 
  sentencePoolFromText,
  toBulletItems,
  normalizePlanOptionTexts,
  stripExtension,
  summarizeChunkForScreen,
  rotateList
} from "../course-utils.js";
import { createDefaultChamiloSettings } from "../course-defaults.js";

/**
 * Clean raw chunk text from PDF artifacts before using in course.
 * Removes: (cid:NNN), TOC dots, page numbers, stuck-together words, metadata.
 */
function cleanChunkText(text) {
  if (!text || typeof text !== "string") return "";
  let t = text;

  // Remove (cid:NNN) font artifacts
  t = t.replace(/\(cid:\d+\)/g, " ");

  // Remove TOC dot-leaders: "2.9 Исследованиепакета . . . . . . . . 36"
  t = t.replace(/\.[\s.]{3,}\d{1,4}/g, "");
  t = t.replace(/\s*\.{3,}\s*/g, " ");

  // Remove standalone page numbers
  t = t.replace(/(?:^|\s)\d{1,4}(?:\s|$)/g, " ");

  // Remove TOC-like lines: "Chapter N ...", "Preface xi"
  t = t.replace(/\b(?:Chapter|Preface|Contents|Table\s+of\s+Contents|Index|Appendix|Bibliography|Foreword)\b[^.!?\n]*/gi, "");
  t = t.replace(/\b(?:Глава|Предисловие|Оглавление|Содержание|Приложение|Библиография)\b[^.!?\n]*/gi, "");

  // Split stuck-together Cyrillic words (>25 chars of unbroken Cyrillic)
  t = t.replace(/[\u0400-\u04FF]{25,}/g, (match) => {
    // Try to split by capital letters inside
    return match.replace(/(?<=[а-яё])(?=[А-ЯЁ])/g, " ");
  });

  // Remove ISBN, copyright
  t = t.replace(/ISBN[\s:\-]*[\dXx\-]{10,}/gi, "");
  t = t.replace(/©\s*\d{4}.*/g, "");

  // Clean up whitespace
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

export function renderScreenFromFacts(facts, fallbackTitle, audience) {
  const factTexts = Array.isArray(facts)
    ? facts.map((fact) => `${fact?.text || ""}`.trim()).filter(Boolean)
    : [];

  const selected = factTexts.slice(0, 3);
  const summary = selected.slice(0, 2).join(" ");
  const text = summary.length > 120
    ? summary
    : [summary, selected[2] || ""].filter(Boolean).join(" ").trim();

  const bullets = selected.length > 0
    ? selected.map((item) => item.slice(0, 140))
    : [
        "Identify the key concept from this screen",
        "Link this concept to one real work scenario",
        "Define one immediate action to apply"
      ];

  while (bullets.length < 3) {
    bullets.push(`Key point ${bullets.length + 1}`);
  }

  return {
    title: firstSentence(selected[0] || fallbackTitle || "Screen topic", fallbackTitle || "Screen topic").slice(0, 96),
    blocks: [
      {
        type: "text",
        text: `${text}. Practical focus for audience "${audience || "learners"}": apply one concrete action right after this screen.`.replace(/\s+/g, " ").trim()
      },
      {
        type: "list",
        items: bullets
      }
    ]
  };
}

export function applyPlannerQualityGate(course, input, plan) {
  if (!course || !Array.isArray(course?.modules)) {
    return course;
  }

  const seen = new Set();
  let previousText = "";
  let rewrites = 0;
  let totalScreens = 0;
  let totalTextChars = 0;
  const placeholderPattern = /(?:\u0424\u043e\u043a\u0443\u0441 \u044d\u043a\u0440\u0430\u043d\u0430|\u041a\u043b\u044e\u0447\u0435\u0432\u044b\u0435 \u0442\u0435\u0437\u0438\u0441\u044b|\u041f\u0440\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u0448\u0430\u0433|\u0442\u0435\u043a\u0443\u0449\u0430\u044f \u0442\u0435\u043c\u0430|focus screen|key theses|practical step|current topic)/i;

  for (let moduleIndex = 0; moduleIndex < course.modules.length; moduleIndex += 1) {
    const moduleItem = course.modules[moduleIndex];
    for (let sectionIndex = 0; sectionIndex < (moduleItem.sections || []).length; sectionIndex += 1) {
      const section = moduleItem.sections[sectionIndex];
      for (let scoIndex = 0; scoIndex < (section.scos || []).length; scoIndex += 1) {
        const sco = section.scos[scoIndex];
        for (let screenIndex = 0; screenIndex < (sco.screens || []).length; screenIndex += 1) {
          const screen = sco.screens[screenIndex];
          totalScreens += 1;
          const currentText = screenTextValue(screen);
          const key = textKey(currentText);
          const similarity = jaccardSimilarity(previousText, currentText);
          const isDuplicate = key && seen.has(key);
          const tooShort = currentText.length < 180;
          const looksTemplate = placeholderPattern.test(currentText);

          if (isDuplicate || similarity > 0.82 || tooShort || looksTemplate) {
            const slotId = screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex);
            const facts = getPlanSlotFacts(plan, slotId);
            const rewritten = renderScreenFromFacts(facts, screen?.title, input?.audience || "learners");
            screen.title = rewritten.title;
            screen.blocks = rewritten.blocks;
            rewrites += 1;
            previousText = screenTextValue(screen);
            totalTextChars += previousText.length;
            seen.add(textKey(previousText));
            continue;
          }

          totalTextChars += currentText.length;
          previousText = currentText;
          if (key) {
            seen.add(key);
          }
        }
      }
    }
  }

  const uniqueRatio = totalScreens > 0 ? Number((seen.size / totalScreens).toFixed(3)) : 0;
  const avgTextLength = totalScreens > 0 ? Math.round(totalTextChars / totalScreens) : 0;
  console.log("[planner] quality-gate", {
    rewrites,
    totalScreens,
    avgTextLength,
    uniqueRatio
  });

  return course;
}

export function buildCourseFromLinePlan(input, plan) {
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
    const moduleTitle = `${moduleSeed?.title || ""}`.trim() || `Topic ${moduleIndex + 1}`;

    return {
      id: createId("module"),
      title: `Module ${moduleIndex + 1}: ${moduleTitle}`,
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
        id: createId("section"),
        title: `Section ${moduleIndex + 1}.${sectionIndex + 1}`,
        order: sectionIndex + 1,
        scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
          id: createId("sco"),
          title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
          order: scoIndex + 1,
          screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
            const topic = nextTopic();
            const title = `${topic?.title || ""}`.trim() || `Topic ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
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
      prompt: `${sourceQuestion.prompt || `Control question ${questionIndex + 1}`}`.slice(0, 240),
      options,
      correctOptionId: options[clampedIndex].id,
      explanation: `${sourceQuestion.explanation || `Check understanding for topic ${questionIndex + 1}.`}`.slice(0, 240)
    };
  });

  return {
    id: createId("course"),
    title: `${plan?.title || input.titleHint}`.trim() || input.titleHint,
    description: `${plan?.description || `Course for audience "${input.audience}".`}`.trim(),
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
      title: "Final test",
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}

export function buildCourseFromRagChunks(input, ragContext) {
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
    const cleanedSeedText = cleanChunkText(seed.text);
    const moduleTopic = firstSentence(cleanedSeedText, stripExtension(seed.fileName) || `Topic ${moduleIndex + 1}`)
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim();
    return {
      id: createId("module"),
      title: `Module ${moduleIndex + 1}: ${moduleTopic}`,
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
        id: createId("section"),
        title: `Section ${moduleIndex + 1}.${sectionIndex + 1}`,
        order: sectionIndex + 1,
        scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
          id: createId("sco"),
          title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
          order: scoIndex + 1,
          screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
            const source = nextChunk();
            const snippet = cleanChunkText(`${source.text || ""}`).slice(0, 900);
            const sourceName = source.fileName || `source_${source.materialId || "unknown"}`;
            const summary = summarizeChunkForScreen(
              snippet,
              `Source material: ${sourceName}.`
            );
            return {
              id: createId("screen"),
              title: firstSentence(
                summary.bullets?.[0] || snippet,
                `Topic ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`
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
    .flatMap((chunk) => sentencePoolFromText(cleanChunkText(chunk.text)))
    .filter(Boolean);
  const fallbackStatements = chunks.map((chunk) =>
    firstSentence(cleanChunkText(chunk.text), "Key source statement.")
  );
  const allStatements = [...statementPool, ...fallbackStatements].filter(Boolean);

  const questions = Array.from({ length: input.finalTest.questionCount }, (_, index) => {
    const source = chunks[index % chunks.length];
    const correctStatement = allStatements[index % allStatements.length] || `Key statement ${index + 1}`;
    const wrongCandidates = allStatements.filter((item) => item !== correctStatement);
    const wrongOptions = wrongCandidates.slice(index % Math.max(1, wrongCandidates.length), (index % Math.max(1, wrongCandidates.length)) + 3);
    while (wrongOptions.length < 3) {
      wrongOptions.push(`Statement does not match source materials (${wrongOptions.length + 1})`);
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
      prompt: `Which statement matches course materials for question ${index + 1}?`,
      options,
      correctOptionId: correct.id,
      explanation: `Source "${source?.fileName || "material"}" supports option: ${correctOptionText}`
    };
  });

  return {
    id: createId("course"),
    title: input.titleHint,
    description: `Course was built from uploaded materials (${chunks.length} relevant fragments).`,
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
      title: "Final test",
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}
