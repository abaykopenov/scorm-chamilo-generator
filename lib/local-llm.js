import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";
import {
  createOutlineJsonSchema as createOutlineJsonSchemaPrompt,
  createOutlinePrompt,
  createOutlineRepairPrompt,
  createLinePlanPrompt as createLinePlanPromptTemplate,
  createLinePlanRepairPrompt as createLinePlanRepairPromptTemplate
} from "./prompts.js";

function toPlainText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function looksLikeEmbeddingModel(modelName) {
  return /(embed|embedding|bge|e5|mxbai|nomic-embed)/i.test(`${modelName || ""}`);
}

function isEndpointUnreachableError(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  return /endpoint is unreachable|timeout after|fetch failed|aborted|network error/i.test(message);
}

function shouldFallbackFromChatToGenerate(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  return /chat request failed with status (404|405|501)/i.test(message)
    || /chat response is empty/i.test(message)
    || isEndpointUnreachableError(error);
}
function shouldRetryNetworkError(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  return /fetch failed|network error|econnreset|socket hang up|aborted|timeout/i.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVerboseLlmLogEnabled() {
  const raw = `${process.env.LOCAL_LLM_VERBOSE_LOGS ?? "1"}`.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function truncateForLog(value, maxLength = 500) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function sanitizeForLog(value, maxLength = 500) {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateForLog(value, maxLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeForLog(item, maxLength));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 24).map(([key, item]) => [key, sanitizeForLog(item, maxLength)]);
    return Object.fromEntries(entries);
  }
  return `${value}`;
}

function llmLog(event, payload = {}) {
  if (!isVerboseLlmLogEnabled()) {
    return;
  }
  const safePayload = sanitizeForLog(payload, 800);
  console.log(`[local-llm] ${event}`, safePayload);
}

function serializePromptUser(userPayload) {
  if (typeof userPayload === "string") {
    return userPayload;
  }
  try {
    return JSON.stringify(userPayload, null, 2);
  } catch {
    return `${userPayload ?? ""}`;
  }
}

function describePrompt(prompt) {
  const system = `${prompt?.system ?? ""}`;
  const user = serializePromptUser(prompt?.user);
  return {
    systemLength: system.length,
    userLength: user.length,
    systemPreview: truncateForLog(system, 220),
    userPreview: truncateForLog(user, 320)
  };
}

function describeTrace(trace) {
  if (!trace || typeof trace !== "object") {
    return {};
  }
  const keys = ["stage", "phase", "module", "section", "sco", "screen", "attempt"];
  const entries = keys
    .filter((key) => trace[key] !== undefined && trace[key] !== null)
    .map((key) => [key, trace[key]]);
  return Object.fromEntries(entries);
}


function parseJsonFromLlmText(raw) {
  if (typeof raw !== "string") {
    throw new Error("LLM returned non-text response.");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("LLM returned empty response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatches = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fencedMatches) {
    const unwrapped = block.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(unwrapped);
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  const preview = trimmed.slice(0, 120).replace(/\s+/g, " ");
  throw new Error(`Model did not return valid JSON. Preview: ${preview}`);
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
        text: toPlainText(typeof option === "string" ? option : option?.text, `Вариант ${optionIndex + 1}`)
      }))
    : Array.from({ length: 4 }, (_, optionIndex) => ({
        id: createId("option"),
        text: `Вариант ${optionIndex + 1}`
      }));

  const answerIndex = Number.isFinite(Number(question?.correctOptionIndex))
    ? Math.max(0, Math.min(options.length - 1, Math.trunc(Number(question.correctOptionIndex))))
    : 0;

  return {
    options,
    correctOptionId: options[answerIndex]?.id ?? options[0].id,
    explanation: toPlainText(question?.explanation, `Вопрос ${fallbackIndex + 1} проверяет ключевое понимание темы.`)
  };
}

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

