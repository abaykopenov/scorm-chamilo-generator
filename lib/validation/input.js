import { 
  DEFAULT_LANGUAGE, 
  LIMITS,
  createDefaultChamiloSettings,
  createDefaultGenerateInput,
  createDefaultGenerationSettings,
  createDefaultRagSettings
} from "../course-defaults.js";
import { clampNumber, toText, toTextArray } from "./shared.js";

export function normalizeContentDepthMode(value, fallback = "deep") {
  const mode = `${value || ""}`.trim().toLowerCase();
  if (["deep", "balanced", "short"].includes(mode)) {
    return mode;
  }
  return fallback;
}

export function normalizeAgentTopology(value, fallback = "v4") {
  const topology = `${value || ""}`.trim().toLowerCase();
  return topology === "v4" ? "v4" : fallback;
}

export function normalizeEvidenceMode(value, fallback = "per-screen") {
  const mode = `${value || ""}`.trim().toLowerCase();
  return mode === "per-screen" ? mode : fallback;
}

export function normalizeGenerationDefaults(value, fallback = {}) {
  const source = value ?? {};
  const fallbackCount = Number(fallback?.moduleCountDefault);
  const defaultModuleCount = Number.isFinite(fallbackCount) && fallbackCount > 0
    ? Math.trunc(fallbackCount)
    : 2;

  const requested = Number(source.moduleCountDefault);
  return {
    moduleCountDefault: Number.isFinite(requested) && requested > 0
      ? Math.max(LIMITS.moduleCount.min, Math.min(LIMITS.moduleCount.max, Math.trunc(requested)))
      : defaultModuleCount
  };
}

export function normalizeStructureSettings(value) {
  const source = value ?? {};
  return {
    moduleCount: clampNumber(source.moduleCount, LIMITS.moduleCount),
    sectionsPerModule: clampNumber(source.sectionsPerModule, LIMITS.sectionsPerModule),
    scosPerSection: clampNumber(source.scosPerSection, LIMITS.scosPerSection),
    screensPerSco: clampNumber(source.screensPerSco, LIMITS.screensPerSco)
  };
}

export function normalizeFinalTestSettings(value) {
  const source = value ?? {};
  return {
    enabled: Boolean(source.enabled ?? true),
    questionCount: clampNumber(source.questionCount, LIMITS.questionCount),
    passingScore: clampNumber(source.passingScore, LIMITS.passingScore),
    attemptsLimit: clampNumber(source.attemptsLimit, LIMITS.attemptsLimit),
    maxTimeMinutes: clampNumber(source.maxTimeMinutes, LIMITS.maxTimeMinutes)
  };
}

export function normalizeGenerationSettings(value) {
  const defaults = createDefaultGenerationSettings();
  const source = value ?? {};
  const provider = ["template", "ollama", "openai-compatible"].includes(source.provider)
    ? source.provider
    : defaults.provider;

  return {
    provider,
    baseUrl: toText(source.baseUrl, defaults.baseUrl) || defaults.baseUrl,
    model: toText(source.model, defaults.model) || defaults.model,
    temperature: Math.max(0, Math.min(1, Number(source.temperature) || defaults.temperature))
  };
}

export function normalizeEmbeddingSettings(value, fallback = null) {
  const fallbackDefaults = fallback || createDefaultRagSettings().embedding;
  const source = value ?? {};
  const provider = ["ollama", "openai-compatible"].includes(source.provider)
    ? source.provider
    : fallbackDefaults.provider;

  return {
    provider,
    baseUrl: toText(source.baseUrl, fallbackDefaults.baseUrl) || fallbackDefaults.baseUrl,
    model: toText(source.model, fallbackDefaults.model) || fallbackDefaults.model
  };
}

export function normalizeRagSettings(value, generation = null) {
  const defaults = createDefaultRagSettings();
  const source = value ?? {};
  const baseEmbedding = normalizeEmbeddingSettings(
    source.embedding,
    {
      ...defaults.embedding,
      provider: generation?.provider && generation.provider !== "template" ? generation.provider : defaults.embedding.provider,
      baseUrl: generation?.baseUrl || defaults.embedding.baseUrl
    }
  );

  return {
    enabled: source.enabled == null ? defaults.enabled : Boolean(source.enabled),
    topK: clampNumber(source.topK, LIMITS.ragTopK),
    documentIds: toTextArray(source.documentIds, []),
    embedding: baseEmbedding
  };
}

export function normalizeChamiloSettings(value) {
  const defaults = createDefaultChamiloSettings();
  const source = value ?? {};
  return {
    name: toText(source.name, defaults.name) || defaults.name,
    baseUrl: toText(source.baseUrl, defaults.baseUrl),
    username: toText(source.username, defaults.username),
    courseCode: toText(source.courseCode, defaults.courseCode),
    uploadPagePath: toText(source.uploadPagePath, defaults.uploadPagePath) || defaults.uploadPagePath,
    loginPath: toText(source.loginPath, defaults.loginPath) || defaults.loginPath,
    lastConnectionStatus: ["unknown", "connected", "failed"].includes(source.lastConnectionStatus)
      ? source.lastConnectionStatus
      : defaults.lastConnectionStatus,
    lastConnectionMessage: toText(source.lastConnectionMessage, defaults.lastConnectionMessage),
    lastConnectedAt: toText(source.lastConnectedAt, defaults.lastConnectedAt)
  };
}

export function normalizeGenerateInput(payload) {
  const defaults = createDefaultGenerateInput();
  const generation = normalizeGenerationSettings(payload?.generation);
  const contentDepthMode = normalizeContentDepthMode(payload?.contentDepthMode, defaults.contentDepthMode);
  const agentTopology = normalizeAgentTopology(payload?.agentTopology, defaults.agentTopology);
  const evidenceMode = normalizeEvidenceMode(payload?.evidenceMode, defaults.evidenceMode);
  const generationDefaults = normalizeGenerationDefaults(payload?.generationDefaults, defaults.generationDefaults);
  const structure = normalizeStructureSettings(payload?.structure);
  const moduleCountProvided = payload?.structure && payload.structure.moduleCount != null;

  if (contentDepthMode === "deep" && !moduleCountProvided) {
    structure.moduleCount = Math.max(
      LIMITS.moduleCount.min,
      Math.min(LIMITS.moduleCount.max, Math.trunc(Number(generationDefaults.moduleCountDefault) || 2))
    );
  }

  const finalTest = normalizeFinalTestSettings(payload?.finalTest);
  if (finalTest.enabled && finalTest.questionCount < 1) {
    finalTest.questionCount = 1;
  }

  return {
    titleHint: toText(payload?.titleHint, defaults.titleHint) || defaults.titleHint,
    audience: toText(payload?.audience, defaults.audience) || defaults.audience,
    learningGoals: toTextArray(payload?.learningGoals, defaults.learningGoals),
    durationMinutes: Math.max(5, Math.trunc(Number(payload?.durationMinutes) || defaults.durationMinutes)),
    language: payload?.language === "en" ? "en" : DEFAULT_LANGUAGE,
    contentDepthMode,
    agentTopology,
    evidenceMode,
    generationDefaults,
    structure,
    finalTest,
    generation,
    rag: normalizeRagSettings(payload?.rag, generation)
  };
}
