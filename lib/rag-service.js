import { embedTexts } from "./embeddings.js";
import { searchMaterialChunksInQdrant } from "./langchain-qdrant.js";
import { getMaterial, listMaterialVectorRecords } from "./material-store.js";
import { searchVectorRecords } from "./vector-search.js";

function normalizeTopK(value) {
  const parsed = Math.trunc(Number(value) || 6);
  return Math.max(1, Math.min(30, parsed));
}

function toMessage(parts, fallback) {
  const text = parts.filter(Boolean).join(" ").trim();
  return text || fallback;
}

export function buildRagQueryFromInput(input) {
  const parts = [
    input?.titleHint || "",
    input?.audience || "",
    Array.isArray(input?.learningGoals) ? input.learningGoals.join("\n") : "",
    `${input?.durationMinutes || ""}`,
    input?.language || "ru"
  ].filter(Boolean);

  return parts.join("\n");
}

export async function buildRagContext(input) {
  const rag = input?.rag;
  const documentIds = Array.isArray(rag?.documentIds) ? rag.documentIds.filter(Boolean) : [];
  if (!rag?.enabled || documentIds.length === 0) {
    return {
      enabled: false,
      topK: 0,
      documents: [],
      chunks: [],
      query: "",
      message: "RAG disabled or no materials selected."
    };
  }

  const normalizedTopK = normalizeTopK(rag.topK);

  try {
    const materials = await Promise.all(documentIds.map((id) => getMaterial(id)));
    const byId = new Map(materials.filter(Boolean).map((material) => [material.id, material]));
    const documents = documentIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((material) => ({
        id: material.id,
        fileName: material.fileName,
        status: material.status
      }));

    const query = buildRagQueryFromInput(input);
    const retrievalMessages = [];

    const qdrantResult = await searchMaterialChunksInQdrant({
      documentIds,
      query,
      topK: normalizedTopK,
      embedding: rag.embedding
    });

    if (qdrantResult.ok && Array.isArray(qdrantResult.hits) && qdrantResult.hits.length > 0) {
      return {
        enabled: true,
        topK: normalizedTopK,
        documents,
        chunks: qdrantResult.hits.map((hit) => ({
          materialId: hit.materialId,
          fileName: hit.fileName || byId.get(hit.materialId)?.fileName || hit.materialId,
          score: Number(hit.score.toFixed(6)),
          chunkId: hit.chunk?.id || "",
          chunkOrder: Number(hit.chunk?.order) || 0,
          text: `${hit.chunk?.text || ""}`.trim()
        })),
        query,
        message: ""
      };
    }

    if (!qdrantResult.ok && !qdrantResult.skipped) {
      retrievalMessages.push(`Qdrant retrieval failed: ${qdrantResult.message || "unknown error"}.`);
    }

    const records = await listMaterialVectorRecords(documentIds);
    if (records.length === 0) {
      return {
        enabled: true,
        topK: normalizedTopK,
        documents,
        chunks: [],
        query,
        message: toMessage(retrievalMessages, "No indexed vectors found for selected materials.")
      };
    }

    const queryVector = (await embedTexts(rag.embedding, [query]))[0];
    const hits = searchVectorRecords({
      records,
      queryVector,
      topK: normalizedTopK
    });

    const chunks = hits.map((hit) => ({
      materialId: hit.materialId,
      fileName: byId.get(hit.materialId)?.fileName || hit.materialId,
      score: Number(hit.score.toFixed(6)),
      chunkId: hit.chunk?.id || "",
      chunkOrder: Number(hit.chunk?.order) || 0,
      text: `${hit.chunk?.text || ""}`.trim()
    }));

    return {
      enabled: true,
      topK: normalizedTopK,
      documents,
      chunks,
      query,
      message: chunks.length > 0
        ? toMessage(retrievalMessages, "")
        : toMessage(retrievalMessages, "No relevant chunks were retrieved.")
    };
  } catch (error) {
    return {
      enabled: true,
      topK: normalizedTopK,
      documents: [],
      chunks: [],
      query: "",
      message: error instanceof Error ? error.message : "RAG retrieval failed."
    };
  }
}
