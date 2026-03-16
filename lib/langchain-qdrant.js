import { Document } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import { embedTexts } from "./embeddings.js";

const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";
const DEFAULT_QDRANT_COLLECTION = "scorm_material_chunks";
const DEFAULT_EMBEDDING_CONFIG = {
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "nomic-embed-text"
};

function toText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function toBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = `${value}`.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeEmbeddingConfig(config) {
  const provider = config?.provider === "openai-compatible" ? "openai-compatible" : "ollama";
  return {
    provider,
    baseUrl: toText(config?.baseUrl, DEFAULT_EMBEDDING_CONFIG.baseUrl),
    model: toText(config?.model, DEFAULT_EMBEDDING_CONFIG.model)
  };
}

function getQdrantSettings() {
  const url = toText(process.env.QDRANT_URL, DEFAULT_QDRANT_URL);
  const enabled = toBoolean(process.env.QDRANT_ENABLED, true);

  return {
    enabled,
    url,
    apiKey: toText(process.env.QDRANT_API_KEY, ""),
    collectionName: toText(process.env.QDRANT_COLLECTION, DEFAULT_QDRANT_COLLECTION)
  };
}

class ScormEmbeddings extends Embeddings {
  constructor(config) {
    super({});
    this.config = normalizeEmbeddingConfig(config);
  }

  async embedDocuments(texts) {
    return embedTexts(this.config, texts);
  }

  async embedQuery(text) {
    const vectors = await embedTexts(this.config, [text]);
    return Array.isArray(vectors) && Array.isArray(vectors[0]) ? vectors[0] : [];
  }
}

function buildChunkKey(materialId, chunk, index) {
  const rawChunkId = `${chunk?.id || chunk?.order || index + 1}`.replace(/[^a-zA-Z0-9_.:-]+/g, "_");
  return `${materialId}:${rawChunkId}`;
}

function toDeterministicUuid(seed) {
  const hash = createHash("sha1").update(seed).digest("hex").slice(0, 32);
  const bytes = Buffer.from(hash, "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildPointId(materialId, chunk, index) {
  return toDeterministicUuid(buildChunkKey(materialId, chunk, index));
}

function createQdrantClient(settings) {
  return new QdrantClient({
    url: settings.url,
    apiKey: settings.apiKey || undefined,
    checkCompatibility: false
  });
}

function buildStoreArgs(settings, collectionConfig = undefined) {
  const args = {
    client: createQdrantClient(settings),
    url: settings.url,
    collectionName: settings.collectionName
  };

  if (settings.apiKey) {
    args.apiKey = settings.apiKey;
  }
  if (collectionConfig) {
    args.collectionConfig = collectionConfig;
  }

  return args;
}

function toQdrantError(error, fallback) {
  return error instanceof Error && error.message
    ? error.message
    : fallback;
}

function extractNotFoundMessage(error) {
  const message = toQdrantError(error, "");
  return /not found|does not exist|404/i.test(message);
}

export function getQdrantRuntimeConfig() {
  return getQdrantSettings();
}

export function isQdrantEnabled() {
  return getQdrantSettings().enabled;
}

export async function upsertMaterialChunksToQdrant({ material, chunks, vectors, embedding }) {
  const settings = getQdrantSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      skipped: true,
      message: "Qdrant is disabled (QDRANT_ENABLED=false)."
    };
  }

  if (!material?.id) {
    throw new Error("material.id is required for Qdrant upsert.");
  }

  if (!Array.isArray(chunks) || !Array.isArray(vectors) || chunks.length !== vectors.length) {
    throw new Error("Chunks and vectors are required and must have the same length.");
  }

  if (chunks.length === 0) {
    return {
      ok: true,
      skipped: true,
      indexed: 0,
      message: "No chunks to upsert."
    };
  }

  const vectorSize = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  if (!Number.isFinite(vectorSize) || vectorSize <= 0) {
    throw new Error("Invalid vector size for Qdrant upsert.");
  }

  const embeddings = new ScormEmbeddings(embedding);
  const store = new QdrantVectorStore(
    embeddings,
    buildStoreArgs(settings, {
      vectors: {
        size: vectorSize,
        distance: "Cosine"
      }
    })
  );

  const docs = chunks.map((chunk, index) => {
    const chunkId = buildChunkKey(material.id, chunk, index);
    const pointId = buildPointId(material.id, chunk, index);
    return new Document({
      id: pointId,
      pageContent: `${chunk?.text || ""}`,
      metadata: {
        materialId: material.id,
        fileName: material.fileName || material.id,
        chunkId,
        pointId,
        chunkOrder: Number(chunk?.order) || index + 1
      }
    });
  });

  try {
    try {
      await store.delete({
        filter: {
          must: [
            {
              key: "metadata.materialId",
              match: {
                value: material.id
              }
            }
          ]
        }
      });
    } catch (deleteError) {
      if (!extractNotFoundMessage(deleteError)) {
        throw deleteError;
      }
    }

    await store.addVectors(vectors, docs, {
      ids: docs.map((doc) => `${doc.id}`)
    });

    return {
      ok: true,
      skipped: false,
      indexed: docs.length,
      collectionName: settings.collectionName,
      url: settings.url
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      message: toQdrantError(error, "Qdrant upsert failed."),
      collectionName: settings.collectionName,
      url: settings.url
    };
  }
}

