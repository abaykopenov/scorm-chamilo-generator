export const LIMITS = {
  moduleCount: { min: 1, max: 20, default: 3 },
  sectionsPerModule: { min: 1, max: 20, default: 2 },
  scosPerSection: { min: 1, max: 20, default: 2 },
  screensPerSco: { min: 1, max: 20, default: 3 },
  questionCount: { min: 0, max: 100, default: 8 },
  passingScore: { min: 0, max: 100, default: 80 },
  attemptsLimit: { min: 1, max: 20, default: 1 },
  maxTimeMinutes: { min: 1, max: 300, default: 30 },
  ragTopK: { min: 1, max: 30, default: 6 }
};

export const DEFAULT_LANGUAGE = "ru";

export function createDefaultGenerationSettings() {
  return {
    provider: "template",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5:14b",
    temperature: 0.2
  };
}

export function createDefaultRagSettings() {
  return {
    enabled: true,
    topK: LIMITS.ragTopK.default,
    documentIds: [],
    embedding: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text"
    }
  };
}

export function createDefaultChamiloSettings() {
  return {
    name: "My Chamilo",
    baseUrl: "",
    username: "",
    courseCode: "",
    uploadPagePath: "/main/newscorm/lp_controller.php?action=upload",
    loginPath: "/index.php",
    lastConnectionStatus: "unknown",
    lastConnectionMessage: "",
    lastConnectedAt: ""
  };
}

export function createDefaultGenerateInput() {
  const generation = createDefaultGenerationSettings();
  const rag = createDefaultRagSettings();

  return {
    titleHint: "Введение в корпоративное обучение",
    audience: "Новые сотрудники",
    learningGoals: [
      "Понять ключевые процессы",
      "Освоить базовые правила",
      "Уметь применить знания на практике"
    ],
    durationMinutes: 45,
    language: DEFAULT_LANGUAGE,
    structure: {
      moduleCount: LIMITS.moduleCount.default,
      sectionsPerModule: LIMITS.sectionsPerModule.default,
      scosPerSection: LIMITS.scosPerSection.default,
      screensPerSco: LIMITS.screensPerSco.default
    },
    finalTest: {
      enabled: true,
      questionCount: LIMITS.questionCount.default,
      passingScore: LIMITS.passingScore.default,
      attemptsLimit: LIMITS.attemptsLimit.default,
      maxTimeMinutes: LIMITS.maxTimeMinutes.default
    },
    generation,
    rag: {
      ...rag,
      embedding: {
        ...rag.embedding,
        provider: generation.provider === "template" ? rag.embedding.provider : generation.provider,
        baseUrl: generation.baseUrl || rag.embedding.baseUrl
      }
    }
  };
}

export function createBlankCoursePayload() {
  const defaults = createDefaultGenerateInput();
  return {
    title: defaults.titleHint,
    description: "Черновик курса. Настройте структуру и экспортируйте пакет SCORM 1.2.",
    language: defaults.language,
    structure: defaults.structure,
    finalTest: defaults.finalTest,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    }
  };
}
