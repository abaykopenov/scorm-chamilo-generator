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
  const allowNetworkFallback = ["1", "true", "yes", "on"].includes(
    `${process.env.LOCAL_LLM_FALLBACK_ON_NETWORK_ERROR || "0"}`.trim().toLowerCase()
  );
  return /chat request failed with status (404|405|501)/i.test(message)
    || /chat response is empty/i.test(message)
    || (allowNetworkFallback && isEndpointUnreachableError(error));
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

function resolveLogChars(envName, fallback) {
  const parsed = Number(process.env[envName]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(256, Math.min(1_000_000, Math.trunc(parsed)));
}

const LOG_CHARS_MAX = resolveLogChars("LOCAL_LLM_LOG_MAX_CHARS", 1_000_000);
const LOG_CHARS_PROMPT_PREVIEW = resolveLogChars("LOCAL_LLM_LOG_PROMPT_PREVIEW_CHARS", LOG_CHARS_MAX);
const LOG_CHARS_RESPONSE_PREVIEW = resolveLogChars("LOCAL_LLM_LOG_RESPONSE_PREVIEW_CHARS", LOG_CHARS_MAX);
const LOG_CHARS_PAYLOAD_PREVIEW = resolveLogChars("LOCAL_LLM_LOG_PAYLOAD_MAX_CHARS", LOG_CHARS_MAX);

function truncateForLog(value, maxLength = LOG_CHARS_MAX) {
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

function sanitizeForLog(value, maxLength = LOG_CHARS_MAX) {
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
  const safePayload = sanitizeForLog(payload, LOG_CHARS_PAYLOAD_PREVIEW);
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
    systemPreview: truncateForLog(system, LOG_CHARS_PROMPT_PREVIEW),
    userPreview: truncateForLog(user, LOG_CHARS_PROMPT_PREVIEW)
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


const providerRoundRobinState = new Map();

function parseBaseUrls(raw) {
  return `${raw || ""}`
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/\/$/, ""));
}

function getConfiguredBaseUrls(config) {
  const explicit = parseBaseUrls(config?.baseUrl);
  const envList = parseBaseUrls(process.env.LOCAL_LLM_BASE_URLS);
  const merged = [...explicit, ...envList].filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const url of merged) {
    const key = url.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(url);
  }
  return unique.length > 0 ? unique : ["http://127.0.0.1:11434"];
}

