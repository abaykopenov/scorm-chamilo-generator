import { generateCourseDraft } from "./course-generator.js";
import { postprocessGeneratedCourse } from "./course-postprocess.js";

function deepClone(value) {
  return structuredClone(value);
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.trunc(parsed);
}

export function deriveStructureFromCourse(course) {
  const modules = Array.isArray(course?.modules) ? course.modules : [];
  const moduleCount = Math.max(1, modules.length || 1);
  const sectionsPerModule = Math.max(1, ...modules.map((moduleItem) => Array.isArray(moduleItem?.sections) ? moduleItem.sections.length : 0), 1);

  const allSections = modules.flatMap((moduleItem) => Array.isArray(moduleItem?.sections) ? moduleItem.sections : []);
  const scosPerSection = Math.max(1, ...allSections.map((sectionItem) => Array.isArray(sectionItem?.scos) ? sectionItem.scos.length : 0), 1);

  const allScos = allSections.flatMap((sectionItem) => Array.isArray(sectionItem?.scos) ? sectionItem.scos : []);
  const screensPerSco = Math.max(1, ...allScos.map((sco) => Array.isArray(sco?.screens) ? sco.screens.length : 0), 1);

  return {
    moduleCount,
    sectionsPerModule,
    scosPerSection,
    screensPerSco
  };
}

function deriveFinalTestFromCourse(course) {
  return {
    enabled: Boolean(course?.finalTest?.enabled ?? true),
    questionCount: toPositiveInt(course?.finalTest?.questionCount, 8),
    passingScore: toPositiveInt(course?.finalTest?.passingScore, 70),
    attemptsLimit: toPositiveInt(course?.finalTest?.attemptsLimit, 1),
    maxTimeMinutes: toPositiveInt(course?.finalTest?.maxTimeMinutes, 20)
  };
}

export function deriveGenerationInputFromCourse(course) {
  const source = course?.generationInput || {};
  const sourceDocumentIds = Array.isArray(course?.sourceDocuments)
    ? course.sourceDocuments.map((item) => `${item?.id || ""}`.trim()).filter(Boolean)
    : [];

  const titleHint = `${source?.titleHint || course?.title || "Course"}`.trim() || "Course";
  const audience = `${source?.audience || "Learners"}`.trim() || "Learners";
  const learningGoals = Array.isArray(source?.learningGoals) && source.learningGoals.length > 0
    ? source.learningGoals
    : (Array.isArray(course?.modules) ? course.modules.map((moduleItem) => `${moduleItem?.title || ""}`.trim()).filter(Boolean).slice(0, 12) : []);

  const generation = {
    provider: source?.generation?.provider || course?.generation?.provider || "template",
    baseUrl: source?.generation?.baseUrl || course?.generation?.baseUrl || "http://127.0.0.1:11434",
    model: source?.generation?.model || course?.generation?.model || "qwen2.5:7b",
    temperature: Number(source?.generation?.temperature || course?.generation?.temperature || 0.2)
  };

  const rag = {
    enabled: Boolean(source?.rag?.enabled ?? course?.rag?.enabled ?? false),
    topK: toPositiveInt(source?.rag?.topK || course?.rag?.topK, 6),
    documentIds: Array.isArray(source?.rag?.documentIds) && source.rag.documentIds.length > 0
      ? source.rag.documentIds
      : sourceDocumentIds,
    embedding: {
      provider: source?.rag?.embedding?.provider || course?.rag?.embedding?.provider || "ollama",
      baseUrl: source?.rag?.embedding?.baseUrl || course?.rag?.embedding?.baseUrl || "http://127.0.0.1:11434",
      model: source?.rag?.embedding?.model || course?.rag?.embedding?.model || "nomic-embed-text"
    }
  };

  return {
    titleHint,
    audience,
    learningGoals: learningGoals.length > 0 ? learningGoals : [titleHint],
    durationMinutes: toPositiveInt(source?.durationMinutes, 60),
    language: source?.language || course?.language || "ru",
    structure: source?.structure || deriveStructureFromCourse(course),
    finalTest: source?.finalTest || deriveFinalTestFromCourse(course),
    generation,
    rag
  };
}

