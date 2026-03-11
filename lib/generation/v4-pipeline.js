import { 
  createOutlineFromLocalLlm, 
  buildCourseFromOutline, 
  createFinalTestFromLocalLlm 
} from "../local-llm.js";
import { createId } from "../ids.js";
import { 
  reportProgress, 
  buildEvidencePack, 
  evidencePackToRagContext, 
  writeAndCriticScreen,
  buildFinalTestFromScreens,
  flattenScreens,
  computeCourseQualityMetrics,
  isDeepV4Mode,
  collectScreenBodyText,
  buildScreenFromWriterResult,
  evaluateDeepScreenQuality,
  renderScreenFromFacts,
  firstSentence,
  rotateList,
  screenSlotId
} from "./pipeline-helpers.js";

// Re-exporting functions that will be defined here or imported for internal use
export { writeAndCriticScreen, buildFinalTestFromScreens, runV4Pipeline, applyPhaseBPlannerFillToSco, applyV4PipelineToSco };

async function runWriterForScreen({
  input,
  baseScreen,
  evidencePack,
  objective,
  previousBody,
  trace,
  ragContext
}) {
  if (!input?.generation || input.generation.provider === "template") {
    return null;
  }

  const { createStructuredGenerationConfig } = await import("./pipeline-helpers.js");

  const writerInput = {
    ...input,
    titleHint: `${input.titleHint} | ${baseScreen?.title || "Screen"}`,
    previousBodyText: previousBody,
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
        previousBody,
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

async function buildFinalTestFromScreens(course, input, hooks) {
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

  const combinedCourseText = screens.map(s => `=== ${s.title} ===\n${s.bodyLong}\n${(s.keyTakeaways||[]).map(t => "- " + t).join("\n")}`).join("\n\n");
  const aiQuestions = await createFinalTestFromLocalLlm(input, combinedCourseText, { trace: { phase: "final-test" } });

  let questions = [];

  if (aiQuestions && Array.isArray(aiQuestions) && aiQuestions.length >= desiredCount) {
    questions = aiQuestions.slice(0, desiredCount).map((q, index) => {
      let correctIndex = Number(q.correctOptionIndex);
      if (!Number.isFinite(correctIndex) || correctIndex < 0 || correctIndex > 3) correctIndex = 0;
      let opts = Array.isArray(q.options) ? q.options : ["Option 1", "Option 2", "Option 3", "Option 4"];
      while (opts.length < 4) opts.push("Option " + (opts.length + 1));
      
      const options = opts.slice(0, 4).map(o => ({ id: createId("option"), text: String(o).slice(0, 200) }));
      
      return {
        id: createId("question"),
        prompt: String(q.prompt || `Question ${index + 1}`).slice(0, 400),
        options,
        correctOptionId: options[correctIndex].id,
        explanation: String(q.explanation || "Correct based on the course material.").slice(0, 400),
        screenRefs: []
      };
    });
  } else {
    questions = Array.from({ length: desiredCount }, (_, index) => {
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
        prompt: `Which statement correctly reflects the course material for screen "${target?.title || `Screen ${index + 1}`}"?`,
        options,
        correctOptionId: correctOption.id,
        explanation: `The correct answer is grounded in screen "${target?.title || `Screen ${index + 1}`}".`,
        screenRefs: target?.id ? [target.id] : []
      };
    });
  }

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

  course.finalTest = await buildFinalTestFromScreens(course, input, hooks);
  const metrics = computeCourseQualityMetrics(course);
  reportProgress(hooks, 87, "critic", "Quality metrics computed", metrics);
  reportProgress(hooks, 89, "test-builder", "Final test generated from approved screens", metrics);
  return { course, metrics };
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

async function applyV4PipelineToSco({ scoPayload, moduleIndex, sectionIndex, scoIndex, input, ragContext, plan, hooks }) {
  if (!scoPayload || !Array.isArray(scoPayload.screens)) {
    return;
  }
  let previousBody = "";

  for (let screenIndex = 0; screenIndex < scoPayload.screens.length; screenIndex += 1) {
    const screen = scoPayload.screens[screenIndex];
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

    scoPayload.screens[screenIndex] = {
      ...updatedScreen,
      id: screen?.id || createId("screen"),
      order: screenIndex + 1
    };
    previousBody = `${updatedScreen?.bodyLong || ""}`;
    reportProgress(hooks, 60, "critic", `Validated M${moduleIndex + 1} S${sectionIndex + 1} C${scoIndex + 1} P${screenIndex + 1}`);
  }
}
