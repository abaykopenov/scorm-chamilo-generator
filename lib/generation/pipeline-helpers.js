import { screenSlotId, getPlanSlotFacts } from "../generation-planner.js";
import { 
  firstSentence, 
  jaccardSimilarity, 
  rotateList, 
  screenTextValue, 
  textKey, 
  toBulletItems 
} from "../course-utils.js";
import { createId } from "../ids.js";

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

export function cleanEvidenceText(value) {
  return `${value || ""}`
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\uFFFD/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksNoisyEvidence(value) {
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

export function hasBadFormatting(value) {
  const text = `${value || ""}`;
  if (!text) return false;
  // LLM hallucination: random spaces between letters e.g., "с л о в о" or "t e x t"
  if (/(?:\b|\s)(?:\p{L}\s){3,}\p{L}(?:\b|\s)/u.test(text)) {
    return true;
  }
  // LLM hallucination: excessive repeated special characters or math/currency symbols
  if (/(\p{So}|\p{Sc}|\p{Sm}){5,}/u.test(text) || /[<>{}~`\\]{5,}/.test(text)) {
    return true;
  }
  // Random Chinese/Japanese/Korean character bursts in European language text if unintended
  // If the language is RU/EN, detecting huge block of CJK characters is a sign of major hallucination
  const cjkTokens = (text.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  if(cjkTokens > 15) {
     return true;
  }
  return false;
}

export function buildEvidencePack(plan, moduleIndex, sectionIndex, scoIndex, screenIndex) {
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

export function evidencePackToRagContext(baseRagContext, evidencePack, slotLabel, objective) {
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

export function collectScreenBodyText(screen) {
  const blocks = Array.isArray(screen?.blocks) ? screen.blocks : [];
  return blocks
    .filter((block) => block?.type === "text" || block?.type === "note")
    .map((block) => `${block?.text || ""}`.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function collectKeyTakeaways(screen, evidencePack) {
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

export function ensureLongBody(text, evidencePack, title, minChars) {
  const intro = cleanEvidenceText(text);
  // Build padding from evidence excerpts only — no labels, no meta-commentary
  const excerpts = (Array.isArray(evidencePack) ? evidencePack : [])
    .map((item) => cleanEvidenceText(item.excerpt))
    .filter(Boolean);

  let body = intro;

  // If text is below minimum, pad with clean excerpts (no "Evidence N (file):" prefix)
  let padIndex = 0;
  while (body.length < minChars && excerpts.length > 0) {
    body = `${body} ${excerpts[padIndex % excerpts.length]}`.trim();
    padIndex += 1;
    if (padIndex >= excerpts.length * 2) {
      break; // prevent infinite loop
    }
  }

  return body.replace(/\s+/g, " ").trim();
}

export function hasEvidenceGrounding(body, evidencePack) {
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

export function evaluateDeepScreenQuality({ bodyLong, evidencePack, previousBody, minChars }) {
  const text = `${bodyLong || ""}`.trim();
  if (text.length < minChars) {
    return { ok: false, reason: "too-short" };
  }
  if (looksNoisyEvidence(text)) {
    return { ok: false, reason: "noise" };
  }
  if (hasBadFormatting(text)) {
    return { ok: false, reason: "bad-formatting" };
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
    },
    {
      type: "list",
      items: keyTakeaways.length > 0 ? keyTakeaways : [
        "Identify the key rule",
        "Check applicability in a real case",
        "Document the execution result"
      ]
    }
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

export function flattenScreens(modules) {
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

export function computeCourseQualityMetrics(course) {
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

  return {
    moduleCount,
    sectionsPerModule,
    scosPerSection,
    screensPerSco,
    screensPerModule,
    totalScreens
  };
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

export function estimateMainOutlinePayloadSize(input, ragContext) {
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

  return {
    ...(generation || {}),
    temperature: normalized
  };
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

export function shouldUseTwoPhaseGeneration(input) {
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

export function getScreensPerBatchTarget(input) {
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

export function containsTemplatePlaceholders(course) {
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
