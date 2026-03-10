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
  screenSlotId,
  validateGenerationPlanCoverage
} from "./generation-planner.js";

function pickGoal(goals, index) {
  if (goals.length === 0) {
    return "Master key course ideas";
  }
  return goals[index % goals.length];
}

function buildBlocks({ moduleIndex, sectionIndex, scoIndex, screenIndex, goal, audience }) {
  const label = `Topic ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
  return [
    {
      type: "text",
      text: `Screen ${label} explains the goal "${goal}" for audience "${audience}".`
    },
    {
      type: "list",
      items: [
        `Core idea ${label}`,
        `Practical scenario ${label}`,
        `Actionable takeaway ${label}`
      ]
    }
  ];
}

function buildQuestion(courseTitle, goal, index) {
  const questionId = createId("question");
  const options = [
    `Focuses on the goal "${goal}" and practical execution`,
    "Ignores the goal and skips practical context",
    "Moves the decision outside the workflow without training",
    "Does not require any measurable outcome"
  ].map((text) => ({ id: createId("option"), text }));

  return {
    id: questionId,
    prompt: `Which statement matches course materials for question ${index + 1}?`,
    options,
    correctOptionId: options[0].id,
    explanation: `The correct option aligns with the goal "${goal}" and expected work outcome.`
  };
}

function buildTemplateDraft(payload) {
  const input = normalizeGenerateInput(payload);

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => ({
    id: createId("module"),
    title: `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
    order: moduleIndex + 1,
    sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
      id: createId("section"),
      title: `Section ${moduleIndex + 1}.${sectionIndex + 1}`,
      order: sectionIndex + 1,
      scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
        id: createId("sco"),
        title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
        order: scoIndex + 1,
        screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => ({
          id: createId("screen"),
          title: `Screen ${screenIndex + 1}`,
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
    title: "Final test",
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
    description: `Auto-generated course for audience "${input.audience}". Estimated duration: ${input.durationMinutes} minutes.`,
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
    contentDepthMode: input?.contentDepthMode || "deep",
    agentTopology: input?.agentTopology || "v4",
    evidenceMode: input?.evidenceMode || "per-screen",
    generationDefaults: {
      moduleCountDefault: Number(input?.generationDefaults?.moduleCountDefault) || 2
    },
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

async function finalizeGeneratedCourse(course, input, ragContext, plannerPlan = null, hooks = {}) {
  let prepared = course;

  if (isDeepV4Mode(input) && plannerPlan) {
    const deepResult = await runV4Pipeline(prepared, input, ragContext, plannerPlan, hooks);
    prepared = deepResult.course;
  } else if (plannerPlan) {
    prepared = applyPlannerQualityGate(prepared, input, plannerPlan, hooks);
  }

  const normalized = isDeepV4Mode(input)
    ? prepared
    : postprocessGeneratedCourse(prepared, input);
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
  const placeholderRegex = /(?:screen\s+\d+.*(?:explains|introduces)|this screen introduces|focus topic|key points?:|practical (?:step|takeaway))/i;
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

function reportProgress(hooks, percent, stage, message, metrics = null) {
  if (typeof hooks?.onProgress === "function") {
    hooks.onProgress(percent, stage, message, metrics && typeof metrics === "object" ? metrics : undefined);
  }
}

function isDeepV4Mode(input) {
  const depth = `${input?.contentDepthMode || "deep"}`.trim().toLowerCase();
  const topology = `${input?.agentTopology || "v4"}`.trim().toLowerCase();
  return depth === "deep" && topology === "v4";
}

function allowBatchDownsize() {
  return isTruthy(process.env.LLM_ALLOW_BATCH_DOWNSIZE, false);
}

function cleanEvidenceText(value) {
  return `${value || ""}`
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\uFFFD/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksNoisyEvidence(value) {
  const text = cleanEvidenceText(value);
  if (!text) {
    return true;
  }
  if (/(?:self-contained|microflow|trainingmanagement|addday\s*\(|\$\[[^\]]+\]|bars?\/buttons?|location_[a-z0-9_]+)/i.test(text)) {
    return true;
  }
  const letters = (text.match(/\p{L}/gu) || []).length;
  const symbols = (text.match(/[{}\[\]<>$\/\\]/g) || []).length;
  return letters > 0 && (symbols / letters) > 0.15;
}

function buildEvidencePack(plan, moduleIndex, sectionIndex, scoIndex, screenIndex) {
  const slotId = screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex);
  const facts = getPlanSlotFacts(plan, slotId);
  const seen = new Set();
  const pack = [];

  for (const fact of facts) {
    const text = cleanEvidenceText(fact?.text || "");
    if (!text || text.length < 45 || looksNoisyEvidence(text)) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pack.push({
      factId: `${fact?.id || `fact_${pack.length + 1}`}`,
      source: `${fact?.source || "source"}`,
      materialId: `${fact?.materialId || ""}`,
      chunkId: `${fact?.chunkId || ""}`,
      excerpt: text
    });
    if (pack.length >= 8) {
      break;
    }
  }

  return pack.slice(0, 8);
}

function evidencePackToRagContext(baseRagContext, evidencePack, slotLabel, objective) {
  const pack = Array.isArray(evidencePack) ? evidencePack : [];
  const chunks = pack.map((item, index) => ({
    materialId: item.materialId || item.source || `planner_${slotLabel}`,
    fileName: item.source || `planner_${slotLabel}`,
    score: 1 - (index * 0.01),
    chunkId: item.chunkId || `${slotLabel}_chunk_${index + 1}`,
    chunkOrder: index + 1,
    text: item.excerpt
  }));

  return {
    ...(baseRagContext || {}),
    topK: Math.max(3, chunks.length),
    chunks,
    screenPlanHints: [
      {
        slotId: slotLabel,
        label: slotLabel,
        objective: objective || "",
        keyFacts: pack.slice(0, 3).map((item) => item.excerpt)
      }
    ]
  };
}

function collectScreenBodyText(screen) {
  const blocks = Array.isArray(screen?.blocks) ? screen.blocks : [];
  return blocks
    .filter((block) => block?.type === "text" || block?.type === "note")
    .map((block) => `${block?.text || ""}`.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectKeyTakeaways(screen, evidencePack) {
  const blocks = Array.isArray(screen?.blocks) ? screen.blocks : [];
  const listBlock = blocks.find((block) => block?.type === "list" && Array.isArray(block?.items));
  const fromList = Array.isArray(listBlock?.items)
    ? listBlock.items.map((item) => `${item || ""}`.trim()).filter(Boolean)
    : [];
  if (fromList.length >= 2) {
    return fromList.slice(0, 5);
  }
  return (Array.isArray(evidencePack) ? evidencePack : [])
    .slice(0, 3)
    .map((item) => item.excerpt)
    .map((text) => firstSentence(text, text).slice(0, 180))
    .filter(Boolean);
}

function createEvidenceNote(evidencePack) {
  const lines = (Array.isArray(evidencePack) ? evidencePack : [])
    .slice(0, 3)
    .map((item, index) => `${index + 1}) ${item.source}: ${firstSentence(item.excerpt, item.excerpt).slice(0, 140)}`);

  return {
    type: "note",
    text: lines.length > 0
      ? `Evidence: ${lines.join("; ")}`
      : "Evidence: source is not specified"
  };
}

function ensureLongBody(text, evidencePack, title, minChars) {
  const intro = cleanEvidenceText(text);
  const evidenceParagraph = (Array.isArray(evidencePack) ? evidencePack : [])
    .map((item, index) => `Evidence ${index + 1} (${item.source}): ${item.excerpt}`)
    .join(" ");
  const context = `The screen "${title}" explains a concrete workflow grounded in retrieved facts and real operational context.`;
  const practical = `Practical step: identify one risk, map it to the required control procedure, and document the action in your workflow.`;

  let body = [intro, context, evidenceParagraph, practical]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  while (body.length < minChars) {
    body = `${body} ${evidenceParagraph || context}`.trim();
    if (!evidenceParagraph) {
      break;
    }
  }

  return body;
}

function hasEvidenceGrounding(body, evidencePack) {
  const normalizedBody = `${body || ""}`.toLowerCase();
  const evidence = Array.isArray(evidencePack) ? evidencePack : [];
  if (evidence.length === 0) {
    return false;
  }

  return evidence.some((item) => {
    const tokens = cleanEvidenceText(item.excerpt)
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= 6)
      .slice(0, 6);
    return tokens.some((token) => normalizedBody.includes(token));
  });
}

function evaluateDeepScreenQuality({ bodyLong, evidencePack, previousBody, minChars }) {
  const text = `${bodyLong || ""}`.trim();
  if (text.length < minChars) {
    return { ok: false, reason: "too-short" };
  }
  if (looksNoisyEvidence(text)) {
    return { ok: false, reason: "noise" };
  }
  if (!hasEvidenceGrounding(text, evidencePack)) {
    return { ok: false, reason: "not-grounded" };
  }
  if (`${previousBody || ""}`.trim()) {
    const similarity = jaccardSimilarity(previousBody, text);
    if (similarity > 0.86) {
      return { ok: false, reason: "duplicate" };
    }
  }
  return { ok: true, reason: "" };
}

function buildScreenFromWriterResult({ baseScreen, writtenScreen, evidencePack, minChars, objective }) {
  const title = `${writtenScreen?.title || baseScreen?.title || "Screen"}`.trim() || "Screen";
  const rawText = collectScreenBodyText(writtenScreen) || collectScreenBodyText(baseScreen);
  const bodyLong = ensureLongBody(rawText, evidencePack, title, minChars);
  const keyTakeaways = collectKeyTakeaways(writtenScreen, evidencePack);
  const practicalStep = objective
    ? `Practical step: apply "${objective}" in one real work task and document the result.`
    : "Practical step: apply the key procedure to a real case and document the result.";

  const blocks = [
    {
      type: "text",
      text: bodyLong
    },
    {
      type: "list",
      items: keyTakeaways.length > 0 ? keyTakeaways : [
        "Identify the key rule",
        "Check applicability in a real case",
        "Document the execution result"
      ]
    },
    createEvidenceNote(evidencePack)
  ];

  return {
    ...baseScreen,
    title,
    bodyLong,
    keyTakeaways,
    practicalStep,
    evidence: evidencePack,
    blocks
  };
}

async function runWriterForScreen({
  input,
  baseScreen,
  evidencePack,
  objective,
  trace,
  ragContext
}) {
  if (!input?.generation || input.generation.provider === "template") {
    return null;
  }

  const writerInput = {
    ...input,
    titleHint: `${input.titleHint} | ${baseScreen?.title || "Screen"}`,
    learningGoals: objective ? [objective] : input.learningGoals,
    structure: {
      moduleCount: 1,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      enabled: false,
      questionCount: 0,
      passingScore: Number(input?.finalTest?.passingScore) || 80,
      attemptsLimit: 1,
      maxTimeMinutes: 30
    },
    generation: {
      ...createStructuredGenerationConfig(input.generation, { max: 0.28, fallback: 0.22 }),
      generationPhase: "writer"
    },
    ragContext: evidencePackToRagContext(ragContext, evidencePack, `${trace.module}.${trace.section}.${trace.sco}.${trace.screen}`, objective)
  };

  const outline = await createOutlineFromLocalLlm(writerInput, {
    strict: true,
    trace: {
      stage: "writer",
      module: trace.module,
      section: trace.section,
      sco: trace.sco,
      screen: trace.screen,
      attempt: trace.attempt
    },
    validate: {
      expectedModules: 1,
      expectedSections: 1,
      expectedScos: 1,
      expectedScreens: 1,
      maxPlaceholderRatio: 0.08,
      minAvgTextLength: 280,
      minUniqueRatio: 0.2
    }
  });

  const built = buildCourseFromOutline(writerInput, outline);
  return built?.modules?.[0]?.sections?.[0]?.scos?.[0]?.screens?.[0] || null;
}

async function writeAndCriticScreen({
  input,
  screen,
  evidencePack,
  objective,
  previousBody,
  trace,
  ragContext,
  hooks
}) {
  const minChars = input?.contentDepthMode === "deep" ? 900 : 420;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    reportProgress(hooks, 42, "writer", `Writer generates M${trace.module} S${trace.section} C${trace.sco} P${trace.screen} (attempt ${attempt})`);

    let writtenScreen = null;
    try {
      writtenScreen = await runWriterForScreen({
        input,
        baseScreen: screen,
        evidencePack,
        objective,
        ragContext,
        trace: {
          ...trace,
          attempt
        }
      });
    } catch {
      writtenScreen = null;
    }

    const candidate = buildScreenFromWriterResult({
      baseScreen: screen,
      writtenScreen: writtenScreen || screen,
      evidencePack,
      minChars,
      objective
    });

    const quality = evaluateDeepScreenQuality({
      bodyLong: candidate.bodyLong,
      evidencePack,
      previousBody,
      minChars
    });

    reportProgress(hooks, 44, "critic", `Critic checks M${trace.module} S${trace.section} C${trace.sco} P${trace.screen} (attempt ${attempt})`);
    if (quality.ok) {
      return candidate;
    }
  }

  return buildScreenFromWriterResult({
    baseScreen: screen,
    writtenScreen: screen,
    evidencePack,
    minChars,
    objective
  });
}

function flattenScreens(modules) {
  const result = [];
  for (const moduleItem of modules || []) {
    for (const section of moduleItem.sections || []) {
      for (const sco of section.scos || []) {
        for (const screen of sco.screens || []) {
          result.push(screen);
        }
      }
    }
  }
  return result;
}

function computeCourseQualityMetrics(course) {
  const screens = flattenScreens(course?.modules || []);
  const total = screens.length;
  if (total === 0) {
    return {
      avgScreenChars: 0,
      evidenceCoverage: 0,
      duplicateRatio: 0
    };
  }

  const lengths = screens.map((screen) => `${screen?.bodyLong || collectScreenBodyText(screen) || ""}`.length);
  const avgScreenChars = Math.round(lengths.reduce((sum, value) => sum + value, 0) / total);
  const withEvidence = screens.filter((screen) => Array.isArray(screen?.evidence) && screen.evidence.length > 0).length;
  const evidenceCoverage = Number((withEvidence / total).toFixed(4));

  let duplicates = 0;
  let previous = "";
  for (const screen of screens) {
    const current = `${screen?.bodyLong || collectScreenBodyText(screen) || ""}`;
    if (previous && jaccardSimilarity(previous, current) > 0.86) {
      duplicates += 1;
    }
    previous = current;
  }
  const duplicateRatio = Number((duplicates / total).toFixed(4));

  return {
    avgScreenChars,
    evidenceCoverage,
    duplicateRatio
  };
}

function buildFinalTestFromScreens(course, input, hooks) {
  if (!Boolean(input?.finalTest?.enabled)) {
    return {
      ...(course.finalTest || {}),
      enabled: false,
      questionCount: 0,
      questions: []
    };
  }

  reportProgress(hooks, 84, "test-builder", "Building final test from approved screens");
  const screens = flattenScreens(course?.modules || []).filter((screen) => `${screen?.bodyLong || ""}`.trim().length > 80);
  const desiredCount = Math.max(1, Math.trunc(Number(input?.finalTest?.questionCount) || 8));

  if (screens.length === 0) {
    return {
      id: createId("final_test"),
      enabled: true,
      title: "Final test",
      questionCount: desiredCount,
      passingScore: Number(input?.finalTest?.passingScore) || 80,
      attemptsLimit: Number(input?.finalTest?.attemptsLimit) || 1,
      maxTimeMinutes: Number(input?.finalTest?.maxTimeMinutes) || 30,
      questions: []
    };
  }

  const questions = Array.from({ length: desiredCount }, (_, index) => {
    const target = screens[index % screens.length];
    const distractorA = screens[(index + 1) % screens.length];
    const distractorB = screens[(index + 2) % screens.length];
    const distractorC = screens[(index + 3) % screens.length];

    const correctText = (target?.keyTakeaways?.[0] || firstSentence(target?.bodyLong, target?.title || "Correct option")).slice(0, 180);
    const wrongTexts = [
      (distractorA?.keyTakeaways?.[0] || firstSentence(distractorA?.bodyLong, distractorA?.title || "")),
      (distractorB?.keyTakeaways?.[0] || firstSentence(distractorB?.bodyLong, distractorB?.title || "")),
      (distractorC?.keyTakeaways?.[0] || firstSentence(distractorC?.bodyLong, distractorC?.title || ""))
    ].map((item, wrongIndex) => `${item || `Incorrect option ${wrongIndex + 1}`}`.slice(0, 180));

    const optionTexts = rotateList([correctText, ...wrongTexts], index % 4);
    const options = optionTexts.map((text) => ({
      id: createId("option"),
      text
    }));
    const correctOption = options.find((option) => option.text === correctText) || options[0];

    return {
      id: createId("question"),
      prompt: `Which statement correctly reflects the course "${course?.title || input?.titleHint || "Course"}" material for screen "${target?.title || `Screen ${index + 1}`}"?`,
      options,
      correctOptionId: correctOption.id,
      explanation: `The correct answer is grounded in screen "${target?.title || `Screen ${index + 1}`}".`,
      screenRefs: target?.id ? [target.id] : []
    };
  });

  return {
    id: createId("final_test"),
    enabled: true,
    title: `${course?.finalTest?.title || "Final test"}`,
    questionCount: desiredCount,
    passingScore: Number(input?.finalTest?.passingScore) || 80,
    attemptsLimit: Number(input?.finalTest?.attemptsLimit) || 1,
    maxTimeMinutes: Number(input?.finalTest?.maxTimeMinutes) || 30,
    questions
  };
}

async function runV4Pipeline(course, input, ragContext, plan, hooks) {
  const modules = Array.isArray(course?.modules) ? course.modules : [];
  const totalScreens = flattenScreens(modules).length;
  let processed = 0;
  let previousBody = "";

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const moduleItem = modules[moduleIndex];
    for (let sectionIndex = 0; sectionIndex < (moduleItem.sections || []).length; sectionIndex += 1) {
      const section = moduleItem.sections[sectionIndex];
      for (let scoIndex = 0; scoIndex < (section.scos || []).length; scoIndex += 1) {
        const sco = section.scos[scoIndex];
        for (let screenIndex = 0; screenIndex < (sco.screens || []).length; screenIndex += 1) {
          const screen = sco.screens[screenIndex];
          const slotId = screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex);
          const objective = Array.isArray(plan?.screenPlanHints)
            ? (plan.screenPlanHints.find((hint) => hint.slotId === slotId)?.objective || "")
            : "";
          let evidencePack = buildEvidencePack(plan, moduleIndex, sectionIndex, scoIndex, screenIndex);
          if (evidencePack.length === 0) {
            const fallbackExcerpt = firstSentence(collectScreenBodyText(screen) || screen?.title || "Fallback evidence", "Fallback evidence");
            evidencePack = [{
              factId: `fallback_${moduleIndex + 1}_${sectionIndex + 1}_${scoIndex + 1}_${screenIndex + 1}`,
              source: "generated-context",
              materialId: "",
              chunkId: "",
              excerpt: fallbackExcerpt
            }];
          }

          reportProgress(hooks, 38, "retriever", `Retriever prepared evidence for M${moduleIndex + 1} S${sectionIndex + 1} C${scoIndex + 1} P${screenIndex + 1}`);
          const updatedScreen = await writeAndCriticScreen({
            input,
            screen,
            evidencePack,
            objective,
            previousBody,
            ragContext,
            hooks,
            trace: {
              module: moduleIndex + 1,
              section: sectionIndex + 1,
              sco: scoIndex + 1,
              screen: screenIndex + 1
            }
          });

          sco.screens[screenIndex] = {
            ...updatedScreen,
            id: screen?.id || createId("screen"),
            order: screenIndex + 1
          };
          previousBody = `${updatedScreen?.bodyLong || ""}`;

          processed += 1;
          const ratio = totalScreens > 0 ? processed / totalScreens : 0;
          const percent = Math.max(40, Math.min(83, Math.round(40 + ratio * 43)));
          reportProgress(hooks, percent, "critic", `Validated ${processed}/${totalScreens} screens`);
        }
      }
    }
  }

  course.finalTest = buildFinalTestFromScreens(course, input, hooks);
  const metrics = computeCourseQualityMetrics(course);
  reportProgress(hooks, 87, "critic", "Quality metrics computed", metrics);
  reportProgress(hooks, 89, "test-builder", "Final test generated from approved screens", metrics);
  return { course, metrics };
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

function applyPlannerQualityGate(course, input, plan) {
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
      bullets: ["Key concept", "Practical value", "Immediate next action"]
    };
  }

  const main = sentences.slice(0, 2).join(" ");
  const bullets = sentences.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`Key takeaway ${bullets.length + 1}`);
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
    return ["Key concept from source", "Practical takeaway", "How to apply at work"];
  }

  const parts = cleaned
    .split(/[.;!?]\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const bullets = parts.slice(0, 3).map((item) => item.slice(0, 120));
  while (bullets.length < 3) {
    bullets.push(`Key takeaway ${bullets.length + 1}`);
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
    result.push(`Option ${result.length + 1} for question ${questionIndex + 1}`);
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
    const moduleTopic = firstSentence(seed.text, stripExtension(seed.fileName) || `Topic ${moduleIndex + 1}`)
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
            const snippet = `${source.text || ""}`.trim().slice(0, 900);
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
    .flatMap((chunk) => sentencePoolFromText(chunk.text))
    .filter(Boolean);
  const fallbackStatements = chunks.map((chunk) =>
    firstSentence(chunk.text, "Key source statement.")
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
            message: `LLM returned invalid structured content; line-plan fallback with retrieval context was applied.`
          }
        };
        return await finalizeGeneratedCourse(planCourse, input, ragContext);
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
            message: `LLM returned invalid structured content; extractive fallback from source materials was applied.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}`
          }
        };
        return await finalizeGeneratedCourse(extractiveCourse, input, ragContext);
      }
      throw new Error("LLM returned low-quality template output. Increase Top-K and verify source materials.");
    }
    return await finalizeGeneratedCourse(course, input, ragContext);
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
          message: `LLM returned invalid structured content; line-plan fallback with retrieval context was applied.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}`
        }
      };
      return await finalizeGeneratedCourse(planCourse, input, ragContext);
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
          message: `LLM returned invalid structured content; extractive fallback from source materials was applied.${llmFailureMessage ? ` ${llmFailureMessage}` : ""}${linePlanFailureMessage ? ` ${linePlanFailureMessage}` : ""}`
        }
      };
      return await finalizeGeneratedCourse(extractiveCourse, input, ragContext);
    }
    throw new Error("LLM did not return valid course structure and fallback generation failed.");
  }

  return await finalizeGeneratedCourse(buildTemplateDraft(payload), input, ragContext);
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
  const provider = `${input?.generation?.provider || ""}`.trim().toLowerCase();
  const ollamaScreensRaw = Number(process.env.LLM_SEGMENTED_OLLAMA_TOTAL_SCREENS_THRESHOLD);
  const ollamaScreensThreshold = Number.isFinite(ollamaScreensRaw) && ollamaScreensRaw > 0
    ? Math.trunc(ollamaScreensRaw)
    : 18;
  const ollamaPrefer = provider === "ollama" && size.totalScreens >= ollamaScreensThreshold;

  return ollamaPrefer
    || size.moduleCount >= Math.max(2, Math.floor(moduleThreshold * largeModelPenalty))
    || size.totalScreens >= Math.max(12, Math.floor(totalScreensThreshold * largeModelPenalty))
    || size.screensPerModule >= Math.max(4, Math.floor(screensPerModuleThreshold * largeModelPenalty));
}

