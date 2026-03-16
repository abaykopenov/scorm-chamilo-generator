// ---------------------------------------------------------------------------
// lib/rag/reranker.js — Re-rank retrieved chunks using LLM cross-attention
// ---------------------------------------------------------------------------
// Two-phase retrieval: Qdrant returns top-N candidates, then LLM re-ranks
// them by actual relevance to the specific screen topic.
// Falls back to original ranking if LLM is unavailable.
// ---------------------------------------------------------------------------

/**
 * Check if re-ranking is enabled.
 */
function isRerankEnabled() {
  const raw = `${process.env.RAG_RERANK_ENABLED ?? "true"}`.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/**
 * Re-rank chunks using LLM-based relevance scoring.
 * Sends chunk excerpts + query to LLM, gets relevance scores back.
 *
 * @param {object} input - Generation input with provider config
 * @param {string} query - The search query / screen topic
 * @param {Array} chunks - Retrieved chunks to re-rank
 * @param {number} topK - Number of chunks to return after re-ranking
 * @returns {Promise<Array>} Re-ranked chunks (top-K)
 */
export async function rerankChunks(input, query, chunks, topK) {
  if (!isRerankEnabled()) return chunks.slice(0, topK);
  if (!Array.isArray(chunks) || chunks.length <= topK) return chunks;

  const generation = input?.generation || {};
  if (!generation.provider || generation.provider === "template") {
    return chunks.slice(0, topK);
  }

  // Only re-rank if we have more candidates than needed
  const candidates = chunks.slice(0, Math.min(chunks.length, topK * 3));
  if (candidates.length <= topK) return candidates;

  try {
    const scored = await scoreWithLlm(generation, query, candidates);
    if (!scored) return chunks.slice(0, topK);

    // Sort by LLM relevance score descending
    const reranked = scored
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, topK)
      .map(({ rerankScore, ...chunk }) => chunk);

    console.log(`[reranker] ✅ Re-ranked ${candidates.length} → ${reranked.length} chunks`);
    return reranked;
  } catch (error) {
    console.warn(`[reranker] Failed, using original ranking: ${error?.message || error}`);
    return chunks.slice(0, topK);
  }
}

/**
 * Score chunks using LLM for relevance to the query.
 * Returns chunks with added rerankScore field.
 */
async function scoreWithLlm(generation, query, candidates) {
  const language = "ru"; // Default

  const systemPrompt = `You are a relevance judge. For each text chunk, rate its relevance to the query on a scale 0-10.
Return ONLY a JSON array of objects: [{"index": 0, "score": 8}, {"index": 1, "score": 3}, ...]
Score 0 = completely irrelevant, 10 = perfectly answers the query.
Consider: topical match, specificity, information density, presence of definitions/examples/commands.
Return ONLY valid JSON, no explanations.`;

  const chunkSummaries = candidates.map((c, i) => ({
    index: i,
    excerpt: `${c.text || ""}`.slice(0, 200)
  }));

  try {
    const { callProvider } = await import("../llm/providers.js");

    const result = await callProvider(
      {
        provider: generation.provider || "ollama",
        baseUrl: generation.baseUrl || "http://127.0.0.1:11434",
        model: generation.model || "llama3",
        temperature: 0.1
      },
      {
        system: systemPrompt,
        user: JSON.stringify({
          query: `${query}`.slice(0, 300),
          chunks: chunkSummaries
        })
      },
      { trace: { stage: "reranker" } }
    );

    const text = `${result || ""}`.trim();
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return null;

    const scores = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(scores)) return null;

    // Merge scores with candidates
    return candidates.map((chunk, i) => {
      const scoreEntry = scores.find(s => s.index === i);
      const llmScore = scoreEntry ? Number(scoreEntry.score) || 0 : 5;
      // Combine original score (60%) with LLM score (40%)
      const originalScore = chunk.score || 0;
      const normalizedLlmScore = llmScore / 10; // 0-1 scale
      const combinedScore = (originalScore * 0.6) + (normalizedLlmScore * 0.4);

      return {
        ...chunk,
        score: Number(combinedScore.toFixed(6)),
        rerankScore: combinedScore
      };
    });
  } catch (error) {
    console.warn(`[reranker] LLM scoring failed: ${error?.message || error}`);
    return null;
  }
}
