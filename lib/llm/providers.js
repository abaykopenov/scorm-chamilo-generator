// ---------------------------------------------------------------------------
// LLM Providers: Ollama and OpenAI-compatible
// ---------------------------------------------------------------------------
import {
  describePrompt,
  describeTrace,
  fetchWithNetworkHint,
  getConfiguredBaseUrls,
  llmLog,
  LOG_CHARS_PROMPT_PREVIEW,
  LOG_CHARS_RESPONSE_PREVIEW,
  looksLikeEmbeddingModel,
  rotateBaseUrls,
  shouldFallbackFromChatToGenerate,
  truncateForLog
} from "./utils.js";

// ── Ollama provider ────────────────────────────────────────────────────────

export async function callOllama(config, prompt, options = {}) {
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

// ── OpenAI-compatible provider ─────────────────────────────────────────────

export async function callOpenAiCompatible(config, prompt, options = {}) {
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
      hasApiKey: Boolean(config.apiKey),
      apiKeyPrefix: config.apiKey ? config.apiKey.slice(0, 8) + "..." : "(none)",
      ...trace,
      ...promptInfo
    });

    try {
      const extraHeaders = options?.extraHeaders || {};
      const response = await fetchWithNetworkHint(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
          ...extraHeaders,
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

// ── Provider dispatcher ────────────────────────────────────────────────────

export async function callProvider(config, prompt, options = {}) {
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

// ── Connection check ───────────────────────────────────────────────────────

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