function estimateMainOutlinePayloadSize(input, ragContext) {
  const chunks = Array.isArray(ragContext?.chunks) ? ragContext.chunks : [];
  const screenPlanHints = Array.isArray(ragContext?.screenPlanHints) ? ragContext.screenPlanHints : [];
  const goalsText = Array.isArray(input?.learningGoals) ? input.learningGoals.join(" ") : "";

  const chunkChars = chunks.reduce((sum, chunk) => {
    const text = `${chunk?.text || ""}`;
    const name = `${chunk?.fileName || chunk?.sourceName || ""}`;
    return sum + text.length + name.length + 40;
  }, 0);

  const hintsChars = screenPlanHints.reduce((sum, hint) => {
    const objective = `${hint?.objective || ""}`;
    const facts = Array.isArray(hint?.keyFacts) ? hint.keyFacts.join(" ") : "";
    return sum + objective.length + facts.length + 20;
  }, 0);

  const metadataChars = `${input?.titleHint || ""}`.length + `${input?.audience || ""}`.length + goalsText.length + 1200;
  return chunkChars + hintsChars + metadataChars;
}

function shouldSkipMainOutlineAttempt(input, ragContext) {
  const forceMain = `${process.env.LLM_FORCE_MAIN_OUTLINE || ""}`.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(forceMain)) {
    return false;
  }

  const disableMain = `${process.env.LLM_DISABLE_MAIN_OUTLINE || ""}`.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(disableMain)) {
    return true;
  }

  const provider = `${input?.generation?.provider || ""}`.trim().toLowerCase();
  if (provider !== "ollama") {
    return false;
  }

  const payloadThresholdRaw = Number(process.env.LLM_MAIN_OUTLINE_MAX_PAYLOAD_CHARS);
  const payloadThreshold = Number.isFinite(payloadThresholdRaw) && payloadThresholdRaw > 0
    ? Math.trunc(payloadThresholdRaw)
    : 10_000;

  const estimatedPayload = estimateMainOutlinePayloadSize(input, ragContext);
  const chunkCount = Array.isArray(ragContext?.chunks) ? ragContext.chunks.length : 0;
  const size = getStructureSize(input);

  return estimatedPayload >= payloadThreshold
    || chunkCount >= 8
    || size.totalScreens >= 12
    || size.moduleCount > 1
    || size.screensPerSco >= 4
    || isLikelyLargeModel(input?.generation?.model);
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

