import { createOutlineFromLocalLlm, buildCourseFromOutline } from "../local-llm.js";
import { buildRagContext } from "../rag-service.js";
import { createId } from "../ids.js";
import { createPlannerScopedRagContext } from "../generation-planner.js";
import { 
  getStructureSize, 
  createStructuredGenerationConfig, 
  createBatchFinalTestConfig,
  reportProgress,
  isReducibleBatchError,
  allowBatchDownsize,
  runWithConcurrency,
  getSegmentConcurrency,
  getScreensPerBatchTarget,
  shouldUseTwoPhaseGeneration,
  isTruthy,
  mergeUniqueRagChunks
} from "./pipeline-helpers.js";
import { applyPhaseBPlannerFillToSco, applyV4PipelineToSco } from "./v4-pipeline.js";
import { buildTemplateDraft, pickGoal } from "./template-draft.js";

export async function generateScoPayloadInAdaptiveBatches({
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

  const { isDeepV4Mode } = await import("./pipeline-helpers.js");

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
  } else if (isDeepV4Mode(input) && plannerPlan) {
    await applyV4PipelineToSco({
      scoPayload: finalScoPayload,
      moduleIndex,
      sectionIndex,
      scoIndex,
      input,
      ragContext,
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

export async function generateCourseByBatchesWithReset(input, ragContext, plannerPlan, hooks = {}) {
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

  const { isDeepV4Mode } = await import("./pipeline-helpers.js");

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
        } else if (isDeepV4Mode(input) && plannerPlan) {
          for (let scoIndex = 0; scoIndex < (sectionPayload.scos || []).length; scoIndex += 1) {
            await applyV4PipelineToSco({
              scoPayload: sectionPayload.scos[scoIndex],
              moduleIndex,
              sectionIndex,
              scoIndex,
              input,
              ragContext,
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
    } else if (isDeepV4Mode(input) && plannerPlan) {
      for (let sectionIndex = 0; sectionIndex < (modulePayload.sections || []).length; sectionIndex += 1) {
        const section = modulePayload.sections[sectionIndex];
        for (let scoIndex = 0; scoIndex < (section.scos || []).length; scoIndex += 1) {
          await applyV4PipelineToSco({
            scoPayload: section.scos[scoIndex],
            moduleIndex,
            sectionIndex,
            scoIndex,
            input,
            ragContext,
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
      mode: generationMode,
      deepGenerated: isDeepV4Mode(input) && Boolean(plannerPlan)
    }
  };

  return course;
}

export async function enrichRagContextForPlanner(input, ragContext, hooks) {
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