export function parseLinePlanText(raw, input) {
  if (typeof raw !== "string") {
    throw new Error("LLM returned non-text response.");
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const topics = [];
  const questions = [];
  let title = "";
  let description = "";

  for (const line of lines) {
    if (line.startsWith("TITLE|")) {
      title = line.slice("TITLE|".length).trim();
      continue;
    }
    if (line.startsWith("DESCRIPTION|")) {
      description = line.slice("DESCRIPTION|".length).trim();
      continue;
    }
    if (line.startsWith("TOPIC|")) {
      const parts = line.split("|");
      const topicTitle = `${parts[1] || ""}`.trim();
      const topicText = `${parts[2] || ""}`.trim();
      const bulletText = parts.slice(3).join("|");
      const bullets = bulletText
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3);
      while (bullets.length < 3) {
        bullets.push(`Ключевой вывод ${bullets.length + 1}`);
      }
      topics.push({
        title: topicTitle || `Тема ${topics.length + 1}`,
        text: topicText || `Краткое объяснение темы ${topics.length + 1}.`,
        bullets
      });
      continue;
    }
    if (line.startsWith("QUESTION|")) {
      const parts = line.split("|");
      if (parts.length < 8) {
        continue;
      }
      const prompt = `${parts[1] || ""}`.trim();
      const optionTexts = [
        `${parts[2] || ""}`.trim(),
        `${parts[3] || ""}`.trim(),
        `${parts[4] || ""}`.trim(),
        `${parts[5] || ""}`.trim()
      ];
      const parsedIndex = Math.trunc(Number(parts[6])) - 1;
      const correctOptionIndex = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(3, parsedIndex)) : 0;
      const explanation = parts.slice(7).join("|").trim();
      const normalizedOptions = optionTexts.map((option, index) => option || `Вариант ${index + 1}`);

      questions.push({
        prompt: prompt || `Контрольный вопрос ${questions.length + 1}`,
        options: normalizedOptions,
        correctOptionIndex,
        explanation: explanation || `Пояснение к вопросу ${questions.length + 1}.`
      });
    }
  }

  const requiredQuestions = Math.max(1, Number(input?.finalTest?.questionCount || 8));
  while (questions.length < requiredQuestions) {
    questions.push({
      prompt: `Контрольный вопрос ${questions.length + 1}`,
      options: ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
      correctOptionIndex: 0,
      explanation: `Пояснение к вопросу ${questions.length + 1}.`
    });
  }

  if (topics.length === 0) {
    throw new Error("Plan output did not contain TOPIC lines.");
  }

  return {
    title: title || `${input?.titleHint || "Курс"}`.trim(),
    description: description || `Курс для аудитории "${input?.audience || "слушатели"}".`,
    topics,
    questions: questions.slice(0, requiredQuestions)
  };
}

async function fetchWithNetworkHint(url, options, label, meta = {}) {
  const configuredTimeout = Number(process.env.LOCAL_LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.max(3_000, Math.min(900_000, configuredTimeout))
    : 900_000;
  const configuredRetries = Number(process.env.LOCAL_LLM_FETCH_RETRIES);
  const maxRetries = Number.isFinite(configuredRetries) && configuredRetries >= 0
    ? Math.min(5, Math.trunc(configuredRetries))
    : 2;

  const hasExternalSignal = options && typeof options === "object" && "signal" in options;
  const requestOptions = {
    ...(options || {}),
    signal: hasExternalSignal ? options.signal : AbortSignal.timeout(timeoutMs)
  };

  llmLog("http.request", {
    label,
    url,
    timeoutMs,
    retries: maxRetries,
    ...describeTrace(meta?.trace),
    stage: meta?.stage
  });

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, requestOptions);
      llmLog("http.response", {
        label,
        url,
        status: response.status,
        ok: response.ok,
        attempt,
        ...describeTrace(meta?.trace),
        stage: meta?.stage
      });
      return response;
    } catch (error) {
      lastError = error;
      const reason = error instanceof Error ? error.message : "unknown network error";
      llmLog("http.error", {
        label,
        url,
        attempt,
        reason,
        ...describeTrace(meta?.trace),
        stage: meta?.stage
      });
      if (attempt < maxRetries && shouldRetryNetworkError(error)) {
        const backoffMs = 350 * (attempt + 1);
        llmLog("http.retry", {
          label,
          url,
          attempt,
          backoffMs,
          ...describeTrace(meta?.trace),
          stage: meta?.stage
        });
        await delay(backoffMs);
        continue;
      }
      const timedOut = /aborted|timeout/i.test(reason);
      const hint = timedOut ? `timeout after ${timeoutMs}ms` : reason;
      throw new Error(`${label} endpoint is unreachable: ${url}. ${hint}`);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : "unknown network error";
  throw new Error(`${label} endpoint is unreachable: ${url}. ${reason}`);
}