function createStructuredGenerationConfig(generation, defaults = {}) {
  const envTemperatureRaw = Number(process.env.LLM_STRUCTURED_TEMPERATURE);
  const minTemp = Number.isFinite(Number(defaults?.min)) ? Number(defaults.min) : 0.05;
  const maxTemp = Number.isFinite(Number(defaults?.max)) ? Number(defaults.max) : 0.35;
  const fallbackTemp = Number.isFinite(Number(defaults?.fallback)) ? Number(defaults.fallback) : 0.25;
  const preferred = Number.isFinite(envTemperatureRaw) && envTemperatureRaw > 0
    ? envTemperatureRaw
    : Number(generation?.temperature);
  const normalized = Number.isFinite(preferred) && preferred > 0
    ? Math.max(minTemp, Math.min(maxTemp, preferred))
    : fallbackTemp;

  return {
    ...(generation || {}),
    temperature: normalized
  };
}

function createBatchFinalTestConfig(input) {
  return {
    enabled: false,
    questionCount: 0,
    passingScore: Number(input?.finalTest?.passingScore) || 70,
    attemptsLimit: 1,
    maxTimeMinutes: Math.max(1, Math.min(30, Number(input?.finalTest?.maxTimeMinutes) || 20))
  };
}

async function quickLlmReachabilityProbe(config) {
  if (!config || config.provider === "template") {
    return { ok: true, message: "" };
  }

  const baseUrl = `${config.baseUrl || ""}`
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .find(Boolean)?.replace(/\/$/, "") || "";
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

function shouldUseTwoPhaseGeneration(input) {
  if (isDeepV4Mode(input)) {
    return true;
  }
  const forced = `${process.env.LLM_TWO_PHASE_GENERATION || "1"}`.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(forced)) {
    return false;
  }
  const size = getStructureSize(input);
  return size.totalScreens >= 12 || size.screensPerSco >= 4;
}

