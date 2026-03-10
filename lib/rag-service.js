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

function toScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(6)) : 0;
}

function normalizeChunkText(value) {
  return `${value || ""}`
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeChunkKey(value) {
  return `${value || ""}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function isLowQualityChunkText(text) {
  const value = `${text || ""}`.trim();
  if (!value) {
    return true;
  }

  const letters = (value.match(/\p{L}/gu) || []).length;
  if (letters < 30) {
    return true;
  }

  const words = value.split(/\s+/).filter(Boolean).length;
  if (words < 8) {
    return true;
  }

  const mojibake = (value.match(/[ÐÑÃ]/g) || []).length;
  if (letters > 0 && (mojibake / letters) > 0.18) {
    return true;
  }

  if (/(?:self-contained|trainingmanagement|microflow|bars?\/buttons?|location_[a-z0-9_]+|\$\[[^\]]+\]|addday\s*\()/i.test(value)) {
    return true;
  }

  return false;
}
function buildChunkIdentity(chunk) {
  const materialId = `${chunk?.materialId || ""}`;
  const chunkId = `${chunk?.chunkId || ""}`;
  if (materialId && chunkId) {
    return `${materialId}:${chunkId}`;
  }

  const order = Number(chunk?.chunkOrder) || 0;
  const key = normalizeChunkKey(chunk?.text || "").slice(0, 220);
  return `${materialId}:${order}:${key}`;
}

function dedupeChunks(chunks) {
  const bestByKey = new Map();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = normalizeChunkText(chunk?.text || "");
    if (!text || isLowQualityChunkText(text)) {
      continue;
    }

    const normalized = {
      ...chunk,
      score: toScore(chunk?.score),
      chunkOrder: Number(chunk?.chunkOrder) || 0,
      text
    };

    const key = buildChunkIdentity(normalized);
    if (!key) {
      continue;
    }

    const current = bestByKey.get(key);
    if (!current || normalized.score > current.score) {
      bestByKey.set(key, normalized);
    }
  }

  return [...bestByKey.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.materialId !== right.materialId) {
      return `${left.materialId || ""}`.localeCompare(`${right.materialId || ""}`);
    }
    return (left.chunkOrder || 0) - (right.chunkOrder || 0);
  });
}

function diversifyChunks(chunks, topK) {
  const source = Array.isArray(chunks) ? [...chunks] : [];
  if (source.length <= topK) {
    return source.slice(0, topK);
  }

  const result = [];
  const usageByMaterial = new Map();

  while (result.length < topK && source.length > 0) {
    let selectedIndex = 0;
    let selectedPenalty = Number.POSITIVE_INFINITY;

    const candidatesToInspect = Math.min(source.length, 18);
    for (let index = 0; index < candidatesToInspect; index += 1) {
      const candidate = source[index];
      const materialUsage = usageByMaterial.get(candidate.materialId) || 0;
      const previous = result[result.length - 1];
      const isNearPrevious = previous
        && previous.materialId === candidate.materialId
        && Math.abs((previous.chunkOrder || 0) - (candidate.chunkOrder || 0)) <= 2;
      const penalty = (materialUsage * 3) + (isNearPrevious ? 2 : 0);

      if (penalty < selectedPenalty) {
        selectedPenalty = penalty;
        selectedIndex = index;
      }
    }

    const [selected] = source.splice(selectedIndex, 1);
    result.push(selected);
    usageByMaterial.set(selected.materialId, (usageByMaterial.get(selected.materialId) || 0) + 1);
  }

  return result;
}

function normalizeRetrievedChunks(chunks, topK) {
  const deduped = dedupeChunks(chunks);
  return diversifyChunks(deduped, topK);
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
      const chunks = normalizeRetrievedChunks(
        qdrantResult.hits.map((hit) => ({
          materialId: hit.materialId,
          fileName: hit.fileName || byId.get(hit.materialId)?.fileName || hit.materialId,
          score: hit.score,
          chunkId: hit.chunk?.id || "",
          chunkOrder: Number(hit.chunk?.order) || 0,
          text: `${hit.chunk?.text || ""}`.trim()
        })),
        normalizedTopK
      );

      return {
        enabled: true,
        topK: normalizedTopK,
        documents,
        chunks,
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

    const chunks = normalizeRetrievedChunks(
      hits.map((hit) => ({
        materialId: hit.materialId,
        fileName: byId.get(hit.materialId)?.fileName || hit.materialId,
        score: hit.score,
        chunkId: hit.chunk?.id || "",
        chunkOrder: Number(hit.chunk?.order) || 0,
        text: `${hit.chunk?.text || ""}`.trim()
      })),
      normalizedTopK
    );

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
