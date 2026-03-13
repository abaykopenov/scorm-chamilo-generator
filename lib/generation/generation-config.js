// ---------------------------------------------------------------------------
// lib/generation/generation-config.js — LLM generation configuration helpers
// ---------------------------------------------------------------------------

export function isTruthy(value, fallback = false) {
  const source = `${value ?? ""}`.trim().toLowerCase();
  if (!source) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(source);
}

export function allowBatchDownsize() {
  return isTruthy(process.env.LLM_ALLOW_BATCH_DOWNSIZE, false);
}

export function isLlmTimeoutErrorMessage(message) {
  return /timeout|aborted|timed out/i.test(`${message || ""}`);
}

export function isLlmTransientConnectivityErrorMessage(message) {
  return /endpoint is unreachable|fetch failed|network error|econnreset|socket hang up|status 5\d\d/i.test(`${message || ""}`);
}

export function getStructureSize(input) {
  const moduleCount = Math.max(1, Math.trunc(Number(input?.structure?.moduleCount) || 1));
  const sectionsPerModule = Math.max(1, Math.trunc(Number(input?.structure?.sectionsPerModule) || 1));
  const scosPerSection = Math.max(1, Math.trunc(Number(input?.structure?.scosPerSection) || 1));
  const screensPerSco = Math.max(1, Math.trunc(Number(input?.structure?.screensPerSco) || 1));
  const screensPerModule = sectionsPerModule * scosPerSection * screensPerSco;
  const totalScreens = moduleCount * screensPerModule;

  return { moduleCount, sectionsPerModule, scosPerSection, screensPerSco, screensPerModule, totalScreens };
}

export function isLikelyLargeModel(modelName) {
  return /(?:^|[^\d])(3\d|4\d|5\d|6\d|7\d|8\d|9\d|1\d{2,3})b(?:$|[^\d])/i.test(`${modelName || ""}`);
}

export function shouldPreferSegmentedGeneration(input) {
  const force = `${process.env.LLM_FORCE_SEGMENTED_GENERATION || ""}`.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(force)) {
    return true;
  }

  const size = getStructureSize(input);
  const moduleThresholdRaw = Number(process.env.LLM_SEGMENTED_MODULE_THRESHOLD);
  const totalScreensThresholdRaw = Number(process.env.LLM_SEGMENTED_TOTAL_SCREENS_THRESHOLD);
  const screensPerModuleThresholdRaw = Number(process.env.LLM_SEGMENTED_SCREENS_PER_MODULE_THRESHOLD);

  const moduleThreshold = Number.isFinite(moduleThresholdRaw) && moduleThresholdRaw > 0
    ? Math.trunc(moduleThresholdRaw) : 6;
  const totalScreensThreshold = Number.isFinite(totalScreensThresholdRaw) && totalScreensThresholdRaw > 0
    ? Math.trunc(totalScreensThresholdRaw) : 48;
  const screensPerModuleThreshold = Number.isFinite(screensPerModuleThresholdRaw) && screensPerModuleThresholdRaw > 0
    ? Math.trunc(screensPerModuleThresholdRaw) : 10;

  const largeModelPenalty = isLikelyLargeModel(input?.generation?.model) ? 0.75 : 1;
  const provider = `${input?.generation?.provider || ""}`.trim().toLowerCase();
  const ollamaScreensRaw = Number(process.env.LLM_SEGMENTED_OLLAMA_TOTAL_SCREENS_THRESHOLD);
  const ollamaScreensThreshold = Number.isFinite(ollamaScreensRaw) && ollamaScreensRaw > 0
    ? Math.trunc(ollamaScreensRaw) : 18;
  const ollamaPrefer = provider === "ollama" && size.totalScreens >= ollamaScreensThreshold;

  return ollamaPrefer
    || size.moduleCount >= Math.max(2, Math.floor(moduleThreshold * largeModelPenalty))
    || size.totalScreens >= Math.max(12, Math.floor(totalScreensThreshold * largeModelPenalty))
    || size.screensPerModule >= Math.max(4, Math.floor(screensPerModuleThreshold * largeModelPenalty));
}

export function estimateMainOutlinePayloadSize(input, ragContext) {
  const chunks = Array.isArray(ragContext?.chunks) ? ragContext.chunks : [];
  const screenPlanHints = Array.isArray(ragContext?.screenPlanHints) ? ragContext.screenPlanHints : [];
  const goalsText = Array.isArray(input?.learningGoals) ? input.learningGoals.join(" ") : "";

  const chunkChars = chunks.reduce((sum, chunk) => {
    return sum + `${chunk?.text || ""}`.length + `${chunk?.fileName || chunk?.sourceName || ""}`.length + 40;
  }, 0);

  const hintsChars = screenPlanHints.reduce((sum, hint) => {
    return sum + `${hint?.objective || ""}`.length + (Array.isArray(hint?.keyFacts) ? hint.keyFacts.join(" ") : "").length + 20;
  }, 0);

  const metadataChars = `${input?.titleHint || ""}`.length + `${input?.audience || ""}`.length + goalsText.length + 1200;
  return chunkChars + hintsChars + metadataChars;
}

export function shouldSkipMainOutlineAttempt(input, ragContext) {
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
    ? Math.trunc(payloadThresholdRaw) : 10_000;

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

export function createRagContextSlice(ragContext, batchIndex, totalBatches) {
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

export function createStructuredGenerationConfig(generation, defaults = {}) {
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

  return { ...(generation || {}), temperature: normalized };
}

export function createBatchFinalTestConfig(input) {
  return {
    enabled: false,
    questionCount: 0,
    passingScore: Number(input?.finalTest?.passingScore) || 70,
    attemptsLimit: 1,
    maxTimeMinutes: Math.max(1, Math.min(30, Number(input?.finalTest?.maxTimeMinutes) || 20))
  };
}

export async function quickLlmReachabilityProbe(config) {
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
      return { ok: false, message: `LLM endpoint pre-check failed with status ${response.status} (${url}).` };
    }
    return { ok: true, message: "" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown network error";
    return { ok: false, message: `LLM endpoint is unreachable: ${url}. ${reason}` };
  }
}

export function shouldUseTwoPhaseGeneration(input, isDeepV4Mode) {
  if (typeof isDeepV4Mode === "function" ? isDeepV4Mode(input) : isDeepV4Mode) {
    return true;
  }
  const forced = `${process.env.LLM_TWO_PHASE_GENERATION || "1"}`.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(forced)) {
    return false;
  }
  const size = getStructureSize(input);
  return size.totalScreens >= 12 || size.screensPerSco >= 4;
}

export function getScreensPerBatchTarget() {
  const requested = Number(process.env.LLM_SCREEN_BATCH_MAX);
  const maxValue = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 5;
  return Math.max(1, Math.min(5, maxValue));
}

export function getSegmentConcurrency() {
  const configured = Number(process.env.LLM_SEGMENT_CONCURRENCY);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(6, Math.trunc(configured)));
}

export function isReducibleBatchError(error) {
  const message = `${error instanceof Error ? error.message : error || ""}`.toLowerCase();
  return /timeout|aborted|unreachable|fetch failed|network|expected-screens|no-modules|valid json|outline payload is empty|status 5\d\d/.test(message);
}

export async function runWithConcurrency(items, limit, worker) {
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

export function mergeUniqueRagChunks(chunks) {
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

export function attachRagMetadata(course, input, ragContext) {
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