function getScreensPerBatchTarget(input) {
  const requested = Number(process.env.LLM_SCREEN_BATCH_MAX);
  const maxValue = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 5;
  return Math.max(1, Math.min(5, maxValue));
}

function applyPhaseBPlannerFillToSco({ scoPayload, moduleIndex, sectionIndex, scoIndex, input, plan, hooks }) {
  if (!scoPayload || !Array.isArray(scoPayload.screens)) {
    return;
  }

  const groupSizeRaw = Number(process.env.LLM_PHASE_B_SCREEN_GROUP_SIZE);
  const groupSize = Number.isFinite(groupSizeRaw) && groupSizeRaw > 0
    ? Math.max(3, Math.min(5, Math.trunc(groupSizeRaw)))
    : 4;

  for (let start = 0; start < scoPayload.screens.length; start += groupSize) {
    const end = Math.min(scoPayload.screens.length, start + groupSize);
    for (let localScreenIndex = start; localScreenIndex < end; localScreenIndex += 1) {
      const slotId = screenSlotId(moduleIndex, sectionIndex, scoIndex, localScreenIndex);
      const facts = getPlanSlotFacts(plan, slotId);
      if (!Array.isArray(facts) || facts.length === 0) {
        continue;
      }
      const currentScreen = scoPayload.screens[localScreenIndex] || {};
      const rewritten = renderScreenFromFacts(facts, currentScreen.title, input?.audience || "learners");
      scoPayload.screens[localScreenIndex] = {
        ...currentScreen,
        title: currentScreen.title || rewritten.title,
        blocks: rewritten.blocks,
        order: localScreenIndex + 1
      };
    }

    if (typeof hooks?.onProgress === "function") {
      hooks.onProgress(
        Math.min(86, 40 + Math.round((end / Math.max(1, scoPayload.screens.length)) * 36)),
        "phase-b",
        `Filled screen text from planner facts: screens ${start + 1}-${end}`
      );
    }
  }
}