export async function searchMaterialChunksInQdrant({ documentIds, query, topK, embedding }) {
  const settings = getQdrantSettings();
  const ids = Array.isArray(documentIds) ? documentIds.filter(Boolean) : [];

  if (!settings.enabled) {
    return {
      ok: false,
      skipped: true,
      hits: [],
      message: "Qdrant is disabled (QDRANT_ENABLED=false)."
    };
  }

  if (!query || ids.length === 0) {
    return {
      ok: true,
      skipped: false,
      hits: []
    };
  }

  const embeddings = new ScormEmbeddings(embedding);
  const store = new QdrantVectorStore(embeddings, buildStoreArgs(settings));
  const normalizedTopK = Math.max(1, Math.trunc(Number(topK) || 6));
  const searchDepth = Math.max(normalizedTopK * 6, normalizedTopK + 6);

  try {
    const candidates = await store.similaritySearchWithScore(query, searchDepth);

    const filtered = candidates
      .map(([doc, score]) => {
        const materialId = `${doc?.metadata?.materialId || ""}`.trim();
        if (!ids.includes(materialId)) {
          return null;
        }

        return {
          materialId,
          fileName: `${doc?.metadata?.fileName || materialId}`,
          score: Number(Number(score || 0).toFixed(6)),
          chunk: {
            id: `${doc?.metadata?.chunkId || doc?.id || ""}`,
            order: Number(doc?.metadata?.chunkOrder) || 0,
            text: `${doc?.pageContent || ""}`.trim()
          }
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score)
      .slice(0, normalizedTopK);

    return {
      ok: true,
      skipped: false,
      hits: filtered,
      collectionName: settings.collectionName,
      url: settings.url
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      hits: [],
      message: toQdrantError(error, "Qdrant retrieval failed."),
      collectionName: settings.collectionName,
      url: settings.url
    };
  }
}

export async function deleteMaterialFromQdrant(materialId, embedding = DEFAULT_EMBEDDING_CONFIG) {
  const settings = getQdrantSettings();
  if (!settings.enabled || !materialId) {
    return {
      ok: false,
      skipped: true,
      message: "Qdrant delete skipped."
    };
  }

  const embeddings = new ScormEmbeddings(embedding);
  const store = new QdrantVectorStore(embeddings, buildStoreArgs(settings));

  try {
    await store.delete({
      filter: {
        must: [
          {
            key: "metadata.materialId",
            match: {
              value: materialId
            }
          }
        ]
      }
    });

    return {
      ok: true,
      skipped: false,
      materialId
    };
  } catch (error) {
    if (extractNotFoundMessage(error)) {
      return {
        ok: true,
        skipped: true,
        materialId,
        message: "Qdrant collection was not found."
      };
    }

    return {
      ok: false,
      skipped: false,
      materialId,
      message: toQdrantError(error, "Qdrant delete failed.")
    };
  }
}

/**
 * Scroll ALL chunks for given material IDs from Qdrant (no semantic search, just retrieve everything).
 * Returns chunks sorted by chunkOrder so the full content of each book is available in order.
 */
export async function scrollAllMaterialChunks({ documentIds, embedding, limit = 500 }) {
  const settings = getQdrantSettings();
  const ids = Array.isArray(documentIds) ? documentIds.filter(Boolean) : [];

  if (!settings.enabled || ids.length === 0) {
    return { ok: false, skipped: true, hits: [], message: "Qdrant disabled or no IDs." };
  }

  const client = createQdrantClient(settings);

  try {
    const allHits = [];
    
    for (const materialId of ids) {
      let offset = null;
      let hasMore = true;
      
      while (hasMore) {
        const scrollResult = await client.scroll(settings.collectionName, {
          filter: {
            must: [{
              key: "metadata.materialId",
              match: { value: materialId }
            }]
          },
          limit: Math.min(limit, 100),
          offset: offset,
          with_payload: true,
          with_vector: false
        });

        const points = scrollResult?.points || [];
        for (const point of points) {
          const payload = point?.payload || {};
          const metadata = payload?.metadata || {};
          allHits.push({
            materialId: metadata.materialId || materialId,
            fileName: metadata.fileName || materialId,
            score: 1.0,
            chunk: {
              id: metadata.chunkId || point.id || "",
              order: Number(metadata.chunkOrder) || 0,
              text: `${payload?.content || payload?.pageContent || ""}`.trim()
            }
          });
        }

        offset = scrollResult?.next_page_offset ?? null;
        hasMore = offset !== null && offset !== undefined && points.length > 0;
      }
    }

    // Sort by materialId then by chunkOrder to preserve book order
    allHits.sort((a, b) => {
      if (a.materialId !== b.materialId) return a.materialId.localeCompare(b.materialId);
      return (a.chunk.order || 0) - (b.chunk.order || 0);
    });

    return {
      ok: true,
      skipped: false,
      hits: allHits,
      total: allHits.length
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      hits: [],
      message: toQdrantError(error, "Qdrant scroll failed.")
    };
  }
}

