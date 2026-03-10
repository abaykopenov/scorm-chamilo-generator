import { createId } from "./ids.js";
import {
  DEFAULT_LANGUAGE,
  LIMITS,
  createDefaultChamiloSettings,
  createDefaultGenerateInput,
  createDefaultGenerationSettings,
  createDefaultRagSettings
} from "./course-defaults.js";

function clampNumber(value, config) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return config.default;
  }
  return Math.min(config.max, Math.max(config.min, Math.trunc(parsed)));
}

function toText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function toTextArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => `${item}`.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/) 
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return fallback;
}

function normalizeContentDepthMode(value, fallback = "deep") {
  const mode = `${value || ""}`.trim().toLowerCase();
  if (["deep", "balanced", "short"].includes(mode)) {
    return mode;
  }
  return fallback;
}

function normalizeAgentTopology(value, fallback = "v4") {
  const topology = `${value || ""}`.trim().toLowerCase();
  if (topology === "v4") {
    return "v4";
  }
  return fallback;
}

function normalizeEvidenceMode(value, fallback = "per-screen") {
  const mode = `${value || ""}`.trim().toLowerCase();
  if (mode === "per-screen") {
    return mode;
  }
  return fallback;
}

function normalizeGenerationDefaults(value, fallback = {}) {
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

function normalizeBlocks(blocks, screenTitle) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [
      {
        type: "text",
        text: `Short instructional content for screen "${screenTitle}".`
      }
    ];
  }

  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }

      const type = ["text", "note", "list", "image"].includes(block.type) ? block.type : "text";

      if (type === "list") {
        const items = toTextArray(block.items, [`Screen content "${screenTitle}"`]);
        return { type, items };
      }

      if (type === "image") {
        return {
          type,
          src: toText(block.src, ""),
          alt: toText(block.alt, screenTitle)
        };
      }

      return {
        type,
        text: toText(block.text, `Short instructional content for screen "${screenTitle}".`)
      };
    })
    .filter(Boolean);
}

function normalizeQuestions(questions, desiredCount) {
  const normalized = Array.isArray(questions)
    ? questions.map((question, index) => ({
        id: question?.id || createId("question"),
        prompt: toText(question?.prompt, `Control question ${index + 1}`),
        options: Array.isArray(question?.options) && question.options.length > 0
          ? question.options.map((option, optionIndex) => ({
              id: option?.id || createId("option"),
              text: toText(option?.text, `Option ${optionIndex + 1}`)
            }))
          : Array.from({ length: 4 }, (_, optionIndex) => ({
              id: createId("option"),
              text: `Option ${optionIndex + 1}`
            })),
        correctOptionId: question?.correctOptionId,
        explanation: toText(question?.explanation, ""),
        screenRefs: toTextArray(question?.screenRefs, []).slice(0, 6)
      }))
    : [];

  while (normalized.length < desiredCount) {
    const questionId = createId("question");
    normalized.push({
      id: questionId,
      prompt: `Control question ${normalized.length + 1}`,
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        id: createId("option"),
        text: `Option ${optionIndex + 1}`
      })),
      correctOptionId: null,
      explanation: "",
      screenRefs: []
    });
  }

  normalized.length = desiredCount;

  return normalized.map((question) => {
    const fallbackCorrect = question.options[0]?.id ?? createId("option");
    return {
      ...question,
      correctOptionId: question.options.some((option) => option.id === question.correctOptionId)
        ? question.correctOptionId
        : fallbackCorrect,
      screenRefs: toTextArray(question.screenRefs, []).slice(0, 6)
    };
  });
}

function normalizeEvidenceEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      return {
        factId: toText(entry.factId, `fact_${index + 1}`) || `fact_${index + 1}`,
        source: toText(entry.source, "") || "source",
        materialId: toText(entry.materialId, ""),
        chunkId: toText(entry.chunkId, ""),
        excerpt: toText(entry.excerpt, "")
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeCoursePayload(payload) {
  const title = toText(payload?.title, "New course");
  const description = toText(payload?.description, "Course draft.");
  const language = payload?.language === "en" ? "en" : DEFAULT_LANGUAGE;
  const generation = normalizeGenerationSettings(payload?.generation);
  const rag = normalizeRagSettings(payload?.rag, generation);
  const contentDepthMode = normalizeContentDepthMode(payload?.contentDepthMode, "deep");
  const agentTopology = normalizeAgentTopology(payload?.agentTopology, "v4");
  const evidenceMode = normalizeEvidenceMode(payload?.evidenceMode, "per-screen");
  const generationDefaults = normalizeGenerationDefaults(payload?.generationDefaults, { moduleCountDefault: 2 });
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  const finalTestSource = payload?.finalTest ?? {};
  const finalTestSettings = normalizeFinalTestSettings({
    enabled: payload?.finalTest?.enabled ?? true,
    questionCount: payload?.finalTest?.questionCount ?? payload?.finalTest?.questions?.length ?? LIMITS.questionCount.default,
    passingScore: finalTestSource.passingScore,
    attemptsLimit: finalTestSource.attemptsLimit,
    maxTimeMinutes: finalTestSource.maxTimeMinutes
  });

  if (finalTestSettings.enabled && finalTestSettings.questionCount < 1) {
    finalTestSettings.questionCount = 1;
  }

  return {
    id: payload?.id || createId("course"),
    title,
    description,
    language,
    generation,
    contentDepthMode,
    agentTopology,
    evidenceMode,
    generationDefaults,
    rag,
    sourceDocuments: Array.isArray(payload?.sourceDocuments)
      ? payload.sourceDocuments.map((doc) => ({
          id: toText(doc?.id, ""),
          fileName: toText(doc?.fileName, ""),
          status: toText(doc?.status, "")
        })).filter((doc) => doc.id)
      : [],
    integrations: {
      chamilo: normalizeChamiloSettings(payload?.integrations?.chamilo)
    },
    modules: modules.map((moduleItem, moduleIndex) => ({
      id: moduleItem?.id || createId("module"),
      title: toText(moduleItem?.title, `Module ${moduleIndex + 1}`),
      order: moduleIndex + 1,
      sections: (Array.isArray(moduleItem?.sections) ? moduleItem.sections : []).map((sectionItem, sectionIndex) => ({
        id: sectionItem?.id || createId("section"),
        title: toText(sectionItem?.title, `Section ${moduleIndex + 1}.${sectionIndex + 1}`),
        order: sectionIndex + 1,
        scos: (Array.isArray(sectionItem?.scos) ? sectionItem.scos : []).map((scoItem, scoIndex) => ({
          id: scoItem?.id || createId("sco"),
          title: toText(scoItem?.title, `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`),
          order: scoIndex + 1,
          masteryScore: scoItem?.masteryScore != null ? clampNumber(scoItem.masteryScore, LIMITS.passingScore) : undefined,
          maxTimeMinutes: scoItem?.maxTimeMinutes != null ? clampNumber(scoItem.maxTimeMinutes, LIMITS.maxTimeMinutes) : undefined,
          screens: (Array.isArray(scoItem?.screens) ? scoItem.screens : []).map((screenItem, screenIndex) => {
            const titleValue = toText(screenItem?.title, `Screen ${screenIndex + 1}`);
            return {
              id: screenItem?.id || createId("screen"),
              title: titleValue,
              order: screenIndex + 1,
              bodyLong: toText(screenItem?.bodyLong, ""),
              keyTakeaways: toTextArray(screenItem?.keyTakeaways, []).slice(0, 5),
              practicalStep: toText(screenItem?.practicalStep, ""),
              evidence: normalizeEvidenceEntries(screenItem?.evidence),
              blocks: normalizeBlocks(screenItem?.blocks, titleValue)
            };
          })
        }))
      }))
    })),
    finalTest: {
      id: payload?.finalTest?.id || createId("final_test"),
      enabled: finalTestSettings.enabled,
      title: toText(payload?.finalTest?.title, "Final test"),
      questionCount: finalTestSettings.questionCount,
      passingScore: finalTestSettings.passingScore,
      attemptsLimit: finalTestSettings.attemptsLimit,
      maxTimeMinutes: finalTestSettings.maxTimeMinutes,
      questions: normalizeQuestions(payload?.finalTest?.questions, finalTestSettings.questionCount)
    }
  };
}