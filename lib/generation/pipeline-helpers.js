// ---------------------------------------------------------------------------
// lib/generation/pipeline-helpers.js — Re-export façade
// ---------------------------------------------------------------------------
// This file was split into focused sub-modules:
//   evidence-helpers.js   — evidence pack, noise detection, RAG context
//   quality-checks.js     — screen/course quality evaluation
//   generation-config.js  — LLM config, batch settings, concurrency
//
// All exports are re-exported here for backward compatibility.
// ---------------------------------------------------------------------------

import { firstSentence } from "../course-utils.js";

// ── Evidence helpers ─────────────────────────────────────────────────────
export {
  cleanEvidenceText,
  looksNoisyEvidence,
  looksGarbledText,
  buildEvidencePack,
  evidencePackToRagContext,
  ensureLongBody,
  hasEvidenceGrounding
} from "./evidence-helpers.js";

// ── Quality checks ───────────────────────────────────────────────────────
export {
  hasBadFormatting,
  evaluateDeepScreenQuality,
  collectScreenBodyText,
  flattenScreens,
  computeCourseQualityMetrics,
  containsTemplatePlaceholders
} from "./quality-checks.js";

// ── Generation config ────────────────────────────────────────────────────
export {
  isTruthy,
  allowBatchDownsize,
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
  mergeUniqueRagChunks,
  attachRagMetadata
} from "./generation-config.js";

// ── Local helpers (kept here — depend on multiple sub-modules) ───────────

export function reportProgress(hooks, percent, stage, message, metrics = null) {
  if (typeof hooks?.onProgress === "function") {
    hooks.onProgress(percent, stage, message, metrics && typeof metrics === "object" ? metrics : undefined);
  }
}

export function isStrictRagRequested(input) {
  return Boolean(
    input?.rag?.enabled &&
    Array.isArray(input?.rag?.documentIds) &&
    input.rag.documentIds.length > 0
  );
}

export function isDeepV4Mode(input) {
  const depth = `${input?.contentDepthMode || "deep"}`.trim().toLowerCase();
  const topology = `${input?.agentTopology || "v4"}`.trim().toLowerCase();
  return depth === "deep" && topology === "v4";
}

import { collectScreenBodyText } from "./quality-checks.js";
import { cleanEvidenceText, ensureLongBody } from "./evidence-helpers.js";

export function collectKeyTakeaways(screen, evidencePack) {
  const blocks = Array.isArray(screen?.blocks) ? screen.blocks : [];
  const listBlock = blocks.find((block) => block?.type === "list" && Array.isArray(block?.items));
  const fromList = Array.isArray(listBlock?.items)
    ? listBlock.items.map((item) => `${item || ""}`.trim()).filter(Boolean)
    : [];
  if (fromList.length >= 2) {
    return fromList.slice(0, 5);
  }
  return [];
}

export function buildScreenFromWriterResult({ baseScreen, writtenScreen, evidencePack, minChars, objective }) {
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
    }
  ];

  if (keyTakeaways.length > 0) {
    blocks.push({
      type: "list",
      items: keyTakeaways
    });
  }

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
