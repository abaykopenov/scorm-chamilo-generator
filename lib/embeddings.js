function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding)) {
    throw new Error("Embedding response does not contain a vector array.");
  }

  const vector = embedding.map((value) => Number(value));
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding vector is invalid.");
  }
  return vector;
}

function trimBaseUrl(baseUrl) {
  return `${baseUrl || ""}`.trim().replace(/\/$/, "");
}

function isModelNotFoundError(error) {
  const message = error instanceof Error ? error.message : `${error || ""}`;
  return /model\s+"?[^"]+"?\s+not\s+found/i.test(message);
}

async function listOllamaModelNames(baseUrl) {
  const url = `${baseUrl}/api/tags`;
  const response = await fetch(url);
  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  return Array.isArray(payload?.models)
    ? payload.models.map((item) => `${item?.name || ""}`.trim()).filter(Boolean)
    : [];
}

export function suggestOllamaModelName(requestedModel, modelNames) {
  const requested = `${requestedModel || ""}`.trim().toLowerCase();
  const names = Array.isArray(modelNames) ? modelNames.filter(Boolean) : [];
  if (!requested || names.length === 0) {
    return "";
  }

  const exact = names.find((name) => name.toLowerCase() === requested);
  if (exact) {
    return exact;
  }

  // Most common case: user typed model without a tag, while Ollama has "<name>:<tag>".
  const withTag = names.find((name) => name.toLowerCase().startsWith(`${requested}:`));
  if (withTag) {
    return withTag;
  }

  const contains = names.find((name) => name.toLowerCase().includes(requested));
  if (contains) {
    return contains;
  }

  return "";
}

async function requestJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown network error";
    throw new Error(`Cannot reach embedding endpoint ${url}. ${reason}`);
  }

  if (!response.ok) {
    const payloadText = await response.text().catch(() => "");
    const message = payloadText ? `: ${payloadText.slice(0, 200)}` : "";
    throw new Error(`Embedding request failed with status ${response.status}${message}`);
  }

  return response.json();
}

async function callOllamaEmbeddings(config, text) {
  const baseUrl = trimBaseUrl(config.baseUrl);
  if (!baseUrl) {
    throw new Error("Embedding base URL is required for Ollama.");
  }

  async function requestWithModel(modelName) {
    // Support both Ollama APIs: legacy /api/embeddings and modern /api/embed.
    try {
      const payload = await requestJson(`${baseUrl}/api/embeddings`, {
        model: modelName,
        prompt: text
      });
      return normalizeEmbedding(payload?.embedding);
    } catch (legacyError) {
      const payload = await requestJson(`${baseUrl}/api/embed`, {
        model: modelName,
        input: text
      });

      if (Array.isArray(payload?.embedding)) {
        return normalizeEmbedding(payload.embedding);
      }
      if (Array.isArray(payload?.embeddings) && Array.isArray(payload.embeddings[0])) {
        return normalizeEmbedding(payload.embeddings[0]);
      }
      throw legacyError;
    }
  }

  try {
    return await requestWithModel(config.model);
  } catch (error) {
    if (!isModelNotFoundError(error)) {
      throw error;
    }

    let modelNames = [];
    try {
      modelNames = await listOllamaModelNames(baseUrl);
    } catch {}

    const suggested = suggestOllamaModelName(config.model, modelNames);
    if (suggested && suggested !== config.model) {
      try {
        return await requestWithModel(suggested);
      } catch {}
    }

    const sampleNames = modelNames.slice(0, 8);
    const embedSamples = modelNames.filter((name) => /(embed|embedding|bge|e5|nomic)/i.test(name)).slice(0, 5);
    const listPart = (embedSamples.length > 0 ? embedSamples : sampleNames).join(", ");
    const suggestionPart = suggested ? ` Попробуйте модель "${suggested}".` : "";
    const availablePart = listPart ? ` Доступные модели: ${listPart}.` : "";
    throw new Error(
      `Embedding model "${config.model}" not found on Ollama (${baseUrl}).${suggestionPart}${availablePart}`
    );
  }
}

async function callOpenAiCompatibleEmbeddings(config, texts) {
  const baseUrl = trimBaseUrl(config.baseUrl);
  if (!baseUrl) {
    throw new Error("Embedding base URL is required for OpenAI-compatible endpoint.");
  }

  const payload = await requestJson(`${baseUrl}/embeddings`, {
    model: config.model,
    input: texts
  });

  const vectors = Array.isArray(payload?.data)
    ? payload.data
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((item) => normalizeEmbedding(item.embedding))
    : [];

  if (vectors.length !== texts.length) {
    throw new Error("Embedding endpoint returned unexpected vector count.");
  }

  return vectors;
}

export async function embedTexts(config, texts) {
  const normalizedTexts = Array.isArray(texts)
    ? texts.map((value) => `${value || ""}`.trim()).filter(Boolean)
    : [];

  if (normalizedTexts.length === 0) {
    return [];
  }

  if (!config || !config.provider || config.provider === "template") {
    throw new Error("Embedding provider must be configured.");
  }

  if (config.provider === "openai-compatible") {
    return callOpenAiCompatibleEmbeddings(config, normalizedTexts);
  }

  const vectors = [];
  for (const text of normalizedTexts) {
    const vector = await callOllamaEmbeddings(config, text);
    vectors.push(vector);
  }
  return vectors;
}