function isTruthy(value, fallback = false) {
  const source = `${value ?? ""}`.trim().toLowerCase();
  if (!source) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(source);
}

function getSegmentConcurrency() {
  const configured = Number(process.env.LLM_SEGMENT_CONCURRENCY);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(6, Math.trunc(configured)));
}

function isReducibleBatchError(error) {
  const message = `${error instanceof Error ? error.message : error || ""}`.toLowerCase();
  return /timeout|aborted|unreachable|fetch failed|network|expected-screens|no-modules|valid json|outline payload is empty|status 5\d\d/.test(message);
}

async function runWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.min(items.length, Math.trunc(limit) || 1));
  if (concurrency === 1) {
    const sequential = [];
    for (const item of items) {
      sequential.push(await worker(item));
    }
    return sequential;
  }

  const results = new Array(items.length);
  let cursor = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const schedule = () => {
      if (cursor >= items.length && active === 0) {
        resolve(results);
        return;
      }

      while (active < concurrency && cursor < items.length) {
        const index = cursor;
        const item = items[cursor];
        cursor += 1;
        active += 1;
        Promise.resolve()
          .then(() => worker(item))
          .then((result) => {
            results[index] = result;
            active -= 1;
            schedule();
          })
          .catch((error) => {
            reject(error);
          });
      }
    };
    schedule();
  });
}

