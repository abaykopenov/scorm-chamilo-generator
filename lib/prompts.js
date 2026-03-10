function estimateScreenCount(input) {
  const moduleCount = Math.max(1, Math.trunc(Number(input?.structure?.moduleCount) || 1));
  const sectionsPerModule = Math.max(1, Math.trunc(Number(input?.structure?.sectionsPerModule) || 1));
  const scosPerSection = Math.max(1, Math.trunc(Number(input?.structure?.scosPerSection) || 1));
  const screensPerSco = Math.max(1, Math.trunc(Number(input?.structure?.screensPerSco) || 1));
  return moduleCount * sectionsPerModule * scosPerSection * screensPerSco;
}

function buildSourceContext(input, limits = {}) {
  const screenCount = estimateScreenCount(input);
  const adaptiveItemCap = screenCount >= 120
    ? 4
    : (screenCount >= 60 ? 5 : (screenCount >= 30 ? 6 : 8));
  const adaptiveCharCap = screenCount >= 120
    ? 420
    : (screenCount >= 60 ? 560 : (screenCount >= 30 ? 700 : 900));

  const requestedItems = Number(limits.maxItems) || Math.min(8, Number(input?.rag?.topK) || 6);
  const requestedChars = Number(limits.maxChars) || 900;

  const maxItems = Math.max(1, Math.min(12, adaptiveItemCap, requestedItems));
  const maxChars = Math.max(200, Math.min(1400, adaptiveCharCap, requestedChars));

  return Array.isArray(input?.ragContext?.chunks)
    ? input.ragContext.chunks.slice(0, maxItems).map((chunk, index) => ({
        order: index + 1,
        source: chunk.fileName || chunk.materialId || `source_${index + 1}`,
        score: chunk.score,
        text: `${chunk.text || ""}`.slice(0, maxChars)
      }))
    : [];
}
function buildScreenPlanHints(input, limits = {}) {
  const hints = Array.isArray(input?.ragContext?.screenPlanHints)
    ? input.ragContext.screenPlanHints
    : [];
  const maxItems = Math.max(1, Math.min(60, Number(limits.maxItems) || 24));

  return hints.slice(0, maxItems).map((hint) => ({
    label: hint?.label,
    objective: `${hint?.objective || ""}`.slice(0, 180),
    keyFacts: Array.isArray(hint?.keyFacts)
      ? hint.keyFacts.slice(0, 3).map((fact) => `${fact || ""}`.slice(0, 200))
      : []
  }));
}