function rotateBaseUrls(baseUrls, key) {
  const list = Array.isArray(baseUrls) ? [...baseUrls] : [];
  if (list.length <= 1) {
    return list;
  }
  const cursor = Number(providerRoundRobinState.get(key) || 0);
  providerRoundRobinState.set(key, cursor + 1);
  const start = ((cursor % list.length) + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

function resolveTimeoutMs(meta = {}) {
  const configuredTimeout = Number(process.env.LOCAL_LLM_TIMEOUT_MS);
  if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
    return Math.max(3_000, Math.min(900_000, configuredTimeout));
  }

  const stageHint = [meta?.trace?.stage, meta?.trace?.phase, meta?.stage]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const batchTimeout = Number(process.env.LOCAL_LLM_BATCH_TIMEOUT_MS);
  const linePlanTimeout = Number(process.env.LOCAL_LLM_LINEPLAN_TIMEOUT_MS);
  const mainTimeout = Number(process.env.LOCAL_LLM_MAIN_TIMEOUT_MS);
  const writerTimeout = Number(process.env.LOCAL_LLM_WRITER_TIMEOUT_MS);

  if (/writer|critic|test-builder/.test(stageHint)) {
    const value = Number.isFinite(writerTimeout) && writerTimeout > 0 ? writerTimeout : 480_000;
    return Math.max(60_000, Math.min(900_000, value));
  }

  if (/segmented|batch|phase-b/.test(stageHint)) {
    const value = Number.isFinite(batchTimeout) && batchTimeout > 0 ? batchTimeout : 180_000;
    return Math.max(30_000, Math.min(900_000, value));
  }

  if (/lineplan/.test(stageHint)) {
    const value = Number.isFinite(linePlanTimeout) && linePlanTimeout > 0 ? linePlanTimeout : 240_000;
    return Math.max(30_000, Math.min(900_000, value));
  }

  if (/main-outline|outline-main/.test(stageHint)) {
    const value = Number.isFinite(mainTimeout) && mainTimeout > 0 ? mainTimeout : 300_000;
    return Math.max(30_000, Math.min(900_000, value));
  }

  return 180_000;
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
      const topicTitle = String(parts[1] || "").trim();
      const topicText = String(parts[2] || "").trim();
      const bulletText = parts.slice(3).join("|");
      const bullets = bulletText
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3);
      while (bullets.length < 3) {
        bullets.push("Key takeaway " + (bullets.length + 1));
      }
      topics.push({
        title: topicTitle || "Topic " + (topics.length + 1),
        text: topicText || "Topic explanation " + (topics.length + 1) + ".",
        bullets
      });
      continue;
    }
    if (line.startsWith("QUESTION|")) {
      const parts = line.split("|");
      if (parts.length < 8) {
        continue;
      }
      const prompt = String(parts[1] || "").trim();
      const optionTexts = [
        String(parts[2] || "").trim(),
        String(parts[3] || "").trim(),
        String(parts[4] || "").trim(),
        String(parts[5] || "").trim()
      ];
      const parsedIndex = Math.trunc(Number(parts[6])) - 1;
      const correctOptionIndex = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(3, parsedIndex)) : 0;
      const explanation = parts.slice(7).join("|").trim();
      const normalizedOptions = optionTexts.map((option, index) => option || "Option " + (index + 1));

      questions.push({
        prompt: prompt || "Control question " + (questions.length + 1),
        options: normalizedOptions,
        correctOptionIndex,
        explanation: explanation || "Explanation for question " + (questions.length + 1) + "."
      });
    }
  }

  const requiredQuestions = Math.max(1, Number(input?.finalTest?.questionCount || 8));
  while (questions.length < requiredQuestions) {
    questions.push({
      prompt: "Control question " + (questions.length + 1),
      options: ["Option 1", "Option 2", "Option 3", "Option 4"],
      correctOptionIndex: 0,
      explanation: "Explanation for question " + (questions.length + 1) + "."
    });
  }

  if (topics.length === 0) {
    throw new Error("Plan output did not contain TOPIC lines.");
  }

  return {
    title: title || String(input?.titleHint || "Course").trim(),
    description: description || ("Course for audience \"" + String(input?.audience || "learners") + "\"."),
    topics,
    questions: questions.slice(0, requiredQuestions)
  };
}
async function fetchWithNetworkHint(url, options, label, meta = {}) {
  const timeoutMs = resolveTimeoutMs(meta);
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
    const startedAt = Date.now();
    try {
      const response = await fetch(url, requestOptions);
      const durationMs = Date.now() - startedAt;
      llmLog("http.response", {
        label,
        url,
        status: response.status,
        ok: response.ok,
        attempt,
        durationMs,
        ...describeTrace(meta?.trace),
        stage: meta?.stage
      });
      return response;
    } catch (error) {
      lastError = error;
      const durationMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : "unknown network error";
      llmLog("http.error", {
        label,
        url,
        attempt,
        reason,
        durationMs,
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
  const keepAlive = `${process.env.LOCAL_LLM_OLLAMA_KEEP_ALIVE || "20m"}`.trim();
  const trace = describeTrace(options?.trace);
  const promptInfo = describePrompt(prompt);
  const allBaseUrls = getConfiguredBaseUrls(config);
  const rotationKey = `ollama:${config?.model || ""}:${allBaseUrls.join("|")}`;
  const orderedBaseUrls = rotateBaseUrls(allBaseUrls, rotationKey);

  llmLog("provider.nodes", {
    provider: "ollama",
    model: config.model,
    nodes: orderedBaseUrls,
    ...trace
  });

  let lastError = null;
  for (const baseUrl of orderedBaseUrls) {
    const chatUrl = `${baseUrl}/api/chat`;
    llmLog("ollama.chat.request", {
      model: config.model,
      temperature: config.temperature,
      keepAlive,
      jsonFormat: Boolean(options?.format),
      node: baseUrl,
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
          node: baseUrl,
          ...trace,
          bodyPreview: truncateForLog(errorBody, LOG_CHARS_RESPONSE_PREVIEW)
        });
        throw new Error(`Ollama chat request failed with status ${response.status} (${chatUrl})`);
      }
      const payload = await response.json();
      const content = payload?.message?.content ?? "";
      llmLog("ollama.chat.response", {
        status: response.status,
        node: baseUrl,
        ...trace,
        contentLength: content.length,
        contentPreview: truncateForLog(content, LOG_CHARS_RESPONSE_PREVIEW)
      });
      if (content) {
        return content;
      }
      throw new Error("Ollama chat response is empty.");
    } catch (error) {
      lastError = error;
      if (!shouldFallbackFromChatToGenerate(error)) {
        llmLog("ollama.node.error", {
          node: baseUrl,
          reason: error instanceof Error ? error.message : `${error || "unknown error"}`,
          ...trace
        });
        continue;
      }

      const url = `${baseUrl}/api/generate`;
      const jsonMode = options?.jsonMode !== false;
      const promptText = `${prompt.system}\n\n${JSON.stringify(prompt.user, null, 2)}`;
      llmLog("ollama.generate.request", {
        model: config.model,
        temperature: config.temperature,
        keepAlive,
        jsonMode,
        node: baseUrl,
        ...trace,
        promptLength: promptText.length,
        promptPreview: truncateForLog(promptText, LOG_CHARS_PROMPT_PREVIEW)
      });

      try {
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
            node: baseUrl,
            ...trace,
            bodyPreview: truncateForLog(errorBody, LOG_CHARS_RESPONSE_PREVIEW)
          });
          throw new Error(`Ollama request failed with status ${response.status} (${url})`);
        }

        const payload = await response.json();
        const content = payload?.response ?? "";
        llmLog("ollama.generate.response", {
          status: response.status,
          node: baseUrl,
          ...trace,
          contentLength: content.length,
          contentPreview: truncateForLog(content, LOG_CHARS_RESPONSE_PREVIEW)
        });
        if (content) {
          return content;
        }
        throw new Error("Ollama generate response is empty.");
      } catch (generateError) {
        lastError = generateError;
        llmLog("ollama.node.error", {
          node: baseUrl,
          reason: generateError instanceof Error ? generateError.message : `${generateError || "unknown error"}`,
          ...trace
        });
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Ollama call failed on all configured nodes.");
}
async function callOpenAiCompatible(config, prompt, options = {}) {
  const jsonMode = options?.jsonMode !== false;
  const trace = describeTrace(options?.trace);
  const promptInfo = describePrompt(prompt);
  const allBaseUrls = getConfiguredBaseUrls(config);
  const rotationKey = `openai-compatible:${config?.model || ""}:${allBaseUrls.join("|")}`;
  const orderedBaseUrls = rotateBaseUrls(allBaseUrls, rotationKey);

  llmLog("provider.nodes", {
    provider: "openai-compatible",
    model: config.model,
    nodes: orderedBaseUrls,
    ...trace
  });

  let lastError = null;
  for (const baseUrl of orderedBaseUrls) {
    const url = `${baseUrl}/chat/completions`;
    llmLog("openai.request", {
      model: config.model,
      temperature: config.temperature,
      jsonMode,
      node: baseUrl,
      ...trace,
      ...promptInfo
    });

    try {
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
          node: baseUrl,
          ...trace,
          bodyPreview: truncateForLog(errorBody, LOG_CHARS_RESPONSE_PREVIEW)
        });
        throw new Error(`OpenAI-compatible request failed with status ${response.status} (${url})`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content ?? "";
      llmLog("openai.response", {
        status: response.status,
        node: baseUrl,
        ...trace,
        contentLength: content.length,
        contentPreview: truncateForLog(content, LOG_CHARS_RESPONSE_PREVIEW)
      });
      return content;
    } catch (error) {
      lastError = error;
      llmLog("openai.node.error", {
        node: baseUrl,
        reason: error instanceof Error ? error.message : `${error || "unknown error"}`,
        ...trace
      });
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("OpenAI-compatible call failed on all configured nodes.");
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
      message: "Template mode does not require an external LLM connection."
    };
  }

  const baseUrl = getConfiguredBaseUrls(config)[0] || "";
  if (!baseUrl) {
    throw new Error("Base URL for local LLM is required.");
  }

  if (config.provider === "ollama") {
    const tagsUrl = baseUrl + "/api/tags";
    const response = await fetchWithNetworkHint(tagsUrl, undefined, "Ollama");
    if (!response.ok) {
      throw new Error("Ollama check failed with status " + response.status + " (" + tagsUrl + ")");
    }
    const payload = await response.json();
    const names = Array.isArray(payload?.models) ? payload.models.map((model) => model.name).filter(Boolean) : [];
    const hasModel = names.includes(config.model);
    const embeddingWarning = looksLikeEmbeddingModel(config.model)
      ? " Warning: selected model appears to be an embedding model and may not generate course text."
      : "";
    return {
      ok: true,
      provider: "ollama",
      message: hasModel
        ? "Ollama is reachable. Model " + config.model + " is available." + embeddingWarning
        : "Ollama is reachable. Model " + config.model + " is not in local list: " + (names.slice(0, 5).join(", ") || "no models") + "." + embeddingWarning
    };
  }

  const modelsUrl = baseUrl + "/models";
  const response = await fetchWithNetworkHint(modelsUrl, undefined, "OpenAI-compatible");
  if (!response.ok) {
    throw new Error("OpenAI-compatible check failed with status " + response.status + " (" + modelsUrl + ")");
  }
  const payload = await response.json();
  const modelIds = Array.isArray(payload?.data) ? payload.data.map((item) => item.id).filter(Boolean) : [];
  const hasModel = modelIds.includes(config.model);
  const embeddingWarning = looksLikeEmbeddingModel(config.model)
    ? " Warning: selected model appears to be an embedding model and may not generate course text."
    : "";
  return {
    ok: true,
    provider: "openai-compatible",
    message: hasModel
      ? "OpenAI-compatible endpoint is reachable. Model " + config.model + " is available." + embeddingWarning
      : "Endpoint is reachable. Model " + config.model + " not found in list: " + (modelIds.slice(0, 5).join(", ") || "empty") + "." + embeddingWarning
  };
}
function collectOutlineTextBlocks(outline) {
  const blocks = [];
  for (const moduleItem of Array.isArray(outline?.modules) ? outline.modules : []) {
    for (const section of Array.isArray(moduleItem?.sections) ? moduleItem.sections : []) {
      for (const sco of Array.isArray(section?.scos) ? section.scos : []) {
        for (const screen of Array.isArray(sco?.screens) ? sco.screens : []) {
          for (const block of Array.isArray(screen?.blocks) ? screen.blocks : []) {
            if (block?.type === "text" || block?.type === "note") {
              blocks.push(String(block?.text || "").replace(/\s+/g, " ").trim());
            }
          }
        }
      }
    }
  }
  return blocks.filter(Boolean);
}