async function generateScoPayloadInAdaptiveBatches({
  input,
  ragContext,
  plannerPlan,
  hooks,
  moduleIndex,
  sectionIndex,
  scoIndex,
  useTwoPhase,
  screensPerBatchTarget
}) {
  const totalScreens = Math.max(1, Math.trunc(Number(input?.structure?.screensPerSco) || 1));
  const accumulatedScreens = [];
  let generatedModuleTitle = "";
  let generatedSectionTitle = "";
  let generatedScoTitle = "";
  let screenStart = 0;
  let currentBatchMax = Math.max(1, screensPerBatchTarget);

  while (screenStart < totalScreens) {
    const remainingScreens = totalScreens - screenStart;
    let batchScreens = Math.min(currentBatchMax, remainingScreens);
    let attempt = 0;
    let completed = false;

    while (!completed) {
      attempt += 1;

      const scoInput = {
        ...input,
        titleHint: `${input.titleHint} | Module ${moduleIndex + 1} | Section ${sectionIndex + 1} | SCO ${scoIndex + 1} | Screens ${screenStart + 1}-${screenStart + batchScreens}`,
        structure: {
          ...input.structure,
          moduleCount: 1,
          sectionsPerModule: 1,
          scosPerSection: 1,
          screensPerSco: batchScreens
        },
        generation: {
          ...createStructuredGenerationConfig(input.generation, useTwoPhase ? { max: 0.22, fallback: 0.14 } : { max: 0.3, fallback: 0.22 }),
          generationPhase: useTwoPhase ? "structure" : "full"
        },
        finalTest: createBatchFinalTestConfig(input),
        learningGoals: Array.isArray(input.learningGoals) && input.learningGoals.length > 0
          ? [input.learningGoals[(moduleIndex + sectionIndex + scoIndex + screenStart) % input.learningGoals.length]]
          : input.learningGoals
      };

      const scopedRagContext = createPlannerScopedRagContext(plannerPlan, ragContext, {
        moduleIndex,
        sectionIndex,
        scoIndex
      });

      const startedAt = Date.now();
      try {
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
            batchStart: screenStart + 1,
            batchScreens,
            attempt
          },
          validate: useTwoPhase
            ? {
                expectedModules: 1,
                expectedSections: 1,
                expectedScos: 1,
                expectedScreens: batchScreens,
                maxPlaceholderRatio: 0.45,
                minAvgTextLength: 35,
                minUniqueRatio: 0.35
              }
            : {
                expectedModules: 1,
                expectedSections: 1,
                expectedScos: 1,
                expectedScreens: batchScreens,
                maxPlaceholderRatio: 0.08,
                minAvgTextLength: 170,
                minUniqueRatio: 0.72
              }
        });

        const scoCourse = buildCourseFromOutline(scoInput, scoOutline);
        const modulePayload = scoCourse?.modules?.[0] || null;
        const sectionPayload = modulePayload?.sections?.[0] || null;
        const scoPayload = sectionPayload?.scos?.[0] || null;
        if (!scoPayload) {
          throw new Error(`Module ${moduleIndex + 1}, section ${sectionIndex + 1}, SCO ${scoIndex + 1}: outline payload is empty.`);
        }

        if (!generatedModuleTitle && `${modulePayload?.title || ""}`.trim()) {
          generatedModuleTitle = `${modulePayload.title}`.trim();
        }
        if (!generatedSectionTitle && `${sectionPayload?.title || ""}`.trim()) {
          generatedSectionTitle = `${sectionPayload.title}`.trim();
        }
        if (!generatedScoTitle && `${scoPayload?.title || ""}`.trim()) {
          generatedScoTitle = `${scoPayload.title}`.trim();
        }

        const partialScreens = Array.isArray(scoPayload?.screens) ? scoPayload.screens : [];
        for (let localScreenIndex = 0; localScreenIndex < partialScreens.length; localScreenIndex += 1) {
          const globalScreenIndex = screenStart + localScreenIndex;
          const original = partialScreens[localScreenIndex] || {};
          accumulatedScreens.push({
            ...original,
            order: globalScreenIndex + 1,
            title: `${original?.title || `Screen ${globalScreenIndex + 1}`}`.trim() || `Screen ${globalScreenIndex + 1}`,
            blocks: useTwoPhase
              ? [{ type: "text", text: "Phase A structure placeholder." }]
              : (Array.isArray(original?.blocks) ? original.blocks : [])
          });
        }

        const durationMs = Date.now() - startedAt;
        console.log("[generator] batch", {
          module: moduleIndex + 1,
          section: sectionIndex + 1,
          sco: scoIndex + 1,
          fromScreen: screenStart + 1,
          batchScreens,
          attempt,
          durationMs,
          phase: useTwoPhase ? "A-structure" : "single-phase"
        });

        completed = true;
        screenStart += batchScreens;
        currentBatchMax = Math.max(1, screensPerBatchTarget);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        console.log("[generator] batch-error", {
          module: moduleIndex + 1,
          section: sectionIndex + 1,
          sco: scoIndex + 1,
          fromScreen: screenStart + 1,
          batchScreens,
          attempt,
          durationMs,
          message: error instanceof Error ? error.message : `${error || "unknown error"}`
        });

        if (batchScreens > 1 && isReducibleBatchError(error) && allowBatchDownsize()) {
          batchScreens = Math.max(1, Math.floor(batchScreens / 2));
          currentBatchMax = batchScreens;
          continue;
        }
        throw error;
      }
    }
  }

  const finalScoPayload = {
    id: createId("sco"),
    title: generatedScoTitle || `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
    order: scoIndex + 1,
    screens: accumulatedScreens
  };

  if (useTwoPhase && !isDeepV4Mode(input)) {
    applyPhaseBPlannerFillToSco({
      scoPayload: finalScoPayload,
      moduleIndex,
      sectionIndex,
      scoIndex,
      input,
      plan: plannerPlan,
      hooks
    });
  }

  return {
    scoPayload: finalScoPayload,
    sectionTitle: generatedSectionTitle,
    moduleTitle: generatedModuleTitle
  };
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

  const batchOnly = isTruthy(process.env.LLM_BATCH_ONLY, true);
  const scoPriorityRaw = String(process.env.LLM_SEGMENT_PRIORITY || "sco").trim().toLowerCase();
  const preferScoPriority = ["sco", "sco-first", "per-sco"].includes(scoPriorityRaw);
  const useTwoPhase = shouldUseTwoPhaseGeneration(input);
  const screensPerBatchTarget = getScreensPerBatchTarget(input);
  const segmentConcurrency = getSegmentConcurrency();

  const splitByScoBySize = size.scosPerSection > 1
    && (size.screensPerSco >= Math.max(2, scoSplitThreshold - 2)
      || size.totalScreens >= Math.max(30, scoSplitThreshold * 6));
  const splitBySco = batchOnly
    ? size.scosPerSection >= 1
    : (size.scosPerSection > 1 && (preferScoPriority || splitByScoBySize || useTwoPhase));
  const splitBySection = !splitBySco
    && size.sectionsPerModule > 1
    && size.screensPerModule >= sectionSplitThreshold;

  if (size.moduleCount <= 1 && !splitBySection && !splitBySco) {
    return null;
  }

  const generationMode = splitBySection
    ? "llm-outline-per-section"
    : (splitBySco ? (useTwoPhase ? "llm-two-phase-per-sco" : "llm-outline-per-sco") : "llm-outline-per-module");

  const totalBatches = splitBySection
    ? size.moduleCount * size.sectionsPerModule
    : (splitBySco
      ? size.moduleCount * size.sectionsPerModule * size.scosPerSection
      : size.moduleCount);

  const resumedModules = Array.isArray(hooks?.resumeModules)
    ? hooks.resumeModules.slice(0, size.moduleCount)
    : [];
  const modules = [...resumedModules];
  const baseCourse = buildTemplateDraft(input);
  let doneBatches = splitBySection
    ? modules.length * size.sectionsPerModule
    : (splitBySco
      ? modules.length * size.sectionsPerModule * size.scosPerSection
      : modules.length);

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

  for (let moduleIndex = modules.length; moduleIndex < size.moduleCount; moduleIndex += 1) {
    if (splitBySection) {
      const sectionPayloads = [];
      let moduleTitle = "";

      for (let sectionIndex = 0; sectionIndex < size.sectionsPerModule; sectionIndex += 1) {
        const sectionInput = {
          ...input,
          titleHint: `${input.titleHint} | Module ${moduleIndex + 1} | Section ${sectionIndex + 1}`,
          structure: {
            ...input.structure,
            moduleCount: 1,
            sectionsPerModule: 1
          },
          generation: {
            ...createStructuredGenerationConfig(input.generation, useTwoPhase ? { max: 0.22, fallback: 0.14 } : { max: 0.3, fallback: 0.22 }),
            generationPhase: useTwoPhase ? "structure" : "full"
          },
          finalTest: createBatchFinalTestConfig(input),
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
          },
          validate: useTwoPhase
            ? {
                expectedModules: 1,
                expectedSections: 1,
                expectedScos: sectionInput.structure.scosPerSection,
                expectedScreens: sectionInput.structure.screensPerSco,
                maxPlaceholderRatio: 0.45,
                minAvgTextLength: 35,
                minUniqueRatio: 0.35
              }
            : {
                expectedModules: 1,
                expectedSections: 1,
                expectedScos: sectionInput.structure.scosPerSection,
                expectedScreens: sectionInput.structure.screensPerSco,
                maxPlaceholderRatio: 0.08,
                minAvgTextLength: 170,
                minUniqueRatio: 0.72
              }
        });

        const sectionCourse = buildCourseFromOutline(sectionInput, sectionOutline);
        const generatedModuleTitle = `${sectionCourse?.modules?.[0]?.title || ""}`.trim();
        if (!moduleTitle && generatedModuleTitle) {
          moduleTitle = generatedModuleTitle;
        }
        const sectionPayload = sectionCourse?.modules?.[0]?.sections?.[0] || null;
        if (!sectionPayload) {
          throw new Error(`Module ${moduleIndex + 1}, section ${sectionIndex + 1}: outline payload is empty.`);
        }

        if (useTwoPhase && !isDeepV4Mode(input)) {
          for (let scoIndex = 0; scoIndex < (sectionPayload.scos || []).length; scoIndex += 1) {
            applyPhaseBPlannerFillToSco({
              scoPayload: sectionPayload.scos[scoIndex],
              moduleIndex,
              sectionIndex,
              scoIndex,
              input,
              plan: plannerPlan,
              hooks
            });
          }
        }

        sectionPayload.order = sectionIndex + 1;
        sectionPayloads.push(sectionPayload);
        reportBatchProgress(`Planned M${moduleIndex + 1} S${sectionIndex + 1}`);
      }

      const modulePayload = {
        id: createId("module"),
        title: moduleTitle || `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
        order: moduleIndex + 1,
        sections: sectionPayloads
      };

      modules.push(modulePayload);
      await emitModuleReady(modulePayload, moduleIndex);
      continue;
    }

    if (splitBySco) {
      const sectionPayloads = [];
      let moduleTitle = "";

      for (let sectionIndex = 0; sectionIndex < size.sectionsPerModule; sectionIndex += 1) {
        let sectionTitle = `Section ${moduleIndex + 1}.${sectionIndex + 1}`;
        const scoIndexes = Array.from({ length: size.scosPerSection }, (_, scoIndex) => scoIndex);
        const scoResults = await runWithConcurrency(scoIndexes, segmentConcurrency, async (scoIndex) => {
          const result = await generateScoPayloadInAdaptiveBatches({
            input,
            ragContext,
            plannerPlan,
            hooks,
            moduleIndex,
            sectionIndex,
            scoIndex,
            useTwoPhase,
            screensPerBatchTarget
          });
          reportBatchProgress(`Planned M${moduleIndex + 1} S${sectionIndex + 1} SCO${scoIndex + 1}`);
          return { scoIndex, ...result };
        });

        const orderedScoResults = [...scoResults].sort((left, right) => left.scoIndex - right.scoIndex);
        const scoPayloads = orderedScoResults.map((result) => result.scoPayload);

        const firstSectionTitle = orderedScoResults.find((result) => `${result?.sectionTitle || ""}`.trim());
        if (firstSectionTitle?.sectionTitle) {
          sectionTitle = firstSectionTitle.sectionTitle;
        }
        const firstModuleTitle = orderedScoResults.find((result) => `${result?.moduleTitle || ""}`.trim());
        if (!moduleTitle && firstModuleTitle?.moduleTitle) {
          moduleTitle = firstModuleTitle.moduleTitle;
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
        title: moduleTitle || `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
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
      generation: {
        ...createStructuredGenerationConfig(input.generation, useTwoPhase ? { max: 0.22, fallback: 0.14 } : { max: 0.3, fallback: 0.22 }),
        generationPhase: useTwoPhase ? "structure" : "full"
      },
      finalTest: createBatchFinalTestConfig(input),
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
      },
      validate: useTwoPhase
        ? {
            expectedModules: 1,
            expectedSections: moduleInput.structure.sectionsPerModule,
            expectedScos: moduleInput.structure.scosPerSection,
            expectedScreens: moduleInput.structure.screensPerSco,
            maxPlaceholderRatio: 0.45,
            minAvgTextLength: 35,
            minUniqueRatio: 0.35
          }
        : {
            expectedModules: 1,
            expectedSections: moduleInput.structure.sectionsPerModule,
            expectedScos: moduleInput.structure.scosPerSection,
            expectedScreens: moduleInput.structure.screensPerSco,
            maxPlaceholderRatio: 0.09,
            minAvgTextLength: 165,
            minUniqueRatio: 0.7
          }
    });

    const moduleCourse = buildCourseFromOutline(moduleInput, moduleOutline);
    const modulePayload = Array.isArray(moduleCourse?.modules) ? moduleCourse.modules[0] : null;
    if (!modulePayload) {
      throw new Error(`Module ${moduleIndex + 1}: outline payload is empty.`);
    }

    if (useTwoPhase && !isDeepV4Mode(input)) {
      for (let sectionIndex = 0; sectionIndex < (modulePayload.sections || []).length; sectionIndex += 1) {
        const section = modulePayload.sections[sectionIndex];
        for (let scoIndex = 0; scoIndex < (section.scos || []).length; scoIndex += 1) {
          applyPhaseBPlannerFillToSco({
            scoPayload: section.scos[scoIndex],
            moduleIndex,
            sectionIndex,
            scoIndex,
            input,
            plan: plannerPlan,
            hooks
          });
        }
      }
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
  const coverageCheck = validateGenerationPlanCoverage(plannerPlan, {});
  const enforceCoverageGate = Boolean(
    input?.rag?.enabled
    && Array.isArray(input?.rag?.documentIds)
    && input.rag.documentIds.length > 0
  );
  if (!coverageCheck.ok && enforceCoverageGate) {
    throw new Error(`Planner fact coverage is insufficient for requested structure: ${coverageCheck.reason}. Re-index documents or reduce modules/screens.`);
  }
  if (!coverageCheck.ok) {
    reportProgress(hooks, 9, "planner", `Coverage warning: ${coverageCheck.reason}`);
  }
  const plannerGlobalRagContext = createPlannerScopedRagContext(plannerPlan, ragContext, {});
  reportProgress(hooks, 10, "planner", "Planner assigned facts to slots");

  let outline = null;
  let llmFailureMessage = "";
  let linePlan = null;
  let linePlanFailureMessage = "";
  let moduleBatchFailureMessage = "";
  let skipLlmCalls = false;
  let segmentedAttempted = false;

  const resumeModules = Array.isArray(payload?._resumeCourse?.modules)
    ? payload._resumeCourse.modules
    : [];
  const segmentedHooks = resumeModules.length > 0
    ? { ...hooks, resumeModules }
    : hooks;
  if (resumeModules.length > 0) {
    reportProgress(hooks, 11, "planner", `Resuming from ${resumeModules.length} completed modules`);
  }
  const batchOnly = isTruthy(process.env.LLM_BATCH_ONLY, true);
  const providerName = `${input?.generation?.provider || ""}`.trim().toLowerCase();
  const preferSegmented = batchOnly || providerName === "ollama" || shouldPreferSegmentedGeneration(input);
  const skipMainOutlineAttempt = batchOnly || shouldSkipMainOutlineAttempt(input, plannerGlobalRagContext);

  const trySegmentedGeneration = async (reason) => {
    if (segmentedAttempted) {
      return null;
    }
    segmentedAttempted = true;

    try {
      const segmentedCourse = await generateCourseByBatchesWithReset(input, ragContext, plannerPlan, segmentedHooks);
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
      return await finalizeGeneratedCourse(segmentedCourse, input, ragContext, plannerPlan, hooks);
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

  if (!skipLlmCalls && skipMainOutlineAttempt) {
    if (!llmFailureMessage) {
      llmFailureMessage = "Main outline was skipped to avoid long timeout risk on Ollama.";
    }
    const segmented = await trySegmentedGeneration(
      "Main outline was skipped due to timeout risk. Segmented generation mode was used."
    );
    if (segmented) {
      return segmented;
    }
  }

  if (!skipLlmCalls && !skipMainOutlineAttempt) {
    try {
      reportProgress(hooks, 18, "outline", "Generating main outline");
      outline = await createOutlineFromLocalLlm({
        ...input,
        ragContext: plannerGlobalRagContext
      }, {
        strict: false,
        trace: { stage: "main-outline" },
        validate: {
          expectedModules: input.structure.moduleCount,
          expectedSections: input.structure.sectionsPerModule,
          expectedScos: input.structure.scosPerSection,
          expectedScreens: input.structure.screensPerSco,
          maxPlaceholderRatio: 0.1,
          minAvgTextLength: 140,
          minUniqueRatio: 0.68
        }
      });
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
        return await finalizeGeneratedCourse(planCourse, input, ragContext, plannerPlan, hooks);
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
        return await finalizeGeneratedCourse(extractiveCourse, input, ragContext, plannerPlan, hooks);
      }
      throw new Error("LLM returned template-like content and fallback could not recover.");
    }

    reportProgress(hooks, 88, "quality", "Applying anti-repeat quality gate");
    return await finalizeGeneratedCourse(course, input, ragContext, plannerPlan, hooks);
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
    return await finalizeGeneratedCourse(planCourse, input, ragContext, plannerPlan, hooks);
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
    return await finalizeGeneratedCourse(extractiveCourse, input, ragContext, plannerPlan, hooks);
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
  return await finalizeGeneratedCourse(buildTemplateDraft(payload), input, ragContext, plannerPlan, hooks);
}



