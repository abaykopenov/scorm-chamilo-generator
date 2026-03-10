// ---------------------------------------------------------------------------
// lib/local-llm.js — Backward-compatible re-export façade
// ---------------------------------------------------------------------------
// This file used to contain ~1 172 lines of monolithic code.
// It has been decomposed into focused sub-modules under lib/llm/:
//
//   lib/llm/utils.js      — logging, timeouts, networking, error helpers
//   lib/llm/providers.js  — Ollama & OpenAI-compatible providers, callProvider
//   lib/llm/parser.js     — JSON extraction, line-plan parsing, validation
//
// This file now re-exports the public API to keep all existing imports working.
// ---------------------------------------------------------------------------

import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";
import {
  createOutlineJsonSchema as createOutlineJsonSchemaPrompt,
  createOutlinePrompt,
  createOutlineRepairPrompt,
  createLinePlanPrompt as createLinePlanPromptTemplate,
  createLinePlanRepairPrompt as createLinePlanRepairPromptTemplate,
  createFinalTestPrompt
} from "./prompts.js";

import { callProvider } from "./llm/providers.js";
import { parseJsonFromLlmText, parseLinePlanText, validateOutlineJson } from "./llm/parser.js";
import {
  describeTrace,
  isEndpointUnreachableError,
  llmLog,
  LOG_CHARS_RESPONSE_PREVIEW,
  looksLikeEmbeddingModel,
  toPlainText,
  truncateForLog
} from "./llm/utils.js";

// Re-export public API
export { checkLocalLlmConnection } from "./llm/providers.js";
export { parseLinePlanText } from "./llm/parser.js";

// ── Internal helpers (kept here as they depend on prompts.js + ids.js) ─────

function createOutlineJsonSchema() {
  return createOutlineJsonSchemaPrompt();
}

function createPrompt(input) {
  return createOutlinePrompt(input);
}

function createRepairPrompt(input, invalidResponse, parseErrorMessage) {
  return createOutlineRepairPrompt(input, invalidResponse, parseErrorMessage);
}

function createLinePlanPrompt(input) {
  return createLinePlanPromptTemplate(input);
}

function createLinePlanRepairPrompt(input, invalidResponse, parseErrorMessage) {
  return createLinePlanRepairPromptTemplate(input, invalidResponse, parseErrorMessage);
}