function validateOutlineJson(parsed, input, validate = {}) {
  const modules = Array.isArray(parsed?.modules) ? parsed.modules : [];
  if (modules.length === 0) {
    return { ok: false, reason: "no-modules" };
  }

  const expectedModules = Number(validate?.expectedModules);
  if (Number.isFinite(expectedModules) && expectedModules > 0 && modules.length !== expectedModules) {
    return { ok: false, reason: "expected-modules-" + expectedModules + "-got-" + modules.length };
  }

  const firstSections = Array.isArray(modules?.[0]?.sections) ? modules[0].sections : [];
  const expectedSections = Number(validate?.expectedSections);
  if (Number.isFinite(expectedSections) && expectedSections > 0 && firstSections.length !== expectedSections) {
    return { ok: false, reason: "expected-sections-" + expectedSections + "-got-" + firstSections.length };
  }

  const firstScos = Array.isArray(firstSections?.[0]?.scos) ? firstSections[0].scos : [];
  const expectedScos = Number(validate?.expectedScos);
  if (Number.isFinite(expectedScos) && expectedScos > 0 && firstScos.length !== expectedScos) {
    return { ok: false, reason: "expected-scos-" + expectedScos + "-got-" + firstScos.length };
  }

  const firstScreens = Array.isArray(firstScos?.[0]?.screens) ? firstScos[0].screens : [];
  const expectedScreens = Number(validate?.expectedScreens);
  if (Number.isFinite(expectedScreens) && expectedScreens > 0 && firstScreens.length !== expectedScreens) {
    return { ok: false, reason: "expected-screens-" + expectedScreens + "-got-" + firstScreens.length };
  }

  const textBlocks = collectOutlineTextBlocks(parsed);
  if (textBlocks.length === 0) {
    return { ok: false, reason: "no-text-blocks" };
  }

  const placeholderPattern = /(?:\u043a\u043e\u043d\u0442\u0435\u043d\u0442\s+\u044d\u043a\u0440\u0430\u043d\u0430|\u0442\u0435\u043a\u0443\u0449\u0430\u044f\s+\u0442\u0435\u043c\u0430|\u043a\u043b\u044e\u0447\u0435\u0432\u043e\u0439\s+\u0442\u0435\u0437\u0438\u0441|screen\s*\d+|topic\s*\d+|module\s*\d+|sco\s*\d+|we need to generate json|json object only|focus\s+for\s+audience)/i;
  const placeholderCount = textBlocks.filter((text) => placeholderPattern.test(text)).length;
  const placeholderRatio = placeholderCount / textBlocks.length;
  const maxPlaceholderRatio = Number.isFinite(Number(validate?.maxPlaceholderRatio))
    ? Number(validate.maxPlaceholderRatio)
    : 0.12;
  if (placeholderRatio > maxPlaceholderRatio) {
    return { ok: false, reason: "placeholder-ratio-" + placeholderRatio.toFixed(3) };
  }

  const avgTextLength = textBlocks.reduce((sum, text) => sum + text.length, 0) / textBlocks.length;
  const minAvgTextLength = Number.isFinite(Number(validate?.minAvgTextLength))
    ? Number(validate.minAvgTextLength)
    : 120;
  if (avgTextLength < minAvgTextLength) {
    return { ok: false, reason: "avg-text-too-short-" + Math.round(avgTextLength) };
  }

  const unique = new Set(textBlocks.map((text) => text.toLowerCase()));
  const uniqueRatio = unique.size / textBlocks.length;
  const minUniqueRatio = Number.isFinite(Number(validate?.minUniqueRatio))
    ? Number(validate.minUniqueRatio)
    : (textBlocks.length >= 8 ? 0.7 : 0.55);
  if (uniqueRatio < minUniqueRatio) {
    return { ok: false, reason: "low-unique-ratio-" + uniqueRatio.toFixed(3) };
  }

  if (String(input?.language || "").toLowerCase().startsWith("ru")) {
    const joined = textBlocks.join(" ");
    const letters = (joined.match(/\p{L}/gu) || []).length;
    const cyr = (joined.match(/[\u0400-\u04FF]/g) || []).length;
    const cyrRatio = letters > 0 ? cyr / letters : 0;
    if (letters > 120 && cyrRatio < 0.2) {
      return { ok: false, reason: "low-cyrillic-ratio-" + cyrRatio.toFixed(3) };
    }
  }

  return {
    ok: true,
    reason: "",
    stats: {
      textBlocks: textBlocks.length,
      avgTextLength: Math.round(avgTextLength),
      uniqueRatio: Number(uniqueRatio.toFixed(3)),
      placeholderRatio: Number(placeholderRatio.toFixed(3))
    }
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

