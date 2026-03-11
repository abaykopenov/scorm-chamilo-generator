import { useState } from "react";
import { toSafeNumber, serializeGoals, parseGoals } from "../utils";

export function useCourseForm(defaults) {
  const [form, setForm] = useState({
    titleHint: defaults.titleHint,
    audience: defaults.audience,
    learningGoals: serializeGoals(defaults.learningGoals),
    durationMinutes: defaults.durationMinutes,
    language: defaults.language,
    moduleCount: defaults.structure.moduleCount,
    sectionsPerModule: defaults.structure.sectionsPerModule,
    scosPerSection: defaults.structure.scosPerSection,
    screensPerSco: defaults.structure.screensPerSco,
    finalTestEnabled: defaults.finalTest.enabled,
    questionCount: defaults.finalTest.questionCount,
    passingScore: defaults.finalTest.passingScore,
    attemptsLimit: defaults.finalTest.attemptsLimit,
    maxTimeMinutes: defaults.finalTest.maxTimeMinutes,
    generationProvider: defaults.generation.provider,
    generationBaseUrl: defaults.generation.baseUrl,
    generationModel: defaults.generation.model,
    generationTemperature: defaults.generation.temperature,
    ragEnabled: defaults.rag.enabled,
    ragTopK: defaults.rag.topK,
    embeddingProvider: defaults.rag.embedding.provider,
    embeddingBaseUrl: defaults.rag.embedding.baseUrl,
    embeddingModel: defaults.rag.embedding.model
  });

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function getGenerationPayload(selectedMaterialIds) {
    return {
      titleHint: form.titleHint,
      audience: form.audience,
      learningGoals: parseGoals(form.learningGoals),
      durationMinutes: Number(form.durationMinutes),
      language: form.language,
      structure: {
        moduleCount: Number(form.moduleCount),
        sectionsPerModule: Number(form.sectionsPerModule),
        scosPerSection: Number(form.scosPerSection),
        screensPerSco: Number(form.screensPerSco)
      },
      finalTest: {
        enabled: Boolean(form.finalTestEnabled),
        questionCount: Number(form.questionCount),
        passingScore: Number(form.passingScore),
        attemptsLimit: Number(form.attemptsLimit),
        maxTimeMinutes: Number(form.maxTimeMinutes)
      },
      generation: {
        provider: form.generationProvider,
        baseUrl: form.generationBaseUrl,
        model: form.generationModel,
        temperature: toSafeNumber(form.generationTemperature, defaults.generation.temperature, 0, 1)
      },
      rag: {
        enabled: Boolean(form.ragEnabled),
        topK: toSafeNumber(form.ragTopK, defaults.rag.topK, 1, 30),
        documentIds: selectedMaterialIds,
        embedding: {
          provider: form.embeddingProvider,
          baseUrl: form.embeddingBaseUrl,
          model: form.embeddingModel
        }
      }
    };
  }

  return {
    form,
    updateField,
    getGenerationPayload
  };
}
