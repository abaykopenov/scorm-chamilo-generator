import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";
import { buildCourseFromOutline, createLinePlanFromLocalLlm, createOutlineFromLocalLlm } from "./local-llm.js";
import { buildRagContext } from "./rag-service.js";
import { postprocessGeneratedCourse } from "./course-postprocess.js";
import { normalizeGenerateInput } from "./validation.js";
import {
  createGenerationPlan,
  createPlannerScopedRagContext,
  getPlanSlotFacts,
  screenSlotId
} from "./generation-planner.js";

function pickGoal(goals, index) {
  if (goals.length === 0) {
    return "ÐžÑÐ²Ð¾Ð¸Ñ‚ÑŒ ÐºÐ»ÑŽÑ‡ÐµÐ²Ñ‹Ðµ Ð¸Ð´ÐµÐ¸ ÐºÑƒÑ€ÑÐ°";
  }
  return goals[index % goals.length];
}

function buildBlocks({ moduleIndex, sectionIndex, scoIndex, screenIndex, goal, audience }) {
  const label = `${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
  return [
    {
      type: "text",
      text: `Ð­ÐºÑ€Ð°Ð½ ${label} Ñ€Ð°ÑÐºÑ€Ñ‹Ð²Ð°ÐµÑ‚ Ñ†ÐµÐ»ÑŒ "${goal}" Ð´Ð»Ñ Ð°ÑƒÐ´Ð¸Ñ‚Ð¾Ñ€Ð¸Ð¸ "${audience}".`
    },
    {
      type: "list",
      items: [
        `ÐšÐ»ÑŽÑ‡ÐµÐ²Ð°Ñ Ð¸Ð´ÐµÑ ${label}`,
        `ÐŸÑ€Ð°ÐºÑ‚Ð¸Ñ‡ÐµÑÐºÐ¸Ð¹ ÑÑ†ÐµÐ½Ð°Ñ€Ð¸Ð¹ ${label}`,
        `ÐœÐ¸Ð½Ð¸-Ð²Ñ‹Ð²Ð¾Ð´ Ð´Ð»Ñ Ð·Ð°ÐºÑ€ÐµÐ¿Ð»ÐµÐ½Ð¸Ñ ${label}`
      ]
    }
  ];
}

function buildQuestion(courseTitle, goal, index) {
  const questionId = createId("question");
  const options = [
    `Ð¤Ð¾ÐºÑƒÑÐ¸Ñ€ÑƒÐµÑ‚ÑÑ Ð½Ð° Ñ†ÐµÐ»Ð¸ "${goal}" Ð¸ Ð¿Ñ€Ð¸Ð¼ÐµÐ½ÐµÐ½Ð¸Ð¸ Ð² Ñ€Ð°Ð±Ð¾Ñ‚Ðµ`,
    `Ð˜Ð³Ð½Ð¾Ñ€Ð¸Ñ€ÑƒÐµÑ‚ Ñ†ÐµÐ»ÑŒ Ð¸ Ð¾ÑÑ‚Ð°Ð²Ð»ÑÐµÑ‚ Ñ‚ÐµÐ¼Ñƒ Ð±ÐµÐ· ÑÑ†ÐµÐ½Ð°Ñ€Ð¸ÐµÐ²`,
    `ÐŸÐµÑ€ÐµÐ½Ð¾ÑÐ¸Ñ‚ Ñ€ÐµÑˆÐµÐ½Ð¸Ðµ Ð½Ð° Ð²Ð½ÐµÑˆÐ½ÑŽÑŽ ÑÐ¸ÑÑ‚ÐµÐ¼Ñƒ Ð±ÐµÐ· Ð¾Ð±ÑƒÑ‡ÐµÐ½Ð¸Ñ`,
    `ÐÐµ Ñ‚Ñ€ÐµÐ±ÑƒÐµÑ‚ Ð½Ð¸ÐºÐ°ÐºÐ¾Ð¹ Ð¾Ñ†ÐµÐ½ÐºÐ¸ Ñ€ÐµÐ·ÑƒÐ»ÑŒÑ‚Ð°Ñ‚Ð°`
  ].map((text) => ({ id: createId("option"), text }));

  return {
    id: questionId,
    prompt: `Ð§Ñ‚Ð¾ Ð»ÑƒÑ‡ÑˆÐµ Ð²ÑÐµÐ³Ð¾ Ð¾Ñ‚Ñ€Ð°Ð¶Ð°ÐµÑ‚ Ð¸Ð·ÑƒÑ‡ÐµÐ½Ð¸Ðµ Ñ‚ÐµÐ¼Ñ‹ "${courseTitle}" Ð² Ð²Ð¾Ð¿Ñ€Ð¾ÑÐµ ${index + 1}?`,
    options,
    correctOptionId: options[0].id,
    explanation: `ÐŸÑ€Ð°Ð²Ð¸Ð»ÑŒÐ½Ñ‹Ð¹ Ð¾Ñ‚Ð²ÐµÑ‚ ÑÐ²ÑÐ·Ð°Ð½ Ñ Ð¿Ñ€Ð°ÐºÑ‚Ð¸Ñ‡ÐµÑÐºÐ¸Ð¼ Ð´Ð¾ÑÑ‚Ð¸Ð¶ÐµÐ½Ð¸ÐµÐ¼ Ñ†ÐµÐ»Ð¸ "${goal}".`
  };
}

function buildTemplateDraft(payload) {
  const input = normalizeGenerateInput(payload);

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => ({
    id: createId("module"),
    title: `ÐœÐ¾Ð´ÑƒÐ»ÑŒ ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
    order: moduleIndex + 1,
    sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
      id: createId("section"),
      title: `Ð Ð°Ð·Ð´ÐµÐ» ${moduleIndex + 1}.${sectionIndex + 1}`,
      order: sectionIndex + 1,
      scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
        id: createId("sco"),
        title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
        order: scoIndex + 1,
        screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => ({
          id: createId("screen"),
          title: `Ð­ÐºÑ€Ð°Ð½ ${screenIndex + 1}`,
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
    title: "Ð˜Ñ‚Ð¾Ð³Ð¾Ð²Ñ‹Ð¹ Ñ‚ÐµÑÑ‚",
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
    description: `ÐÐ²Ñ‚Ð¾Ð¼Ð°Ñ‚Ð¸Ñ‡ÐµÑÐºÐ¸ ÑÐ¾Ð·Ð´Ð°Ð½Ð½Ñ‹Ð¹ ÐºÑƒÑ€Ñ Ð´Ð»Ñ Ð°ÑƒÐ´Ð¸Ñ‚Ð¾Ñ€Ð¸Ð¸ "${input.audience}". Ð”Ð»Ð¸Ñ‚ÐµÐ»ÑŒÐ½Ð¾ÑÑ‚ÑŒ: Ð¾ÐºÐ¾Ð»Ð¾ ${input.durationMinutes} Ð¼Ð¸Ð½ÑƒÑ‚.`,
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

function finalizeGeneratedCourse(course, input, ragContext, plannerPlan = null) {
  const planned = plannerPlan ? applyPlannerQualityGate(course, input, plannerPlan) : course;
  const normalized = postprocessGeneratedCourse(planned, input);
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
  const placeholderRegex = /Ð­ÐºÑ€Ð°Ð½\s+\d+(?:\.\d+){0,4}\s+Ñ€Ð°ÑÐºÑ€Ñ‹Ð²Ð°ÐµÑ‚\s+(?:Ñ†ÐµÐ»ÑŒ|Ñ‚ÐµÐ¼Ñƒ)/i;
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

function reportProgress(hooks, percent, stage, message) {
  if (typeof hooks?.onProgress === "function") {
    hooks.onProgress(percent, stage, message);
  }
}

function mergeUniqueRagChunks(chunks) {
  const map = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const materialId = `${chunk?.materialId || ""}`;
    const chunkId = `${chunk?.chunkId || ""}`;
    const order = Number(chunk?.chunkOrder) || 0;
    const textKey = `${chunk?.text || ""}`.slice(0, 240).toLowerCase();
    const key = `${materialId}:${chunkId}:${order}:${textKey}`;
    if (!map.has(key)) {
      map.set(key, chunk);
    }
  }
  return [...map.values()];
}

async function enrichRagContextForPlanner(input, ragContext, hooks) {
  if (!input?.rag?.enabled || !Array.isArray(input?.rag?.documentIds) || input.rag.documentIds.length === 0) {
    return ragContext;
  }

  const structure = getStructureSize(input);
  const minTargetChunks = Math.max(8, Math.min(32, structure.totalScreens * 2));
  const currentChunks = Array.isArray(ragContext?.chunks) ? ragContext.chunks : [];

  if (currentChunks.length >= minTargetChunks) {
    return ragContext;
  }

  let best = ragContext;
  let merged = [...currentChunks];
  let topK = Math.max(Number(input?.rag?.topK) || 6, Number(ragContext?.topK) || 6);

  for (let retry = 1; retry <= 4; retry += 1) {
    topK = Math.min(30, topK + 4);
    if (topK <= (Number(best?.topK) || 0)) {
      break;
    }

    reportProgress(hooks, 7 + retry, "planner", `Planner retrieval retry ${retry}: topK=${topK}`);

    const retried = await buildRagContext({
      ...input,
      rag: {
        ...input.rag,
        topK
      }
    });

    merged = mergeUniqueRagChunks([...merged, ...(Array.isArray(retried?.chunks) ? retried.chunks : [])]);
    best = {
      ...retried,
      chunks: merged,
      topK
    };

    if (merged.length >= minTargetChunks) {
      break;
    }
  }

  return best;
}

function screenTextValue(screen) {
  const textBlocks = Array.isArray(screen?.blocks)
    ? screen.blocks.filter((block) => block?.type === "text" || block?.type === "note").map((block) => `${block?.text || ""}`)
    : [];
  return textBlocks.join(" ").replace(/\s+/g, " ").trim();
}

function textKey(value) {
  return `${value || ""}`.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

function jaccardSimilarity(a, b) {
  const leftTokens = new Set(textKey(a).split(" ").filter(Boolean));
  const rightTokens = new Set(textKey(b).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function renderScreenFromFacts(facts, fallbackTitle, audience) {
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
        "???????? ???? ?? ?????????",
        "???????????? ????? ??? ??????",
        "??? ????????? ?????"
      ];

  while (bullets.length < 3) {
    bullets.push(`???????????? ????? ${bullets.length + 1}`);
  }

  return {
    title: (selected[0] || fallbackTitle || "?????").slice(0, 96),
    blocks: [
      {
        type: "text",
        text: `${text}. ???????????? ??? ??? ????????? "${audience}": ????????? ??? ????????? ? ????????? ??????? ??????.`.replace(/\s+/g, " ").trim()
      },
      {
        type: "list",
        items: bullets
      }
    ]
  };
}

function applyPlannerQualityGate(course, input, plan) {
  if (!course || !Array.isArray(course?.modules)) {
    return course;
  }

  const seen = new Set();
  let previousText = "";
  let rewrites = 0;
  const placeholderPattern = /(?:\u0424\u043e\u043a\u0443\u0441 \u044d\u043a\u0440\u0430\u043d\u0430|\u041a\u043b\u044e\u0447\u0435\u0432\u044b\u0435 \u0442\u0435\u0437\u0438\u0441\u044b|\u041f\u0440\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u0448\u0430\u0433|\u0442\u0435\u043a\u0443\u0449\u0430\u044f \u0442\u0435\u043c\u0430|focus screen|key theses|practical step|current topic)/i;

  for (let moduleIndex = 0; moduleIndex < course.modules.length; moduleIndex += 1) {
    const moduleItem = course.modules[moduleIndex];
    for (let sectionIndex = 0; sectionIndex < (moduleItem.sections || []).length; sectionIndex += 1) {
      const section = moduleItem.sections[sectionIndex];
      for (let scoIndex = 0; scoIndex < (section.scos || []).length; scoIndex += 1) {
        const sco = section.scos[scoIndex];
        for (let screenIndex = 0; screenIndex < (sco.screens || []).length; screenIndex += 1) {
          const screen = sco.screens[screenIndex];
          const currentText = screenTextValue(screen);
          const key = textKey(currentText);
          const similarity = jaccardSimilarity(previousText, currentText);
          const isDuplicate = key && seen.has(key);
          const tooShort = currentText.length < 180;
          const looksTemplate = placeholderPattern.test(currentText);

          if (isDuplicate || similarity > 0.82 || tooShort || looksTemplate) {
            const slotId = screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex);
            const facts = getPlanSlotFacts(plan, slotId);
            const rewritten = renderScreenFromFacts(facts, screen?.title, input?.audience || "?????????");
            screen.title = rewritten.title;
            screen.blocks = rewritten.blocks;
            rewrites += 1;
            previousText = screenTextValue(screen);
            seen.add(textKey(previousText));
            continue;
          }

          previousText = currentText;
          if (key) {
            seen.add(key);
          }
        }
      }
    }
  }

  if (rewrites > 0) {
    console.log("[planner] quality-gate rewrites", { rewrites });
  }

  return course;
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
      bullets: ["ÐšÐ»ÑŽÑ‡ÐµÐ²Ð°Ñ Ð¸Ð´ÐµÑ", "ÐŸÑ€Ð°ÐºÑ‚Ð¸Ñ‡ÐµÑÐºÐ°Ñ Ð¿Ð¾Ð»ÑŒÐ·Ð°", "Ð§Ñ‚Ð¾ Ð¿Ñ€Ð¸Ð¼ÐµÐ½Ð¸Ñ‚ÑŒ Ð½Ð° Ð¿Ñ€Ð°ÐºÑ‚Ð¸ÐºÐµ"]
    };
  }

  const main = sentences.slice(0, 2).join(" ");
  const bullets = sentences.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`ÐšÐ»ÑŽÑ‡ÐµÐ²Ð¾Ð¹ Ð²Ñ‹Ð²Ð¾Ð´ ${bullets.length + 1}`);
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
    return ["ÐšÐ»ÑŽÑ‡ÐµÐ²Ð°Ñ Ð¸Ð´ÐµÑ Ð¸Ð· Ð¸ÑÑ‚Ð¾Ñ‡Ð½Ð¸ÐºÐ°", "ÐŸÑ€Ð°ÐºÑ‚Ð¸Ñ‡ÐµÑÐºÐ¸Ð¹ Ð²Ñ‹Ð²Ð¾Ð´", "Ð§Ñ‚Ð¾ Ð¿Ñ€Ð¸Ð¼ÐµÐ½Ð¸Ñ‚ÑŒ Ð² Ñ€Ð°Ð±Ð¾Ñ‚Ðµ"];
  }

  const parts = cleaned
    .split(/[.;!?]\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const bullets = parts.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`ÐšÐ»ÑŽÑ‡ÐµÐ²Ð¾Ð¹ Ð²Ñ‹Ð²Ð¾Ð´ ${bullets.length + 1}`);
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
    const fallback = `Ð’Ð°Ñ€Ð¸Ð°Ð½Ñ‚ ${result.length + 1} Ð´Ð»Ñ Ð²Ð¾Ð¿Ñ€Ð¾ÑÐ° ${questionIndex + 1}`;
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
    const moduleTitle = `${moduleSeed?.title || ""}`.trim() || `Ð¢ÐµÐ¼Ð° ${moduleIndex + 1}`;

    return {
      id: createId("module"),
      title: `ÐœÐ¾Ð´ÑƒÐ»ÑŒ ${moduleIndex + 1}: ${moduleTitle}`,
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
        id: createId("section"),
        title: `Ð Ð°Ð·Ð´ÐµÐ» ${moduleIndex + 1}.${sectionIndex + 1}`,
        order: sectionIndex + 1,
        scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
          id: createId("sco"),
          title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
          order: scoIndex + 1,
          screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
            const topic = nextTopic();
            const title = `${topic?.title || ""}`.trim() || `Ð¢ÐµÐ¼Ð° ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
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
      prompt: `${sourceQuestion.prompt || `ÐšÐ¾Ð½Ñ‚Ñ€Ð¾Ð»ÑŒÐ½Ñ‹Ð¹ Ð²Ð¾Ð¿Ñ€Ð¾Ñ ${questionIndex + 1}`}`.slice(0, 240),
      options,
      correctOptionId: options[clampedIndex].id,
      explanation: `${sourceQuestion.explanation || `ÐŸÑ€Ð¾Ð²ÐµÑ€ÐºÐ° Ð¿Ð¾Ð½Ð¸Ð¼Ð°Ð½Ð¸Ñ Ð¿Ð¾ Ñ‚ÐµÐ¼Ðµ ${questionIndex + 1}.`}`.slice(0, 240)
    };
  });

  return {
    id: createId("course"),
    title: `${plan?.title || input.titleHint}`.trim() || input.titleHint,
    description: `${plan?.description || `ÐšÑƒÑ€Ñ Ð´Ð»Ñ Ð°ÑƒÐ´Ð¸Ñ‚Ð¾Ñ€Ð¸Ð¸ "${input.audience}".`}`.trim(),
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
      title: "Ð˜Ñ‚Ð¾Ð³Ð¾Ð²Ñ‹Ð¹ Ñ‚ÐµÑÑ‚",
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
    const moduleTopic = firstSentence(seed.text, stripExtension(seed.fileName) || `Ð¢ÐµÐ¼Ð° ${moduleIndex + 1}`)
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim();
    return {
      id: createId("module"),
      title: `ÐœÐ¾Ð´ÑƒÐ»ÑŒ ${moduleIndex + 1}: ${moduleTopic}`,
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
        id: createId("section"),
        title: `Ð Ð°Ð·Ð´ÐµÐ» ${moduleIndex + 1}.${sectionIndex + 1}`,
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
              `ÐœÐ°Ñ‚ÐµÑ€Ð¸Ð°Ð» Ð¸Ð· Ð¸ÑÑ‚Ð¾Ñ‡Ð½Ð¸ÐºÐ° ${sourceName}.`
            );
            return {
              id: createId("screen"),
              title: firstSentence(
                summary.bullets?.[0] || snippet,
                `Ð¢ÐµÐ¼Ð° ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`
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
    firstSentence(chunk.text, "ÐšÐ»ÑŽÑ‡ÐµÐ²Ð¾Ð¹ Ñ‚ÐµÐ·Ð¸Ñ Ð¸Ð· Ð¸ÑÑ‚Ð¾Ñ‡Ð½Ð¸ÐºÐ°.")
  );
  const allStatements = [...statementPool, ...fallbackStatements].filter(Boolean);

  const questions = Array.from({ length: input.finalTest.questionCount }, (_, index) => {
    const source = chunks[index % chunks.length];
    const correctStatement = allStatements[index % allStatements.length] || `ÐšÐ»ÑŽÑ‡ÐµÐ²Ð¾Ð¹ Ñ‚ÐµÐ·Ð¸Ñ ${index + 1}`;
    const wrongCandidates = allStatements.filter((item) => item !== correctStatement);
    const wrongOptions = wrongCandidates.slice(index % Math.max(1, wrongCandidates.length), (index % Math.max(1, wrongCandidates.length)) + 3);
    while (wrongOptions.length < 3) {
      wrongOptions.push(`Ð£Ñ‚Ð²ÐµÑ€Ð¶Ð´ÐµÐ½Ð¸Ðµ Ð½Ðµ ÑÐ¾Ð¾Ñ‚Ð²ÐµÑ‚ÑÑ‚Ð²ÑƒÐµÑ‚ ÑÐ¾Ð´ÐµÑ€Ð¶Ð°Ð½Ð¸ÑŽ Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð¾Ð² (${wrongOptions.length + 1})`);
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
      prompt: `ÐšÐ°ÐºÐ¾Ðµ ÑƒÑ‚Ð²ÐµÑ€Ð¶Ð´ÐµÐ½Ð¸Ðµ ÑÐ¾Ð¾Ñ‚Ð²ÐµÑ‚ÑÑ‚Ð²ÑƒÐµÑ‚ Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð°Ð¼ ÐºÑƒÑ€ÑÐ° Ð¿Ð¾ Ð²Ð¾Ð¿Ñ€Ð¾ÑÑƒ ${index + 1}?`,
      options,
      correctOptionId: correct.id,
      explanation: `Ð’ Ð¸ÑÑ‚Ð¾Ñ‡Ð½Ð¸ÐºÐµ "${source?.fileName || "Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»"}" Ð¿Ð¾Ð´Ð´ÐµÑ€Ð¶Ð¸Ð²Ð°ÐµÑ‚ÑÑ Ð²Ð°Ñ€Ð¸Ð°Ð½Ñ‚: ${correctOptionText}`
    };
  });

  return {
    id: createId("course"),
    title: input.titleHint,
    description: `ÐšÑƒÑ€Ñ Ð¿Ð¾ÑÑ‚Ñ€Ð¾ÐµÐ½ Ð½Ð° Ð¾ÑÐ½Ð¾Ð²Ðµ Ð·Ð°Ð³Ñ€ÑƒÐ¶ÐµÐ½Ð½Ñ‹Ñ… Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð¾Ð² (${chunks.length} Ñ€ÐµÐ»ÐµÐ²Ð°Ð½Ñ‚Ð½Ñ‹Ñ… Ñ„Ñ€Ð°Ð³Ð¼ÐµÐ½Ñ‚Ð¾Ð²).`,
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
      title: "Ð˜Ñ‚Ð¾Ð³Ð¾Ð²Ñ‹Ð¹ Ñ‚ÐµÑÑ‚",
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
            message: `LLM Ð²ÐµÑ€Ð½ÑƒÐ»Ð° ÑˆÐ°Ð±Ð»Ð¾Ð½Ð½Ñ‹Ð¹ JSON. ÐŸÑ€Ð¸Ð¼ÐµÐ½ÐµÐ½Ð° Ð³ÐµÐ½ÐµÑ€Ð°Ñ†Ð¸Ñ Ñ‡ÐµÑ€ÐµÐ· line-plan Ñ ÐºÐ¾Ð½Ñ‚ÐµÐºÑÑ‚Ð¾Ð¼ Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð¾Ð².`
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
            message: `LLM Ð²ÐµÑ€Ð½ÑƒÐ»Ð° ÑˆÐ°Ð±Ð»Ð¾Ð½Ð½Ñ‹Ð¹ ÐºÐ¾Ð½Ñ‚ÐµÐ½Ñ‚, Ð¿Ñ€Ð¸Ð¼ÐµÐ½ÐµÐ½ extractive fallback Ð¸Ð· Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð¾Ð².${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}`
          }
        };
        return finalizeGeneratedCourse(extractiveCourse, input, ragContext);
      }
      throw new Error("LLM Ð²ÐµÑ€Ð½ÑƒÐ»Ð° ÑˆÐ°Ð±Ð»Ð¾Ð½Ð½Ñ‹Ð¹ ÐºÐ¾Ð½Ñ‚ÐµÐ½Ñ‚. Ð£Ð²ÐµÐ»Ð¸Ñ‡ÑŒÑ‚Ðµ Top-K, Ð¿Ñ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ ÐºÐ½Ð¸Ð³Ð¸ Ð¸ Ð¼Ð¾Ð´ÐµÐ»ÑŒ Ð³ÐµÐ½ÐµÑ€Ð°Ñ†Ð¸Ð¸.");
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
          message: `LLM Ð½Ðµ Ð²ÐµÑ€Ð½ÑƒÐ»Ð° Ð²Ð°Ð»Ð¸Ð´Ð½Ñ‹Ð¹ JSON, Ð¿Ñ€Ð¸Ð¼ÐµÐ½ÐµÐ½Ð° Ð³ÐµÐ½ÐµÑ€Ð°Ñ†Ð¸Ñ Ñ‡ÐµÑ€ÐµÐ· line-plan Ñ ÐºÐ¾Ð½Ñ‚ÐµÐºÑÑ‚Ð¾Ð¼ Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð¾Ð².${llmFailureMessage ? ` ${llmFailureMessage}` : ""}`
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
          message: `LLM Ð½Ðµ Ð²ÐµÑ€Ð½ÑƒÐ»Ð° Ð²Ð°Ð»Ð¸Ð´Ð½Ñ‹Ð¹ JSON, Ð¿Ñ€Ð¸Ð¼ÐµÐ½ÐµÐ½ extractive fallback Ð¸Ð· Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð¾Ð².${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}`
        }
      };
      return finalizeGeneratedCourse(extractiveCourse, input, ragContext);
    }
    throw new Error("LLM Ð½Ðµ Ð²ÐµÑ€Ð½ÑƒÐ»Ð° ÑÑ‚Ñ€ÑƒÐºÑ‚ÑƒÑ€Ñƒ ÐºÑƒÑ€ÑÐ° Ð¸ fallback Ð¿Ð¾ Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ð°Ð¼ Ð½Ðµ ÑÑ€Ð°Ð±Ð¾Ñ‚Ð°Ð».");
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

async function generateCourseByBatchesWithReset(input, ragContext, plannerPlan, hooks = {}) {
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

  const generationMode = splitBySection
    ? "llm-outline-per-section"
    : (splitBySco ? "llm-outline-per-sco" : "llm-outline-per-module");

  const totalBatches = splitBySection
    ? size.moduleCount * size.sectionsPerModule
    : (splitBySco
      ? size.moduleCount * size.sectionsPerModule * size.scosPerSection
      : size.moduleCount);

  const modules = [];
  const baseCourse = buildTemplateDraft(input);
  let doneBatches = 0;

  const reportBatchProgress = (message) => {
    doneBatches += 1;
    const ratio = totalBatches > 0 ? doneBatches / totalBatches : 0;
    const percent = Math.max(12, Math.min(84, Math.round(12 + (ratio * 72))));
    reportProgress(hooks, percent, "planner", message);
  };

  const emitModuleReady = async (moduleItem, moduleIndex) => {
    if (typeof hooks?.onModuleReady !== "function") {
      return;
    }

    const snapshot = {
      ...baseCourse,
      generation: {
        ...input.generation,
        mode: generationMode
      },
      modules: modules.map((item) => item)
    };

    await hooks.onModuleReady({
      course: snapshot,
      module: moduleItem,
      moduleIndex,
      totalModules: size.moduleCount
    });
  };

  for (let moduleIndex = 0; moduleIndex < size.moduleCount; moduleIndex += 1) {
    if (splitBySection) {
      const sectionPayloads = [];

      for (let sectionIndex = 0; sectionIndex < size.sectionsPerModule; sectionIndex += 1) {
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

        const scopedRagContext = createPlannerScopedRagContext(plannerPlan, ragContext, {
          moduleIndex,
          sectionIndex
        });

        const sectionOutline = await createOutlineFromLocalLlm({
          ...sectionInput,
          ragContext: scopedRagContext
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
        reportBatchProgress(`Planned M${moduleIndex + 1} S${sectionIndex + 1}`);
      }

      const modulePayload = {
        id: createId("module"),
        title: `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
        order: moduleIndex + 1,
        sections: sectionPayloads
      };

      modules.push(modulePayload);
      await emitModuleReady(modulePayload, moduleIndex);
      continue;
    }

    if (splitBySco) {
      const sectionPayloads = [];

      for (let sectionIndex = 0; sectionIndex < size.sectionsPerModule; sectionIndex += 1) {
        const scoPayloads = [];
        let sectionTitle = `Section ${moduleIndex + 1}.${sectionIndex + 1}`;

        for (let scoIndex = 0; scoIndex < size.scosPerSection; scoIndex += 1) {
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

          const scopedRagContext = createPlannerScopedRagContext(plannerPlan, ragContext, {
            moduleIndex,
            sectionIndex,
            scoIndex
          });

          const scoOutline = await createOutlineFromLocalLlm({
            ...scoInput,
            ragContext: scopedRagContext
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
          reportBatchProgress(`Planned M${moduleIndex + 1} S${sectionIndex + 1} SCO${scoIndex + 1}`);
        }

        sectionPayloads.push({
          id: createId("section"),
          title: sectionTitle,
          order: sectionIndex + 1,
          scos: scoPayloads
        });
      }

      const modulePayload = {
        id: createId("module"),
        title: `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
        order: moduleIndex + 1,
        sections: sectionPayloads
      };

      modules.push(modulePayload);
      await emitModuleReady(modulePayload, moduleIndex);
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

    const scopedRagContext = createPlannerScopedRagContext(plannerPlan, ragContext, {
      moduleIndex
    });

    const moduleOutline = await createOutlineFromLocalLlm({
      ...moduleInput,
      ragContext: scopedRagContext
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
    reportBatchProgress(`Planned module ${moduleIndex + 1}`);
    await emitModuleReady(modulePayload, moduleIndex);
  }

  const course = {
    ...baseCourse,
    modules,
    generation: {
      ...input.generation,
      mode: generationMode
    }
  };

  return course;
}

export async function generateCourseDraft(payload, hooks = {}) {
  const input = normalizeGenerateInput(payload);
  const strictRag = isStrictRagRequested(input);

  reportProgress(hooks, 5, "planner", "Building retrieval context");
  const initialRagContext = await buildRagContext(input);
  if (strictRag && (!Array.isArray(initialRagContext.chunks) || initialRagContext.chunks.length === 0)) {
    throw new Error(
      `No context found for selected documents. ${initialRagContext.message || "Check indexing and embedding model."}`
    );
  }

  reportProgress(hooks, 7, "planner", "Expanding retrieval for planner");
  const ragContext = await enrichRagContextForPlanner(input, initialRagContext, hooks);
  const plannerPlan = createGenerationPlan(input, ragContext, { factsPerSlot: 3 });
  const plannerGlobalRagContext = createPlannerScopedRagContext(plannerPlan, ragContext, {});
  reportProgress(hooks, 10, "planner", "Planner assigned facts to slots");

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
      const segmentedCourse = await generateCourseByBatchesWithReset(input, ragContext, plannerPlan, hooks);
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

      reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
      return finalizeGeneratedCourse(segmentedCourse, input, ragContext, plannerPlan);
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
      reportProgress(hooks, 18, "outline", "Generating main outline");
      outline = await createOutlineFromLocalLlm({
        ...input,
        ragContext: plannerGlobalRagContext
      }, { strict: false, trace: { stage: "main-outline" } });
    } catch (error) {
      llmFailureMessage = error instanceof Error ? error.message : "LLM call failed";
    }
  }

  if (outline) {
    const course = buildCourseFromOutline(input, outline);
    if (strictRag && containsTemplatePlaceholders(course)) {
      try {
        reportProgress(hooks, 45, "line-plan", "Outline was generic, switching to line-plan fallback");
        linePlan = await createLinePlanFromLocalLlm({
          ...input,
          ragContext: plannerGlobalRagContext
        }, { strict: false, trace: { stage: "main-lineplan-template-fallback" } });
      } catch (error) {
        linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
      }

      const planCourse = buildCourseFromLinePlan({ ...input, ragContext: plannerGlobalRagContext }, linePlan);
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
        reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
        return finalizeGeneratedCourse(planCourse, input, ragContext, plannerPlan);
      }

      const extractiveCourse = buildCourseFromRagChunks({ ...input, ragContext: plannerGlobalRagContext }, ragContext);
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
        reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
        return finalizeGeneratedCourse(extractiveCourse, input, ragContext, plannerPlan);
      }
      throw new Error("LLM returned template-like content and fallback could not recover.");
    }

    reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
    return finalizeGeneratedCourse(course, input, ragContext, plannerPlan);
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
      reportProgress(hooks, 45, "line-plan", "Generating line-plan fallback");
      linePlan = await createLinePlanFromLocalLlm({
        ...input,
        ragContext: plannerGlobalRagContext
      }, { strict: false, trace: { stage: "main-lineplan-no-outline" } });
    } catch (error) {
      linePlanFailureMessage = error instanceof Error ? error.message : "Line-plan LLM call failed";
    }
  }

  const planCourse = buildCourseFromLinePlan({ ...input, ragContext: plannerGlobalRagContext }, linePlan);
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
    reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
    return finalizeGeneratedCourse(planCourse, input, ragContext, plannerPlan);
  }

  const extractiveCourse = buildCourseFromRagChunks({ ...input, ragContext: plannerGlobalRagContext }, ragContext);
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
    reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
    return finalizeGeneratedCourse(extractiveCourse, input, ragContext, plannerPlan);
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

  reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
  return finalizeGeneratedCourse(buildTemplateDraft(payload), input, ragContext, plannerPlan);
}


