/**
 * RAG-LLM API Client
 * Connects scorm-chamilo-generator to rag-llm service for document indexing and retrieval.
 */

const RAG_LLM_BASE = process.env.RAG_LLM_URL || "http://127.0.0.1:8000";

/**
 * Sync check: is RAG-LLM integration enabled?
 * Returns true if RAG_LLM_URL env var is set OR default localhost is assumed.
 */
export function isRagLlmEnabled() {
  // Always enabled — rag-llm runs on localhost:8000 by default
  return true;
}

/**
 * Upload a document (PDF/DOCX) to rag-llm for indexing.
 */
export async function uploadDocumentToRag(filePath, filename) {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);

  const formData = new FormData();
  formData.append("file", blob, filename || path.basename(filePath));

  const res = await fetch(`${RAG_LLM_BASE}/api/upload`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RAG upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log("[rag-llm] Document uploaded:", {
    documentId: data.document_id || data.id,
    filename,
    chunks: data.chunk_count || data.chunks,
  });
  return {
    documentId: data.document_id || data.id,
    status: data.status || "indexed",
    chunkCount: data.chunk_count || data.chunks || 0,
  };
}

/**
 * Upload a document from buffer to rag-llm.
 * @param {Buffer} buffer - file content
 * @param {string} filename - original filename
 * @param {object} options - { collection }
 * @returns {{ ok, documentId, chunksCount, pagesCount }}
 */
export async function uploadDocumentFromBuffer(buffer, filename, options = {}) {
  try {
    const blob = new Blob([buffer]);
    const formData = new FormData();
    formData.append("file", blob, filename);
    if (options.collection) {
      formData.append("collection", options.collection);
    }

    const res = await fetch(`${RAG_LLM_BASE}/api/upload`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, message: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json();
    return {
      ok: true,
      documentId: data.document_id || data.id,
      chunksCount: data.chunks_count || data.chunk_count || 0,
      pagesCount: data.pages_count || 0,
      summary: data.summary || "",
    };
  } catch (err) {
    return { ok: false, message: err?.message || "upload failed" };
  }
}

/**
 * Retrieve relevant chunks from rag-llm.
 * Returns { ok, chunks, message, model } — format expected by rag-service.js
 */
export async function retrieveChunks(query, options = {}) {
  const { topK = 10, collection = "default" } = options;

  try {
    const res = await fetch(`${RAG_LLM_BASE}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: query, top_k: topK, collection }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return { ok: false, chunks: [], message: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const results = Array.isArray(data) ? data : (data.results || data.chunks || []);

    const chunks = results.map((r, i) => ({
      id: r.chunk_id || r.id || `chunk_${i}`,
      text: r.text || r.content || r.page_content || "",
      score: r.score || r.relevance_score || 1 - i * 0.05,
      document_id: r.document_id || r.metadata?.document_id || "",
      filename: r.filename || r.metadata?.filename || "",
    }));

    return {
      ok: true,
      chunks,
      model: data.model || "rag-llm",
      message: "",
    };
  } catch (err) {
    return {
      ok: false,
      chunks: [],
      message: `RAG-LLM error: ${err?.message || "connection failed"}`,
    };
  }
}

/**
 * Get ALL chunks for a document (full text in order).
 */
export async function getAllDocumentChunks(documentId) {
  try {
    const res = await fetch(`${RAG_LLM_BASE}/api/documents/${documentId}/chunks`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const chunks = Array.isArray(data) ? data : (data.chunks || []);
    return chunks.map((c, i) => ({
      text: c.text || c.content || c.page_content || "",
      order: c.order || c.index || i,
      chunkId: c.chunk_id || c.id || `chunk_${i}`,
      materialId: documentId,
    }));
  } catch {
    return [];
  }
}

/**
 * Check if rag-llm service is available (async health check).
 */
export async function isRagLlmAvailable() {
  try {
    const res = await fetch(`${RAG_LLM_BASE}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
