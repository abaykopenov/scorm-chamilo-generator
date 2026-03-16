// ---------------------------------------------------------------------------
// lib/rag/query-decomposer.js — Decompose RAG query into focused sub-queries
// ---------------------------------------------------------------------------
// Takes a broad query (title + goals + audience) and generates focused
// sub-queries that cover different aspects of the topic.
// Uses LLM when available, falls back to rule-based splitting.
// ---------------------------------------------------------------------------

/**
 * Check if query decomposition is enabled.
 */
function isDecompositionEnabled() {
  const raw = `${process.env.RAG_QUERY_DECOMPOSITION ?? "true"}`.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/**
 * Rule-based query decomposition fallback.
 * Splits the input into focused sub-queries based on learning goals and title.
 *
 * @param {object} input - Generation input
 * @returns {string[]} Array of sub-queries
 */
function decomposeByRules(input) {
  const queries = [];
  const title = `${input?.titleHint || ""}`.trim();
  const audience = `${input?.audience || ""}`.trim();
  const goals = Array.isArray(input?.learningGoals) ? input.learningGoals.filter(Boolean) : [];

  // Base query from title
  if (title) {
    queries.push(title);
  }

  // Each learning goal becomes a separate sub-query
  for (const goal of goals.slice(0, 5)) {
    const goalText = `${goal}`.trim();
    if (goalText.length > 5 && !queries.some(q => q.toLowerCase().includes(goalText.toLowerCase().slice(0, 20)))) {
      queries.push(goalText);
    }
  }

  // Add audience-specific query if meaningful
  if (audience && audience.length > 5 && title) {
    queries.push(`${title} для ${audience}`);
  }

  // If we only have one query, try splitting title by common separators
  if (queries.length <= 1 && title) {
    const parts = title.split(/[,;:–—]/).map(p => p.trim()).filter(p => p.length > 5);
    if (parts.length > 1) {
      queries.length = 0;
      queries.push(...parts.slice(0, 4));
    }
  }

  // Ensure at least 2 queries, max 5
  if (queries.length === 0) {
    queries.push(title || "course content");
  }

  return queries.slice(0, 5);
}

/**
 * LLM-based query decomposition.
 * Asks the LLM to generate focused sub-queries for multi-aspect retrieval.
 *
 * @param {object} input - Generation input with provider config
 * @returns {string[]|null} Array of sub-queries or null if LLM unavailable
 */
async function decomposeWithLlm(input) {
  const generation = input?.generation || {};
  if (!generation.provider || generation.provider === "template") return null;

  const title = `${input?.titleHint || ""}`.trim();
  const goals = Array.isArray(input?.learningGoals) ? input.learningGoals.join(", ") : "";
  const language = `${input?.language || "ru"}`.trim().toLowerCase();

  const systemPrompt = language === "en"
    ? `You are a search query optimizer. Given a course topic, generate 3-5 focused sub-queries that together cover all aspects of the topic. Each sub-query should target a different aspect: 1) core concepts/definitions, 2) practical commands/tools, 3) specific examples/use cases, 4) advanced topics. Return ONLY a JSON array of strings. No explanations.`
    : `Ты — оптимизатор поисковых запросов. По теме курса сгенерируй 3-5 фокусных подзапросов, покрывающих разные аспекты темы: 1) базовые понятия/определения, 2) практические команды/инструменты, 3) примеры/кейсы, 4) продвинутые темы. Верни ТОЛЬКО JSON массив строк. Без объяснений.`;

  try {
    const { callProvider } = await import("../llm/providers.js");

    const result = await callProvider(
      {
        provider: generation.provider || "ollama",
        baseUrl: generation.baseUrl || "http://127.0.0.1:11434",
        model: generation.model || "llama3",
        temperature: 0.3
      },
      {
        system: systemPrompt,
        user: JSON.stringify({ topic: title, goals, language })
      },
      { trace: { stage: "query-decomposition" } }
    );

    const text = `${result || ""}`.trim();
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return null;

    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return parsed
      .filter(q => typeof q === "string" && q.trim().length > 3)
      .slice(0, 5);
  } catch (error) {
    console.warn(`[query-decomposer] LLM decomposition failed: ${error?.message || error}`);
    return null;
  }
}

/**
 * Decompose a broad RAG query into focused sub-queries.
 * Tries LLM first, falls back to rule-based splitting.
 *
 * @param {object} input - Generation input
 * @returns {Promise<string[]>} Array of focused sub-queries
 */
export async function decomposeQuery(input) {
  if (!isDecompositionEnabled()) {
    return [buildSingleQuery(input)];
  }

  // Try LLM decomposition
  const llmQueries = await decomposeWithLlm(input);
  if (llmQueries && llmQueries.length >= 2) {
    console.log(`[query-decomposer] 🔍 LLM generated ${llmQueries.length} sub-queries`);
    return llmQueries;
  }

  // Fall back to rule-based
  const ruleQueries = decomposeByRules(input);
  console.log(`[query-decomposer] 🔍 Rule-based: ${ruleQueries.length} sub-queries`);
  return ruleQueries;
}

/**
 * Build a single combined query (original behavior).
 */
function buildSingleQuery(input) {
  const parts = [
    input?.titleHint || "",
    input?.audience || "",
    Array.isArray(input?.learningGoals) ? input.learningGoals.join("\n") : "",
    `${input?.durationMinutes || ""}`,
    input?.language || "ru"
  ].filter(Boolean);
  return parts.join("\n");
}
