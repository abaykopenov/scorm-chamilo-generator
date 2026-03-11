import { buildRagContext } from "./rag-service.js";
import { postprocessGeneratedCourse } from "./course-postprocess.js";
import { normalizeGenerateInput } from "./validation.js";
import {
  createGenerationPlan,
  createPlannerScopedRagContext,
  validateGenerationPlanCoverage
} from "./generation-planner.js";
import {
  createOutlineFromLocalLlm,
  buildCourseFromOutline,
  createLinePlanFromLocalLlm
} from "./local-llm.js";

// Internal modules
import {
  reportProgress,
  isStrictRagRequested,
  isDeepV4Mode,
  isTruthy,
  attachRagMetadata,
  containsTemplatePlaceholders,
  evaluateLinePlanQuality,
  shouldPreferSegmentedGeneration,
  shouldSkipMainOutlineAttempt,
  quickLlmReachabilityProbe,
  isLlmTimeoutErrorMessage,
  isLlmTransientConnectivityErrorMessage,
  computeCourseQualityMetrics
} from "./generation/pipeline-helpers.js";

import {
  buildTemplateDraft
} from "./generation/template-draft.js";

import {
  buildCourseFromLinePlan,
  buildCourseFromRagChunks,
  applyPlannerQualityGate
} from "./generation/planner-builder.js";

import {
  runV4Pipeline,
  buildFinalTestFromScreens
} from "./generation/v4-pipeline.js";

import {
  generateCourseByBatchesWithReset,
  enrichRagContextForPlanner
} from "./generation/batch-generator.js";

// Re-exports for backward compatibility
export {
  pickGoal,
  buildBlocks,
  buildQuestion,
  buildTemplateDraft
} from "./generation/template-draft.js";

export {
  renderScreenFromFacts,
  applyPlannerQualityGate,
  buildCourseFromLinePlan,
  buildCourseFromRagChunks
} from "./generation/planner-builder.js";

export {
  reportProgress,
  isStrictRagRequested,
  isDeepV4Mode,
  allowBatchDownsize,
  cleanEvidenceText,
  looksNoisyEvidence,
  buildEvidencePack,
  evidencePackToRagContext,
  collectScreenBodyText,
  collectKeyTakeaways,
  ensureLongBody,
  hasEvidenceGrounding,
  evaluateDeepScreenQuality,
  buildScreenFromWriterResult,
  flattenScreens,
  computeCourseQualityMetrics,
  isLlmTimeoutErrorMessage,
  isLlmTransientConnectivityErrorMessage,
  getStructureSize,
  isLikelyLargeModel,
  shouldPreferSegmentedGeneration,
  estimateMainOutlinePayloadSize,
  shouldSkipMainOutlineAttempt,
  createRagContextSlice,
  createStructuredGenerationConfig,
  createBatchFinalTestConfig,
  quickLlmReachabilityProbe,
  shouldUseTwoPhaseGeneration,
  getScreensPerBatchTarget,
  getSegmentConcurrency,
  isReducibleBatchError,
  runWithConcurrency,
  attachRagMetadata,
  containsTemplatePlaceholders,
  mergeUniqueRagChunks
} from "./generation/pipeline-helpers.js";

export {
  writeAndCriticScreen,
  buildFinalTestFromScreens,
  runV4Pipeline,
  applyPhaseBPlannerFillToSco,
  applyV4PipelineToSco
} from "./generation/v4-pipeline.js";

export {
  generateScoPayloadInAdaptiveBatches,
  generateCourseByBatchesWithReset,
  enrichRagContextForPlanner
} from "./generation/batch-generator.js";

/**
 * Coordination logic for finalizing a course after any pipeline.
 */
async function finalizeGeneratedCourse(course, input, ragContext, plannerPlan = null, hooks = {}) {
  let prepared = course;

  if (isDeepV4Mode(input) && plannerPlan) {
    if (!course?.generation?.deepGenerated) {
      const deepResult = await runV4Pipeline(prepared, input, ragContext, plannerPlan, hooks);
      prepared = deepResult.course;
    } else {
      prepared.finalTest = await buildFinalTestFromScreens(prepared, input, hooks);
      const metrics = computeCourseQualityMetrics(prepared);
      reportProgress(hooks, 89, "test-builder", "Final test generated from approved screens", metrics);
    }
  } else if (plannerPlan) {
    prepared = applyPlannerQualityGate(prepared, input, plannerPlan, hooks);
  }

  const normalized = isDeepV4Mode(input)
    ? prepared
    : postprocessGeneratedCourse(prepared, input);
  return attachRagMetadata(normalized, input, ragContext);
}

/**
 * Main entry point for course generation.
 */
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
      const lpQuality = evaluateLinePlanQuality(linePlan);
      if (planCourse && !containsTemplatePlaceholders(planCourse) && lpQuality.ok) {
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
  const lpQuality = evaluateLinePlanQuality(linePlan);
  if (planCourse && !containsTemplatePlaceholders(planCourse) && lpQuality.ok) {
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

export async function generateCourseOutlineOnly(payload, hooks = {}) {
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

  reportProgress(hooks, 18, "outline", "Generating main outline");
  const outline = await createOutlineFromLocalLlm({
    ...input,
    ragContext: plannerGlobalRagContext
  }, {
    strict: true,
    trace: { stage: "main-outline-only" },
    validate: {
      expectedModules: input.structure.moduleCount,
      expectedSections: input.structure.sectionsPerModule,
      expectedScos: input.structure.scosPerSection,
      expectedScreens: input.structure.screensPerSco,
      maxPlaceholderRatio: 0.15,
      minAvgTextLength: 100,
      minUniqueRatio: 0.5
    }
  });

  return {
    outline,
    ragContext,
    plannerPlan
  };
}

export async function generateCourseContentFromOutline(payload, outline, ragContext, plannerPlan, hooks = {}) {
  const input = normalizeGenerateInput(payload);
  const course = buildCourseFromOutline(input, outline);
  
  if (!course) {
    throw new Error("Failed to build base course from the provided outline");
  }

  reportProgress(hooks, 20, "outline", "Outline structure approved by user");

  return await finalizeGeneratedCourse(course, input, ragContext, plannerPlan, hooks);
}