function normalizeBlocks(blocks, fallbackTitle, fallbackText) {
  const list = Array.isArray(blocks) ? blocks : [];
  const normalized = list
    .map((block) => {
      if (!block || typeof block !== "object") {
        return null;
      }

      const type = ["text", "note", "list", "image"].includes(block.type) ? block.type : "text";
      if (type === "list") {
        const items = Array.isArray(block.items) ? block.items.map((item) => `${item}`.trim()).filter(Boolean) : [];
        return { type, items: items.length > 0 ? items : [fallbackText] };
      }
      if (type === "image") {
        return {
          type,
          src: toPlainText(block.src, ""),
          alt: toPlainText(block.alt, fallbackTitle)
        };
      }

      return {
        type,
        text: toPlainText(block.text, fallbackText)
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) {
    return normalized;
  }

  return [
    {
      type: "text",
      text: fallbackText
    }
  ];
}

function normalizeOptions(question, fallbackIndex) {
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  const options = rawOptions.length > 0
    ? rawOptions.map((option, optionIndex) => ({
        id: createId("option"),
        text: toPlainText(typeof option === "string" ? option : option?.text, "Option " + (optionIndex + 1))
      }))
    : Array.from({ length: 4 }, (_, optionIndex) => ({
        id: createId("option"),
        text: "Option " + (optionIndex + 1)
      }));

  const answerIndex = Number.isFinite(Number(question?.correctOptionIndex))
    ? Math.max(0, Math.min(options.length - 1, Math.trunc(Number(question.correctOptionIndex))))
    : 0;

  return {
    options,
    correctOptionId: options[answerIndex]?.id ?? options[0].id,
    explanation: toPlainText(question?.explanation, "Explanation for question " + (fallbackIndex + 1) + ".")
  };
}

// ── Outline generation (calls providers + parser) ──────────────────────────

export async function createOutlineFromLocalLlm(input, options = {}) {
  const strict = Boolean(options?.strict);
  const config = input.generation;
  const trace = describeTrace(options?.trace);
  llmLog("outline.start", {
    strict,
    provider: config?.provider,
    model: config?.model,
    ragChunks: Array.isArray(input?.ragContext?.chunks) ? input.ragContext.chunks.length : 0,
    ...trace
  });
  if (!config || config.provider === "template") {
    if (strict) {
      throw new Error("LLM provider is template mode. Switch provider to Ollama or OpenAI-compatible.");
    }
    llmLog("outline.skip.template", { ...trace });
    return null;
  }

  if (looksLikeEmbeddingModel(config.model)) {
    const message = `Model ${config.model} looks like an embedding model and cannot generate course text. ` +
      "Choose a text generation model (for example qwen2.5, llama, mistral).";
    llmLog("outline.invalid-model", { model: config.model, ...trace });
    if (strict) {
      throw new Error(message);
    }
    console.error(message);
    return null;
  }

  const prompt = createPrompt(input);
  const schema = createOutlineJsonSchema();
  let raw = "";

  try {
    raw = await callProvider(config, prompt, {
      format: schema,
      jsonMode: true,
      trace: { ...trace, phase: "outline-main", attempt: 1 }
    });
    llmLog("outline.raw", { ...trace, rawLength: raw.length, rawPreview: truncateForLog(raw, LOG_CHARS_RESPONSE_PREVIEW) });
    const parsed = parseJsonFromLlmText(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("LLM response is not a JSON object.");
    }
    const validation = validateOutlineJson(parsed, input, options?.validate || {});
    if (!validation.ok) {
      throw new Error("Outline quality validation failed: " + validation.reason);
    }
    llmLog("outline.parsed", {
      ...trace,
      modules: Array.isArray(parsed?.modules) ? parsed.modules.length : 0,
      finalQuestions: Array.isArray(parsed?.finalTest?.questions) ? parsed.finalTest.questions.length : 0,
      validation: validation.stats || null
    });
    return parsed;
  } catch (error) {
    llmLog("outline.error", { ...trace, reason: error instanceof Error ? error.message : `${error || "unknown error"}` });
    if (isEndpointUnreachableError(error)) {
      if (strict) {
        const message = error instanceof Error ? error.message : "Local LLM generation failed.";
        throw new Error(`Local LLM generation failed: ${message}`);
      }
      console.error("Local LLM generation failed; caller may apply fallback generation mode.", error);
      return null;
    }

    const parseMessage = error instanceof Error ? error.message : "Invalid LLM response";
    try {
      const repairPrompt = createRepairPrompt(input, raw, parseMessage);
      const repairedRaw = await callProvider(
        { ...config, temperature: Math.min(0.1, Number(config.temperature) || 0.1) },
        repairPrompt,
        {
          format: schema,
          jsonMode: true,
          trace: { ...trace, phase: "outline-repair", attempt: 2 }
        }
      );
      llmLog("outline.repair.raw", { ...trace, rawLength: repairedRaw.length, rawPreview: truncateForLog(repairedRaw, LOG_CHARS_RESPONSE_PREVIEW) });
      const repairedParsed = parseJsonFromLlmText(repairedRaw);
      if (repairedParsed && typeof repairedParsed === "object") {
        const repairedValidation = validateOutlineJson(repairedParsed, input, options?.validate || {});
        if (!repairedValidation.ok) {
          throw new Error("Outline repair validation failed: " + repairedValidation.reason);
        }
        llmLog("outline.repair.parsed", {
          ...trace,
          modules: Array.isArray(repairedParsed?.modules) ? repairedParsed.modules.length : 0,
          finalQuestions: Array.isArray(repairedParsed?.finalTest?.questions) ? repairedParsed.finalTest.questions.length : 0,
          validation: repairedValidation.stats || null
        });
        return repairedParsed;
      }
    } catch (repairError) {
      llmLog("outline.repair.error", { ...trace, reason: repairError instanceof Error ? repairError.message : `${repairError || "unknown error"}` });
    }

    if (strict) {
      const message = error instanceof Error ? error.message : "Local LLM generation failed.";
      throw new Error(`Failed to generate course via LLM: ${message}`);
    }
    console.error("Local LLM generation failed; caller may apply fallback generation mode.", error);
    return null;
  }
}

// ── Line-plan generation ───────────────────────────────────────────────────

export async function createLinePlanFromLocalLlm(input, options = {}) {
  const strict = Boolean(options?.strict);
  const config = input.generation;
  const trace = describeTrace(options?.trace);
  llmLog("lineplan.start", {
    strict,
    provider: config?.provider,
    model: config?.model,
    ragChunks: Array.isArray(input?.ragContext?.chunks) ? input.ragContext.chunks.length : 0,
    ...trace
  });
  if (!config || config.provider === "template") {
    if (strict) {
      throw new Error("LLM provider is template mode. Switch provider to Ollama or OpenAI-compatible.");
    }
    llmLog("lineplan.skip.template", { ...trace });
    return null;
  }

  if (looksLikeEmbeddingModel(config.model)) {
    const message = `Model ${config.model} looks like an embedding model and cannot generate course text. ` +
      "Choose a text generation model (for example qwen2.5, llama, mistral).";
    llmLog("lineplan.invalid-model", { model: config.model, ...trace });
    if (strict) {
      throw new Error(message);
    }
    console.error(message);
    return null;
  }

  const prompt = createLinePlanPrompt(input);
  let raw = "";

  try {
    raw = await callProvider(config, prompt, {
      jsonMode: false,
      trace: { ...trace, phase: "lineplan-main", attempt: 1 }
    });
    llmLog("lineplan.raw", { ...trace, rawLength: raw.length, rawPreview: truncateForLog(raw, LOG_CHARS_RESPONSE_PREVIEW) });
    const parsed = parseLinePlanText(raw, input);
    llmLog("lineplan.parsed", {
      ...trace,
      topics: Array.isArray(parsed?.topics) ? parsed.topics.length : 0,
      questions: Array.isArray(parsed?.questions) ? parsed.questions.length : 0
    });
    return parsed;
  } catch (error) {
    llmLog("lineplan.error", { ...trace, reason: error instanceof Error ? error.message : `${error || "unknown error"}` });
    if (isEndpointUnreachableError(error)) {
      if (strict) {
        const message = error instanceof Error ? error.message : "Local LLM generation failed.";
        throw new Error(`Local LLM line-plan generation failed: ${message}`);
      }
      console.error("Local LLM line-plan generation failed; caller may apply fallback generation mode.", error);
      return null;
    }

    const parseMessage = error instanceof Error ? error.message : "Invalid line-plan response";
    try {
      const repairPrompt = createLinePlanRepairPrompt(input, raw, parseMessage);
      const repairedRaw = await callProvider(
        { ...config, temperature: Math.min(0.1, Number(config.temperature) || 0.1) },
        repairPrompt,
        {
          jsonMode: false,
          trace: { ...trace, phase: "lineplan-repair", attempt: 2 }
        }
      );
      llmLog("lineplan.repair.raw", { ...trace, rawLength: repairedRaw.length, rawPreview: truncateForLog(repairedRaw, LOG_CHARS_RESPONSE_PREVIEW) });
      const repairedParsed = parseLinePlanText(repairedRaw, input);
      llmLog("lineplan.repair.parsed", {
        ...trace,
        topics: Array.isArray(repairedParsed?.topics) ? repairedParsed.topics.length : 0,
        questions: Array.isArray(repairedParsed?.questions) ? repairedParsed.questions.length : 0
      });
      return repairedParsed;
    } catch (repairError) {
      llmLog("lineplan.repair.error", { ...trace, reason: repairError instanceof Error ? repairError.message : `${repairError || "unknown error"}` });
    }

    if (strict) {
      const message = error instanceof Error ? error.message : "Local LLM generation failed.";
      throw new Error(`Failed to generate course via LLM (line plan): ${message}`);
    }
    console.error("Local LLM line-plan generation failed; caller may apply fallback generation mode.", error);
    return null;
  }
}

// ── Build course from outline ──────────────────────────────────────────────

export function buildCourseFromOutline(input, outline) {
  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => {
    const moduleSource = outline?.modules?.[moduleIndex] ?? {};
    return {
      id: createId("module"),
      title: toPlainText(moduleSource.title, `Module ${moduleIndex + 1}`),
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => {
        const sectionSource = moduleSource.sections?.[sectionIndex] ?? {};
        return {
          id: createId("section"),
          title: toPlainText(sectionSource.title, `Section ${moduleIndex + 1}.${sectionIndex + 1}`),
          order: sectionIndex + 1,
          scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => {
            const scoSource = sectionSource.scos?.[scoIndex] ?? {};
            return {
              id: createId("sco"),
              title: toPlainText(scoSource.title, `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`),
              order: scoIndex + 1,
              screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
                const screenSource = scoSource.screens?.[screenIndex] ?? {};
                const screenTitle = toPlainText(screenSource.title, `Screen ${screenIndex + 1}`);
                return {
                  id: createId("screen"),
                  title: screenTitle,
                  order: screenIndex + 1,
                  blocks: normalizeBlocks(
                    screenSource.blocks,
                    screenTitle,
                    `Screen ${screenIndex + 1} explains "${input.titleHint}" for audience "${input.audience}".`
                  )
                };
              })
            };
          })
        };
      })
    };
  });

  const questions = Array.from({ length: input.finalTest.questionCount }, (_, questionIndex) => {
    const questionSource = outline?.finalTest?.questions?.[questionIndex] ?? {};
    const normalized = normalizeOptions(questionSource, questionIndex);
    return {
      id: createId("question"),
      prompt: toPlainText(questionSource.prompt, `Control question ${questionIndex + 1}`),
      options: normalized.options,
      correctOptionId: normalized.correctOptionId,
      explanation: normalized.explanation
    };
  });

  return {
    id: createId("course"),
    title: toPlainText(outline?.title, input.titleHint),
    description: toPlainText(
      outline?.description,
      `Auto-generated course for audience "${input.audience}". Estimated duration: ${input.durationMinutes} minutes.`
    ),
    language: input.language,
    generation: input.generation,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest: {
      id: createId("final_test"),
      enabled: input.finalTest.enabled,
      title: toPlainText(outline?.finalTest?.title, "Final test"),
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}

export async function createFinalTestFromLocalLlm(input, courseTextContext, options = {}) {
  const config = input?.generation || null;
  const trace = options?.trace || {};

  llmLog("final_test.start", {
    provider: config?.provider,
    model: config?.model,
    ...trace
  });
  
  if (!config || config.provider === "template") {
    llmLog("final_test.skip.template", { ...trace });
    return null;
  }

  const prompt = createFinalTestPrompt(input, courseTextContext);
  let raw = "";

  try {
    raw = await callProvider(config, prompt, {
      jsonMode: true,
      trace: { ...trace, phase: "final_test-main", attempt: 1 }
    });
    const parsed = parseJsonFromLlmText(raw);
    
    // Ensure we return exactly what was asked
    if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      return parsed.questions;
    }
    return null;
  } catch (error) {
    llmLog("final_test.error", { ...trace, reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}
