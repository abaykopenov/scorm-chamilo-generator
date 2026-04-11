/**
 * RAG Service - Simplified version using only RAG-LLM API
 * All local RAG functionality removed - delegates to external RAG-LLM service
 */

import { retrieveChunks, uploadDocumentFromBuffer } from "./rag-llm-client.js";

function normalizeTopK(value) {
  const parsed = Math.trunc(Number(value) || 12);
  return Math.max(1, Math.min(40, parsed));
}

function toMessage(parts, fallback) {
  const text = parts.filter(Boolean).join(" ").trim();
  return text || fallback;
}

function normalizeChunkText(value) {
  return `${value || ""}`
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    .replace(/(\p{L})\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Build RAG context for a course topic
 * @param {string} topic - Course topic/question
 * @param {Object} options - { topK, collection }
 * @returns {Promise<{context: string, sources: Array, empty: boolean}>}
 */
export async function buildRagContext(topic, options = {}) {
  const topK = normalizeTopK(options.topK || options.top_k);
  const collection = options.collection || "default";

  if (!topic || !topic.trim()) {
    return {
      context: "",
      sources: [],
      empty: true,
      message: "Empty topic provided"
    };
  }

  try {
    const result = await retrieveChunks(topic, { topK, collection });

    if (!result.ok || !result.chunks || result.chunks.length === 0) {
      return {
        context: "",
        sources: [],
        empty: true,
        message: result.message || "No relevant chunks found"
      };
    }

    // Process and clean chunks
    const processedChunks = result.chunks
      .map((chunk, index) => ({
        id: chunk.id || `chunk_${index}`,
        text: normalizeChunkText(chunk.text || ""),
        score: chunk.score || 0,
        documentId: chunk.document_id || "",
        filename: chunk.filename || ""
      }))
      .filter(chunk => chunk.text.length > 30);

    if (processedChunks.length === 0) {
      return {
        context: "",
        sources: [],
        empty: true,
        message: "No valid content found after filtering"
      };
    }

    // Build context string
    const contextParts = processedChunks.map((chunk, i) => {
      const header = `[${i + 1}] ${chunk.filename || "Source"} (relevance: ${(chunk.score * 100).toFixed(0)}%)`;
      return `${header}\n${chunk.text}`;
    });

    const sources = processedChunks.map(chunk => ({
      id: chunk.id,
      filename: chunk.filename,
      documentId: chunk.documentId,
      score: chunk.score
    }));

    return {
      context: contextParts.join("\n\n---\n\n"),
      sources,
      empty: false,
      model: result.model || "rag-llm"
    };
  } catch (error) {
    console.error("[rag-service] Error building context:", error.message);
    return {
      context: "",
      sources: [],
      empty: true,
      message: `RAG error: ${error.message}`
    };
  }
}

/**
 * Check if RAG is available
 * @returns {boolean}
 */
export function isRagAvailable() {
  return true; // RAG-LLM is always assumed available on localhost:8000
}

/**
 * Upload document to RAG-LLM for indexing
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @param {Object} options - { collection }
 * @returns {Promise<{ok: boolean, documentId?: string, chunksCount?: number, message?: string}>}
 */
export async function indexDocument(buffer, filename, options = {}) {
  try {
    const result = await uploadDocumentFromBuffer(buffer, filename, options);
    return result;
  } catch (error) {
    console.error("[rag-service] Error indexing document:", error.message);
    return {
      ok: false,
      message: `Indexing failed: ${error.message}`
    };
  }
}

/**
 * Legacy function for backward compatibility
 * Builds context with fallback message
 */
export async function buildRagContextOrMessage(topic, options = {}, fallbackMessage = null) {
  const result = await buildRagContext(topic, options);
  
  if (result.empty) {
    return {
      context: fallbackMessage || toMessage([result.message, "Релевантные материалы не найдены."], "Нет контекста из материалов."),
      sources: [],
      empty: true,
      message: result.message
    };
  }

  return result;
}

// Default export for compatibility
export default {
  buildRagContext,
  buildRagContextOrMessage,
  isRagAvailable,
  indexDocument
};
