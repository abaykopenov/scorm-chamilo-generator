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
  const sourceContext = buildSourceContext(input, { maxItems: 8, maxChars: 900 });

  const system = [
    "Generate JSON for an e-learning course without markdown and without explanations.",
    "The response must be a valid JSON object only.",
    "Follow requested structure and requested item counts exactly.",
    "Every screen must contain substantive content: text block with at least 2 full sentences and practical detail (target 220+ characters).",
    "Do not add any extra fields outside schema.",
    "Do not use placeholder phrases like 'Screen X introduces topic'. Write concrete content.",
    sourceContext.length > 0
      ? "Use sourceContext as primary material for modules, screens and final test questions."
      : "If sourceContext is empty, rely only on user brief."
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
      sourceContext,
      schema: createOutlineJsonSchema()
    }
  };
}

export function createOutlineRepairPrompt(input, invalidResponse, parseErrorMessage) {
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
      parseErrorMessage,
      invalidResponse: `${invalidResponse || ""}`.slice(0, 16_000),
      schema: createOutlineJsonSchema()
    }
  };
}

export function createLinePlanPrompt(input) {
  const sourceContext = buildSourceContext(input, { maxItems: 10, maxChars: 1000 });
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
      sourceContext
    }
  };
}

export function createLinePlanRepairPrompt(input, invalidResponse, parseErrorMessage) {
  const sourceContext = buildSourceContext(input, { maxItems: 8, maxChars: 800 });
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
      sourceContext
    }
  };
}