function deriveModuleStructure(moduleItem) {
  const sections = Array.isArray(moduleItem?.sections) ? moduleItem.sections : [];
  const sectionsPerModule = Math.max(1, sections.length || 1);
  const scosPerSection = Math.max(1, ...sections.map((sectionItem) => Array.isArray(sectionItem?.scos) ? sectionItem.scos.length : 0), 1);
  const allScos = sections.flatMap((sectionItem) => Array.isArray(sectionItem?.scos) ? sectionItem.scos : []);
  const screensPerSco = Math.max(1, ...allScos.map((sco) => Array.isArray(sco?.screens) ? sco.screens.length : 0), 1);

  return {
    moduleCount: 1,
    sectionsPerModule,
    scosPerSection,
    screensPerSco
  };
}

function normalizeCourseAfterRegeneration(updatedCourse, baseInput) {
  const structure = deriveStructureFromCourse(updatedCourse);
  const finalTest = deriveFinalTestFromCourse(updatedCourse);
  const normalizationInput = {
    ...baseInput,
    structure,
    finalTest
  };

  const normalized = postprocessGeneratedCourse(updatedCourse, normalizationInput);
  return {
    ...normalized,
    generationInput: {
      ...baseInput,
      structure,
      finalTest
    },
    generationStatus: "completed",
    completedModules: Array.isArray(normalized?.modules) ? normalized.modules.length : 0
  };
}

export async function regenerateModuleInCourse(course, moduleIndex) {
  const modules = Array.isArray(course?.modules) ? course.modules : [];
  if (moduleIndex < 0 || moduleIndex >= modules.length) {
    throw new Error("Module index is out of range.");
  }

  const targetModule = modules[moduleIndex];
  const baseInput = deriveGenerationInputFromCourse(course);
  const moduleInput = {
    ...baseInput,
    titleHint: `${targetModule?.title || baseInput.titleHint}`.trim() || baseInput.titleHint,
    learningGoals: [
      `${targetModule?.title || ""}`.trim(),
      ...baseInput.learningGoals
    ].filter(Boolean).slice(0, 12),
    structure: deriveModuleStructure(targetModule),
    finalTest: {
      ...baseInput.finalTest,
      enabled: false,
      questionCount: 1
    }
  };

  const generated = await generateCourseDraft(moduleInput);
  const generatedModule = generated?.modules?.[0];
  if (!generatedModule) {
    throw new Error("Failed to regenerate module.");
  }

  const updatedCourse = deepClone(course);
  generatedModule.id = updatedCourse.modules[moduleIndex]?.id || generatedModule.id;
  generatedModule.order = moduleIndex + 1;
  updatedCourse.modules[moduleIndex] = generatedModule;

  return normalizeCourseAfterRegeneration(updatedCourse, baseInput);
}

export async function regenerateScreenInCourse(course, position) {
  const moduleIndex = Number(position?.moduleIndex);
  const sectionIndex = Number(position?.sectionIndex);
  const scoIndex = Number(position?.scoIndex);
  const screenIndex = Number(position?.screenIndex);

  const moduleItem = course?.modules?.[moduleIndex];
  const sectionItem = moduleItem?.sections?.[sectionIndex];
  const scoItem = sectionItem?.scos?.[scoIndex];
  const screenItem = scoItem?.screens?.[screenIndex];

  if (!screenItem) {
    throw new Error("Screen position is out of range.");
  }

  const baseInput = deriveGenerationInputFromCourse(course);
  const screenInput = {
    ...baseInput,
    titleHint: `${screenItem?.title || scoItem?.title || baseInput.titleHint}`.trim() || baseInput.titleHint,
    learningGoals: [
      `${screenItem?.title || ""}`.trim(),
      `${scoItem?.title || ""}`.trim(),
      `${sectionItem?.title || ""}`.trim(),
      `${moduleItem?.title || ""}`.trim(),
      ...baseInput.learningGoals
    ].filter(Boolean).slice(0, 12),
    structure: {
      moduleCount: 1,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      ...baseInput.finalTest,
      enabled: false,
      questionCount: 1
    }
  };

  const generated = await generateCourseDraft(screenInput);
  const generatedScreen = generated?.modules?.[0]?.sections?.[0]?.scos?.[0]?.screens?.[0];
  if (!generatedScreen) {
    throw new Error("Failed to regenerate screen.");
  }

  const updatedCourse = deepClone(course);
  generatedScreen.id = updatedCourse.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].screens[screenIndex].id || generatedScreen.id;
  generatedScreen.order = screenIndex + 1;
  updatedCourse.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].screens[screenIndex] = generatedScreen;

  return normalizeCourseAfterRegeneration(updatedCourse, baseInput);
}
