import { chunkText } from "./chunker.js";
import { parseDocumentText } from "./document-parser.js";
import { embedTexts } from "./embeddings.js";
import {
  getMaterial,
  getMaterialVectors,
  listMaterials,
  readMaterialFile,
  saveMaterialChunks,
  saveMaterialVectors,
  updateMaterial
} from "./material-store.js";

const MAX_INDEX_CHUNKS = 300;

function normalizeChunking(chunking) {
  return {
    maxChars: Number(chunking?.maxChars) || 1000,
    overlapChars: Number(chunking?.overlapChars) || 180,
    minChars: Number(chunking?.minChars) || 160
  };
}

function normalizeEmbeddingConfig(embedding) {
  const provider = ["ollama", "openai-compatible"].includes(embedding?.provider)
    ? embedding.provider
    : "ollama";

  return {
    provider,
    baseUrl: `${embedding?.baseUrl || ""}`.trim() || "http://127.0.0.1:11434",
    model: `${embedding?.model || ""}`.trim() || "nomic-embed-text"
  };
}

async function buildVectorsForChunks(chunks, embedding, embedder) {
  const texts = chunks.map((chunk) => chunk.text);
  if (texts.length === 0) {
    return [];
  }

  if (typeof embedder === "function") {
    return embedder(texts, embedding);
  }

  return embedTexts(embedding, texts);
}

export async function indexMaterialDocument(materialId, options = {}) {
  const materialFile = await readMaterialFile(materialId);
  if (!materialFile) {
    throw new Error(`Material ${materialId} was not found.`);
  }

  const chunking = normalizeChunking(options.chunking);
  const embedding = normalizeEmbeddingConfig(options.embedding);

  try {
    const text = parseDocumentText({
      fileName: materialFile.material.fileName,
      mimeType: materialFile.material.mimeType,
      buffer: materialFile.buffer
    });
    const chunks = chunkText(text, chunking);
    const selectedChunks = chunks.slice(0, MAX_INDEX_CHUNKS);
    const vectors = await buildVectorsForChunks(selectedChunks, embedding, options.embedder);

    if (vectors.length !== selectedChunks.length) {
      throw new Error("Embedding vector count does not match chunk count.");
    }

    await Promise.all([
      saveMaterialChunks(materialId, selectedChunks),
      saveMaterialVectors(materialId, {
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        vectors,
        chunks: selectedChunks
      }),
      updateMaterial(materialId, {
        status: "indexed",
        chunksCount: selectedChunks.length,
        embeddingProvider: embedding.provider,
        embeddingModel: embedding.model,
        errorMessage: ""
      })
    ]);

    return {
      ok: true,
      materialId,
      chunksCount: selectedChunks.length,
      totalChunks: chunks.length,
      chunkLimitApplied: chunks.length > selectedChunks.length,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model
    };
  } catch (error) {
    await updateMaterial(materialId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Indexing failed"
    });

    return {
      ok: false,
      materialId,
      message: error instanceof Error ? error.message : "Indexing failed"
    };
  }
}

export async function indexMaterials(materialIds, options = {}) {
  const ids = Array.isArray(materialIds) && materialIds.length > 0
    ? materialIds.filter(Boolean)
    : (await listMaterials()).map((material) => material.id);

  const results = [];
  for (const materialId of ids) {
    results.push(await indexMaterialDocument(materialId, options));
  }

  return {
    total: ids.length,
    indexed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
}

export async function getIndexedMaterialSummary(materialIds) {
  const ids = Array.isArray(materialIds) ? materialIds.filter(Boolean) : [];
  if (ids.length === 0) {
    return [];
  }

  const records = await Promise.all(ids.map((id) => Promise.all([getMaterial(id), getMaterialVectors(id)])));
  return records
    .map(([material, vectors]) => {
      if (!material || !vectors) {
        return null;
      }
      return {
        id: material.id,
        fileName: material.fileName,
        status: material.status,
        chunksCount: material.chunksCount
      };
    })
    .filter(Boolean);
}
