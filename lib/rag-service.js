import { embedTexts } from "./embeddings.js";
import { getMaterial, listMaterialVectorRecords } from "./material-store.js";
import { searchVectorRecords } from "./vector-search.js";

function normalizeTopK(value) {
  const parsed = Math.trunc(Number(value) || 6);
  return Math.max(1, Math.min(30, parsed));
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

  try {
    const records = await listMaterialVectorRecords(documentIds);
    if (records.length === 0) {
      return {
        enabled: true,
        topK: normalizeTopK(rag.topK),
        documents: [],
        chunks: [],
        query: "",
        message: "No indexed vectors found for selected materials."
      };
    }

    const query = buildRagQueryFromInput(input);
    const queryVector = (await embedTexts(rag.embedding, [query]))[0];
    const hits = searchVectorRecords({
      records,
      queryVector,
      topK: rag.topK
    });

    const materials = await Promise.all(documentIds.map((id) => getMaterial(id)));
    const byId = new Map(materials.filter(Boolean).map((material) => [material.id, material]));
    const chunks = hits.map((hit) => ({
      materialId: hit.materialId,
      fileName: byId.get(hit.materialId)?.fileName || hit.materialId,
      score: Number(hit.score.toFixed(6)),
      chunkId: hit.chunk?.id || "",
      text: `${hit.chunk?.text || ""}`.trim()
    }));

    const documents = documentIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((material) => ({
        id: material.id,
        fileName: material.fileName,
        status: material.status
      }));

    return {
      enabled: true,
      topK: normalizeTopK(rag.topK),
      documents,
      chunks,
      query,
      message: chunks.length > 0 ? "" : "No relevant chunks were retrieved."
    };
  } catch (error) {
    return {
      enabled: true,
      topK: normalizeTopK(rag.topK),
      documents: [],
      chunks: [],
      query: "",
      message: error instanceof Error ? error.message : "RAG retrieval failed."
    };
  }
}