async function callOllama(config, prompt, options = {}) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const keepAlive = `${process.env.LOCAL_LLM_OLLAMA_KEEP_ALIVE || "20m"}`.trim();
  const chatUrl = `${baseUrl}/api/chat`;
  const trace = describeTrace(options?.trace);
  const promptInfo = describePrompt(prompt);
  llmLog("ollama.chat.request", {
    model: config.model,
    temperature: config.temperature,
    keepAlive,
    jsonFormat: Boolean(options?.format),
    ...trace,
    ...promptInfo
  });
  try {
    const jsonFormat = options?.format;
    const chatBody = {
      model: config.model,
      stream: false,
      think: false,
      ...(keepAlive ? { keep_alive: keepAlive } : {}),
      ...(jsonFormat ? { format: jsonFormat } : {}),
      options: {
        temperature: config.temperature
      },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: JSON.stringify(prompt.user) }
      ]
    };
    const response = await fetchWithNetworkHint(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody)
    }, "Ollama", { trace, stage: "chat" });

    if (!response.ok) {
      const errorBody = await response.text();
      llmLog("ollama.chat.failed", {
        status: response.status,
        ...trace,
        bodyPreview: truncateForLog(errorBody, 500)
      });
      throw new Error(`Ollama chat request failed with status ${response.status} (${chatUrl})`);
    }
    const payload = await response.json();
    const content = payload?.message?.content ?? "";
    llmLog("ollama.chat.response", {
      status: response.status,
      ...trace,
      contentLength: content.length,
      contentPreview: truncateForLog(content, 600)
    });
    if (content) {
      return content;
    }
    throw new Error("Ollama chat response is empty.");
  } catch (error) {
    if (!shouldFallbackFromChatToGenerate(error)) {
      throw error;
    }
    const url = `${baseUrl}/api/generate`;
    const jsonMode = options?.jsonMode !== false;
    const promptText = `${prompt.system}\n\n${JSON.stringify(prompt.user, null, 2)}`;
    llmLog("ollama.generate.request", {
      model: config.model,
      temperature: config.temperature,
      keepAlive,
      jsonMode,
      ...trace,
      promptLength: promptText.length,
      promptPreview: truncateForLog(promptText, 350)
    });
    const response = await fetchWithNetworkHint(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
        ...(jsonMode ? { format: "json" } : {}),
        think: false,
        options: {
          temperature: config.temperature
        },
        prompt: promptText
      })
    }, "Ollama", { trace, stage: "generate" });

    if (!response.ok) {
      const errorBody = await response.text();
      llmLog("ollama.generate.failed", {
        status: response.status,
        ...trace,
        bodyPreview: truncateForLog(errorBody, 500)
      });
      throw new Error(`Ollama request failed with status ${response.status} (${url})`);
    }

    const payload = await response.json();
    const content = payload?.response ?? "";
    llmLog("ollama.generate.response", {
      status: response.status,
      ...trace,
      contentLength: content.length,
      contentPreview: truncateForLog(content, 600)
    });
    return content;
  }
}
async function callOpenAiCompatible(config, prompt, options = {}) {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const jsonMode = options?.jsonMode !== false;
  const trace = describeTrace(options?.trace);
  const promptInfo = describePrompt(prompt);
  llmLog("openai.request", {
    model: config.model,
    temperature: config.temperature,
    jsonMode,
    ...trace,
    ...promptInfo
  });
  const response = await fetchWithNetworkHint(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: JSON.stringify(prompt.user, null, 2) }
      ]
    })
  }, "OpenAI-compatible", { trace, stage: "chat.completions" });

  if (!response.ok) {
    const errorBody = await response.text();
    llmLog("openai.failed", {
      status: response.status,
      ...trace,
      bodyPreview: truncateForLog(errorBody, 500)
    });
    throw new Error(`OpenAI-compatible request failed with status ${response.status} (${url})`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? "";
  llmLog("openai.response", {
    status: response.status,
    ...trace,
    contentLength: content.length,
    contentPreview: truncateForLog(content, 600)
  });
  return content;
}
async function callProvider(config, prompt, options = {}) {
  const trace = describeTrace(options?.trace);
  llmLog("provider.dispatch", {
    provider: config.provider,
    model: config.model,
    ...trace
  });
  return config.provider === "openai-compatible"
    ? callOpenAiCompatible(config, prompt, options)
    : callOllama(config, prompt, options);
}

export async function checkLocalLlmConnection(config) {
  if (!config || config.provider === "template") {
    return {
      ok: true,
      provider: "template",
      message: "Шаблонный режим не требует внешнего подключения."
    };
  }

  const baseUrl = `${config.baseUrl || ""}`.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("Base URL for local LLM is required.");
  }

  if (config.provider === "ollama") {
    const tagsUrl = `${baseUrl}/api/tags`;
    const response = await fetchWithNetworkHint(tagsUrl, undefined, "Ollama");
    if (!response.ok) {
      throw new Error(`Ollama check failed with status ${response.status} (${tagsUrl})`);
    }
    const payload = await response.json();
    const names = Array.isArray(payload?.models) ? payload.models.map((model) => model.name).filter(Boolean) : [];
    const hasModel = names.includes(config.model);
    const embeddingWarning = looksLikeEmbeddingModel(config.model)
      ? " Внимание: это embedding-модель, она не подходит для генерации текста."
      : "";
    return {
      ok: true,
      provider: "ollama",
      message: hasModel
        ? `Ollama доступен. Модель ${config.model} найдена.${embeddingWarning}`
        : `Ollama доступен. Модель ${config.model} не найдена среди: ${names.slice(0, 5).join(", ") || "список пуст"}.${embeddingWarning}`
    };
  }

  const modelsUrl = `${baseUrl}/models`;
  const response = await fetchWithNetworkHint(modelsUrl, undefined, "OpenAI-compatible");
  if (!response.ok) {
    throw new Error(`OpenAI-compatible check failed with status ${response.status} (${modelsUrl})`);
  }
  const payload = await response.json();
  const modelIds = Array.isArray(payload?.data) ? payload.data.map((item) => item.id).filter(Boolean) : [];
  const hasModel = modelIds.includes(config.model);
  const embeddingWarning = looksLikeEmbeddingModel(config.model)
    ? " Внимание: это embedding-модель, она не подходит для генерации текста."
    : "";
  return {
    ok: true,
    provider: "openai-compatible",
    message: hasModel
      ? `OpenAI-compatible endpoint доступен. Модель ${config.model} найдена.${embeddingWarning}`
      : `Endpoint доступен. Модель ${config.model} не найдена среди: ${modelIds.slice(0, 5).join(", ") || "список пуст"}.${embeddingWarning}`
  };
}

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
    llmLog("outline.raw", { ...trace, rawLength: raw.length, rawPreview: truncateForLog(raw, 700) });
    const parsed = parseJsonFromLlmText(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("LLM response is not a JSON object.");
    }
    llmLog("outline.parsed", {
      ...trace,
      modules: Array.isArray(parsed?.modules) ? parsed.modules.length : 0,
      finalQuestions: Array.isArray(parsed?.finalTest?.questions) ? parsed.finalTest.questions.length : 0
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
      llmLog("outline.repair.raw", { ...trace, rawLength: repairedRaw.length, rawPreview: truncateForLog(repairedRaw, 700) });
      const repairedParsed = parseJsonFromLlmText(repairedRaw);
      if (repairedParsed && typeof repairedParsed === "object") {
        llmLog("outline.repair.parsed", {
          ...trace,
          modules: Array.isArray(repairedParsed?.modules) ? repairedParsed.modules.length : 0,
          finalQuestions: Array.isArray(repairedParsed?.finalTest?.questions) ? repairedParsed.finalTest.questions.length : 0
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
    llmLog("lineplan.raw", { ...trace, rawLength: raw.length, rawPreview: truncateForLog(raw, 700) });
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
      llmLog("lineplan.repair.raw", { ...trace, rawLength: repairedRaw.length, rawPreview: truncateForLog(repairedRaw, 700) });
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

export function buildCourseFromOutline(input, outline) {
  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => {
    const moduleSource = outline?.modules?.[moduleIndex] ?? {};
    return {
      id: createId("module"),
      title: toPlainText(moduleSource.title, `Модуль ${moduleIndex + 1}`),
      order: moduleIndex + 1,
      sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => {
        const sectionSource = moduleSource.sections?.[sectionIndex] ?? {};
        return {
          id: createId("section"),
          title: toPlainText(sectionSource.title, `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`),
          order: sectionIndex + 1,
          scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => {
            const scoSource = sectionSource.scos?.[scoIndex] ?? {};
            return {
              id: createId("sco"),
              title: toPlainText(scoSource.title, `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`),
              order: scoIndex + 1,
              screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => {
                const screenSource = scoSource.screens?.[screenIndex] ?? {};
                const screenTitle = toPlainText(screenSource.title, `Экран ${screenIndex + 1}`);
                return {
                  id: createId("screen"),
                  title: screenTitle,
                  order: screenIndex + 1,
                  blocks: normalizeBlocks(
                    screenSource.blocks,
                    screenTitle,
                    `Экран ${screenIndex + 1} раскрывает тему "${input.titleHint}" для аудитории "${input.audience}".`
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
      prompt: toPlainText(questionSource.prompt, `Контрольный вопрос ${questionIndex + 1}`),
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
      `Автоматически созданный курс для аудитории "${input.audience}". Длительность: около ${input.durationMinutes} минут.`
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
      title: toPlainText(outline?.finalTest?.title, "Итоговый тест"),
      questionCount: input.finalTest.questionCount,
      passingScore: input.finalTest.passingScore,
      attemptsLimit: input.finalTest.attemptsLimit,
      maxTimeMinutes: input.finalTest.maxTimeMinutes,
      questions
    }
  };
}
