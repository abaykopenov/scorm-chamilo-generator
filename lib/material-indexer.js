import { chunkText } from "./chunker.js";
import { parseDocumentText } from "./document-parser.js";
import { embedTexts } from "./embeddings.js";
import { upsertMaterialChunksToQdrant } from "./langchain-qdrant.js";
import { extractImagesFromPdf } from "./multimodal/image-extractor.js";
import { callVisionModel } from "./multimodal/vision-llm.js";
import { extractTableOfContents } from "./parser/toc-extractor.js";
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
    const text = await parseDocumentText({
      fileName: materialFile.material.fileName,
      mimeType: materialFile.material.mimeType,
      buffer: materialFile.buffer
    });
    const chunks = chunkText(text, chunking);

    // -- File type detection --
    const isPdf = `${materialFile.material.fileName || ""}`.toLowerCase().endsWith(".pdf");

    // -- TOC extraction: extract table of contents from PDF --
    let toc = null;
    if (isPdf) {
      try {
        toc = extractTableOfContents(materialFile.material.filePath, text);
      } catch (tocError) {
        console.warn("[toc-extractor] Failed:", tocError?.message || tocError);
      }
    } else if (text) {
      try {
        toc = extractTableOfContents(null, text);
      } catch {}
    }

    // -- Multimodal processing: extract and describe images if it's a PDF --
    const visionEnabled = options.vision?.enabled || true; // Currently defaulting to true if not explicitly disabled
    
    if (isPdf && visionEnabled && chunks.length < MAX_INDEX_CHUNKS) {
      try {
        const images = await extractImagesFromPdf(materialFile.buffer);
        // We limit to max 15 images to avoid blowing up the API request queue
        const limitedImages = images.slice(0, 15);
        
        for (const img of limitedImages) {
          if (chunks.length >= MAX_INDEX_CHUNKS) break;
          try {
            const visionConfig = options.vision || { ...embedding, model: "llava" }; // Default to local llava
            const description = await callVisionModel(visionConfig, img.base64);
            if (description && description.length > 20) {
              const imgText = `[Image: ${img.fileName}]\nDescription: ${description}`;
              chunks.push({
                id: `img_${img.fileName.replace(/[^a-zA-Z0-9_-]/g, "")}_${Date.now()}`,
                order: chunks.length + 1,
                text: imgText,
                length: imgText.length
              });
            }
          } catch (modelError) {
            console.warn(`Vision model failed for ${img.fileName}:`, modelError.message);
          }
        }
      } catch (extractorError) {
        console.warn("Failed to extract images from PDF for multimodal indexing:", extractorError.message);
      }
    }

    const selectedChunks = chunks.slice(0, MAX_INDEX_CHUNKS);
    const vectors = await buildVectorsForChunks(selectedChunks, embedding, options.embedder);

    if (vectors.length !== selectedChunks.length) {
      throw new Error("Embedding vector count does not match chunk count.");
    }

    const qdrant = await upsertMaterialChunksToQdrant({
      material: materialFile.material,
      chunks: selectedChunks,
      vectors,
      embedding
    });

    const qdrantWarning = !qdrant.ok && !qdrant.skipped
      ? qdrant.message || "Qdrant sync failed."
      : "";

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
        toc: Array.isArray(toc) && toc.length > 0 ? toc : undefined,
        errorMessage: qdrantWarning ? "Qdrant warning: " + qdrantWarning : ""
      })
    ]);

    return {
      ok: true,
      materialId,
      chunksCount: selectedChunks.length,
      totalChunks: chunks.length,
      chunkLimitApplied: chunks.length > selectedChunks.length,
      embeddingProvider: embedding.provider,
      embeddingModel: embedding.model,
      qdrant
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

  const qdrantResults = results
    .map((item) => item.qdrant)
    .filter((item) => item && typeof item === "object");

  return {
    total: ids.length,
    indexed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    qdrant: {
      connected: qdrantResults.some((item) => item.ok && !item.skipped),
      failures: qdrantResults.filter((item) => !item.ok && !item.skipped).length,
      skipped: qdrantResults.filter((item) => item.skipped).length
    },
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

