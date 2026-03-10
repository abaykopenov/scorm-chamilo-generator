// ---------------------------------------------------------------------------
// LLM shared utilities: logging, timeouts, networking, error classification
// ---------------------------------------------------------------------------

// ── Error classification ───────────────────────────────────────────────────

export function isEndpointUnreachableError(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  return /endpoint is unreachable|timeout after|fetch failed|aborted|network error/i.test(message);
}

export function shouldFallbackFromChatToGenerate(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  const allowNetworkFallback = ["1", "true", "yes", "on"].includes(
    `${process.env.LOCAL_LLM_FALLBACK_ON_NETWORK_ERROR || "0"}`.trim().toLowerCase()
  );
  return /chat request failed with status (404|405|501)/i.test(message)
    || /chat response is empty/i.test(message)
    || (allowNetworkFallback && isEndpointUnreachableError(error));
}

export function shouldRetryNetworkError(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  return /fetch failed|network error|econnreset|socket hang up|aborted|timeout/i.test(message);
}

export function looksLikeEmbeddingModel(modelName) {
  return /(embed|embedding|bge|e5|mxbai|nomic-embed)/i.test(`${modelName || ""}`);
}

// ── Simple helpers ─────────────────────────────────────────────────────────

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toPlainText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

// ── Logging ────────────────────────────────────────────────────────────────

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

export const LOG_CHARS_MAX = resolveLogChars("LOCAL_LLM_LOG_MAX_CHARS", 1_000_000);
export const LOG_CHARS_PROMPT_PREVIEW = resolveLogChars("LOCAL_LLM_LOG_PROMPT_PREVIEW_CHARS", LOG_CHARS_MAX);
export const LOG_CHARS_RESPONSE_PREVIEW = resolveLogChars("LOCAL_LLM_LOG_RESPONSE_PREVIEW_CHARS", LOG_CHARS_MAX);
const LOG_CHARS_PAYLOAD_PREVIEW = resolveLogChars("LOCAL_LLM_LOG_PAYLOAD_MAX_CHARS", LOG_CHARS_MAX);

export function truncateForLog(value, maxLength = LOG_CHARS_MAX) {
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

export function llmLog(event, payload = {}) {
  if (!isVerboseLlmLogEnabled()) {
    return;
  }
  const safePayload = sanitizeForLog(payload, LOG_CHARS_PAYLOAD_PREVIEW);
  console.log(`[local-llm] ${event}`, safePayload);
}

export function serializePromptUser(userPayload) {
  if (typeof userPayload === "string") {
    return userPayload;
  }
  try {
    return JSON.stringify(userPayload, null, 2);
  } catch {
    return `${userPayload ?? ""}`;
  }
}

export function describePrompt(prompt) {
  const system = `${prompt?.system ?? ""}`;
  const user = serializePromptUser(prompt?.user);
  return {
    systemLength: system.length,
    userLength: user.length,
    systemPreview: truncateForLog(system, LOG_CHARS_PROMPT_PREVIEW),
    userPreview: truncateForLog(user, LOG_CHARS_PROMPT_PREVIEW)
  };
}

export function describeTrace(trace) {
  if (!trace || typeof trace !== "object") {
    return {};
  }
  const keys = ["stage", "phase", "module", "section", "sco", "screen", "attempt"];
  const entries = keys
    .filter((key) => trace[key] !== undefined && trace[key] !== null)
    .map((key) => [key, trace[key]]);
  return Object.fromEntries(entries);
}

// ── Base URL management & round-robin ──────────────────────────────────────

const providerRoundRobinState = new Map();

function parseBaseUrls(raw) {
  return `${raw || ""}`
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/\/$/, ""));
}

export function getConfiguredBaseUrls(config) {
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

export function rotateBaseUrls(baseUrls, key) {
  const list = Array.isArray(baseUrls) ? [...baseUrls] : [];
  if (list.length <= 1) {
    return list;
  }
  const cursor = Number(providerRoundRobinState.get(key) || 0);
  providerRoundRobinState.set(key, cursor + 1);
  const start = ((cursor % list.length) + list.length) % list.length;
  return list.slice(start).concat(list.slice(0, start));
}

// ── Timeout resolution ─────────────────────────────────────────────────────

export function resolveTimeoutMs(meta = {}) {
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

// ── Network fetch with retry ───────────────────────────────────────────────

export async function fetchWithNetworkHint(url, options, label, meta = {}) {
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