export function createOutlineJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "modules", "finalTest"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      modules: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "sections"],
          properties: {
            title: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "scos"],
                properties: {
                  title: { type: "string" },
                  scos: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["title", "screens"],
                      properties: {
                        title: { type: "string" },
                        screens: {
                          type: "array",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["title", "blocks"],
                            properties: {
                              title: { type: "string" },
                              blocks: {
                                type: "array",
                                items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["type"],
                                  properties: {
                                    type: { type: "string", enum: ["text", "note", "list"] },
                                    text: { type: "string" },
                                    items: {
                                      type: "array",
                                      items: { type: "string" }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      finalTest: {
        type: "object",
        additionalProperties: false,
        required: ["title", "questions"],
        properties: {
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["prompt", "options", "correctOptionIndex", "explanation"],
              properties: {
                prompt: { type: "string" },
                options: {
                  type: "array",
                  minItems: 4,
                  items: { type: "string" }
                },
                correctOptionIndex: { type: "number" },
                explanation: { type: "string" }
              }
            }
          }
        }
      }
    }
  };
}

export function createOutlinePrompt(input) {
  const screenCount = estimateScreenCount(input);
  const generationPhase = `${input?.generation?.generationPhase || "full"}`.trim().toLowerCase();
  const structureOnly = generationPhase === "structure";
  const writerPhase = generationPhase === "writer";
  const sourceContext = buildSourceContext(input, {
    maxItems: structureOnly ? 5 : (writerPhase ? 8 : 7),
    maxChars: structureOnly ? 520 : (writerPhase ? 1000 : 780)
  });
  const screenPlanHints = buildScreenPlanHints(input, {
    maxItems: structureOnly
      ? Math.max(6, Math.min(14, Math.ceil(screenCount / 2)))
      : Math.max(8, Math.min(18, Math.ceil(screenCount / 2)))
  });

  const system = [
    "Generate JSON for an e-learning course without markdown and without explanations.",
    "The response must be a valid JSON object only.",
    "Follow requested structure and requested item counts exactly.",
    structureOnly
      ? "Structure phase only: produce short skeleton content (titles + minimal blocks) to keep response compact."
      : (writerPhase
        ? "Writer phase: generate deep instructional content strictly grounded in sourceContext and screenPlanHints."
        : "Every screen must contain substantive content: text block with at least 2 full sentences and practical detail (target 220+ characters)."),
    structureOnly
      ? "For each screen return one short text block (max about 120 chars). Avoid long narratives and avoid list blocks unless required."
      : (writerPhase
        ? "For each screen return: 1) one long text block (minimum about 900 characters), 2) one list block (3-5 concrete takeaways), 3) one note block with source references."
        : "Do not add any extra fields outside schema."),
    writerPhase
      ? "Do not invent facts beyond sourceContext. Every claim must be traceable to provided facts."
      : "Do not use placeholder phrases like 'Screen X introduces topic'. Write concrete content.",
    sourceContext.length > 0
      ? "Use sourceContext as primary material for modules, screens and final test questions."
      : "If sourceContext is empty, rely only on user brief.",
    screenPlanHints.length > 0
      ? "Use screenPlanHints in order. Each next screen must use its own hints and must not repeat previous screen wording."
      : ""
  ].join(" ");

  return {
    system,
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      structure: input.structure,
      finalTest: input.finalTest,
      generationPhase,
      sourceContext,
      screenPlanHints
    }
  };
}
export function createOutlineRepairPrompt(input, invalidResponse, parseErrorMessage) {
  const generationPhase = `${input?.generation?.generationPhase || "full"}`.trim().toLowerCase();
  return {
    system: [
      "Convert draft model output into strictly valid course JSON.",
      "Return JSON object only.",
      "No markdown, no explanations, no comments.",
      "Follow schema exactly."
    ].join(" "),
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      structure: input.structure,
      finalTest: input.finalTest,
      generationPhase,
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 16_000),
      schema: createOutlineJsonSchema()
    }
  };
}

export function createLinePlanPrompt(input) {
  const sourceContext = buildSourceContext(input, { maxItems: 10, maxChars: 1000 });
  const screenPlanHints = buildScreenPlanHints(input, { maxItems: 18 });
  const screenCount =
    Number(input?.structure?.moduleCount || 1) *
    Number(input?.structure?.sectionsPerModule || 1) *
    Number(input?.structure?.scosPerSection || 1) *
    Number(input?.structure?.screensPerSco || 1);
  const topicCount = Math.max(4, Math.min(18, screenCount));
  const questionCount = Math.max(1, Number(input?.finalTest?.questionCount || 8));

  return {
    system: [
      "Generate course plan and test in strict line format (no JSON, no markdown).",
      "No extra text before or after lines.",
      "Line format:",
      "TITLE|...",
      "DESCRIPTION|...",
      "TOPIC|<title>|<explanation>|<bullet1>; <bullet2>; <bullet3>",
      "TOPIC explanation must be concrete and complete (at least 2 full sentences, avoid generic filler).",
      "QUESTION|<prompt>|<option1>|<option2>|<option3>|<option4>|<correctOptionIndex1to4>|<explanation>",
      "All TOPIC and QUESTION lines must be grounded in sourceContext.",
      "Use screenPlanHints to avoid repetition between consecutive topics/screens.",
      "Do not use placeholder text."
    ].join(" "),
    user: {
      language: input.language,
      title: input.titleHint,
      audience: input.audience,
      durationMinutes: input.durationMinutes,
      learningGoals: input.learningGoals,
      requiredTopicCount: topicCount,
      requiredQuestionCount: questionCount,
      sourceContext,
      screenPlanHints
    }
  };
}

export function createLinePlanRepairPrompt(input, invalidResponse, parseErrorMessage) {
  const sourceContext = buildSourceContext(input, { maxItems: 8, maxChars: 800 });
  const screenPlanHints = buildScreenPlanHints(input, { maxItems: 24 });
  const questionCount = Math.max(1, Number(input?.finalTest?.questionCount || 8));

  return {
    system: [
      "Reformat draft model output into strict line format (no JSON, no markdown).",
      "Allowed lines only: TITLE|, DESCRIPTION|, TOPIC| and QUESTION|.",
      "Keep semantic connection with sourceContext."
    ].join(" "),
    user: {
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 12_000),
      requiredQuestionCount: questionCount,
      sourceContext,
      screenPlanHints
    }
  };
}








