import { embedTexts } from "./embeddings.js";
import { searchMaterialChunksInQdrant } from "./langchain-qdrant.js";
import { getMaterial, listMaterialVectorRecords } from "./material-store.js";
import { searchVectorRecords } from "./vector-search.js";

function normalizeTopK(value) {
  const parsed = Math.trunc(Number(value) || 12);
  return Math.max(1, Math.min(40, parsed));
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
    .replace(/(\p{L})\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/(\p{Ll})\s+(\p{Ll}{1,3})(?=\s|[.,;:!?)]|$)/gu, (match, left, right) => {
      if (right.length <= 3) return left + right;
      return match;
    })
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

  // NOTE: Garbled/merged-word detection is NOT applied here.
  // It would filter out all chunks from PDFs with extraction artifacts.
  // Instead, garbled text is filtered at the pipeline-helpers layer
  // (ensureLongBody, looksNoisyEvidence) before it reaches screen text.

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

  // Near-duplicate removal: if 80%+ of normalized text overlaps, keep the best one
  const sorted = [...bestByKey.values()].sort((a, b) => b.score - a.score);
  const final = [];
  for (const chunk of sorted) {
    const normalizedKey = normalizeChunkKey(chunk.text);
    const isDuplicate = final.some(existing => {
      const existingKey = normalizeChunkKey(existing.text);
      // Check containment (one is substring of another)
      if (existingKey.includes(normalizedKey) || normalizedKey.includes(existingKey)) {
        return true;
      }
      // Check suffix overlap (same ending, different start - exactly the bug we saw)
      const shorter = normalizedKey.length < existingKey.length ? normalizedKey : existingKey;
      const longer = normalizedKey.length < existingKey.length ? existingKey : normalizedKey;
      if (shorter.length > 40 && longer.endsWith(shorter.slice(Math.floor(shorter.length * 0.2)))) {
        return true;
      }
      return false;
    });
    if (!isDuplicate) {
      final.push(chunk);
    }
  }

  return final.sort((left, right) => {
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

function cleanRagText(text) {
  if (typeof text !== "string") return "";
  let cleaned = text;

  // Remove emails and URLs
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "");
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, "");

  // Remove contact info lines
  cleaned = cleaned.replace(/[Сс]вязаться\s+с\s+\S+\s+можно[^.]*\./gi, "");

  // Remove phone numbers
  cleaned = cleaned.replace(/(?:тел\.?|phone|\+7|8\s*[\(\-])\s*[\d\(\)\-\s]{7,}/gi, "");

  // Remove ISBN / UDK / BBK codes
  cleaned = cleaned.replace(/ISBN[\s:\-]*[\dXx\-]{10,}/gi, "");
  cleaned = cleaned.replace(/[УуUu][ДдDd][КкKk]\s*[\d.]+/g, "");
  cleaned = cleaned.replace(/[БбBb][БбBb][КкKk]\s*[\d.]+/g, "");

  // Remove copyright notices
  cleaned = cleaned.replace(/©\s*\d{4}[^.]*\./g, "");
  cleaned = cleaned.replace(/Все\s*права\s*защищены\.?/gi, "");
  cleaned = cleaned.replace(/All\s*rights\s*reserved\.?/gi, "");

  // Remove publisher/printing info
  cleaned = cleaned.replace(/(?:Корпоративное\s*издание|Издательств[оа]\s+[^\n.]{3,60}|Типография\s+[^\n.]{3,60}|Отпечатано\s+в\s+[^\n.]{3,60}|Тираж\s*\d+[^\n.]*)[.\n]?/gi, "");

  // Remove standalone page numbers with short titles (headers/footers)
  // Pattern: "8 Title." or "42 Some Header" at start/end of chunks
  cleaned = cleaned.replace(/(?:^|\n)\s*\d{1,4}\s+[\p{Lu}][\p{L}\s]{2,30}\.?\s*(?:\n|$)/gu, "\n");

  // Fix PDF justified text breaks with hyphens (e.g., "поведе - ния" -> "поведения")
  cleaned = cleaned.replace(/([\p{L}])\s*-\s+([\p{Ll}])/gu, "$1$2");

  // Fix bare word breaks: "обучен ия" -> "обучения"
  cleaned = cleaned.replace(/(\p{Ll})\s+(\p{Ll}{1,3})(?=\s|[.,;:!?)]|$)/gu, (match, left, right) => {
    if (right.length <= 3) return left + right;
    return match;
  });

  // Fix merged Russian prepositions: words stuck together around short prepositions/conjunctions
  // Pattern: Cyrillic word ending glued to a preposition glued to next word
  // Examples: "мониторингав реальном" → "мониторинга в реальном"
  //           "модулидля сбора" → "модули для сбора"
  //           "ошибокна этапах" → "ошибок на этапах"
  const prepositions = ["для", "при", "без", "под", "над", "про", "между"];
  for (const prep of prepositions) {
    // word+prep (e.g., "модулидля") → "модули для"
    const reGlued = new RegExp(`([\\u0400-\\u04FF]{3,})(${prep})(?=\\s|[.,;:!?)]|$)`, "giu");
    cleaned = cleaned.replace(reGlued, `$1 ${prep}`);
    // prep+word at start (e.g., "длясбора") → "для сбора"
    const reGluedRight = new RegExp(`(?<=\\s|^)(${prep})([\\u0400-\\u04FF]{3,})`, "giu");
    cleaned = cleaned.replace(reGluedRight, `${prep} $2`);
  }
  // Short prepositions: в, и, с, к, о, у, на, по, за, от, из, до
  const shortPreps = ["на", "по", "за", "от", "из", "до"];
  for (const prep of shortPreps) {
    // Only split if the preceding word is >3 chars (avoid false positives)
    const re = new RegExp(`([\\u0400-\\u04FF]{4,})(${prep})\\s+([\\u0400-\\u04FF])`, "giu");
    cleaned = cleaned.replace(re, `$1 ${prep} $3`);
  }
  // Single-char prepositions: "мониторингав" "стабильностьи" "компонентовс"
  cleaned = cleaned.replace(/([а-яё]{4,})(в|и|с|к|о|у)\s+([а-яёА-ЯЁ])/gi, (match, word, prep, next) => {
    // Verify it's likely a merge: the word before prep should end normally
    return `${word} ${prep} ${next}`;
  });

  // Remove English text fragments embedded in Russian content
  // Pattern: sequences of English words with merged spacing
  cleaned = cleaned.replace(/(?:^|\s)([A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){4,}[.!?]?)(?:\s|$)/g, " ");
  // Specifically catch "word1word2 word3word4" English merge patterns
  cleaned = cleaned.replace(/\b[A-Za-z]{2,}(?:[A-Z][a-z]+){2,}\b/g, "");

  // Remove author credential blocks (dense regalia without content)
  cleaned = cleaned.replace(/(?:Член[\-\s]*корреспондент|Почетный\s*работник|Почётный\s*работник|Заслуженный\s*деятель)[^\n.]{0,200}\./gi, (match) => {
    // Only remove if it's short (credential fragment, not educational content about the person)
    return match.length < 250 ? "" : match;
  });

  // --- Structural noise cleanup (page numbers, chapter markers, figure captions) ---
  // Remove standalone page numbers (e.g., "42", "Page 15", "Стр. 23")
  cleaned = cleaned.replace(/(?:^|\n)\s*(?:page|стр\.?|p\.?)\s*\d{1,4}\s*(?:\n|$)/gi, "\n");
  cleaned = cleaned.replace(/(?:^|\n)\s*\d{1,4}\s*(?:\n|$)/g, "\n");

  // Remove structural markers: Chapter, Preface, Table of Contents, etc.
  cleaned = cleaned.replace(/\b(?:Chapter|Preface|Foreword|Acknowledgements?|Table\s+of\s+Contents|Contents|Index|Appendix|Bibliography|References)\s*\d*\b/gi, "");
  cleaned = cleaned.replace(/(?:Предисловие|Оглавление|Содержание|Библиография|Приложение|Список\s+литературы|Указатель)\s*\d*/gi, "");

  // Remove figure/table captions without educational content
  cleaned = cleaned.replace(/(?:^|\n)\s*(?:Рис\.|Рисунок|Таблица|Figure|Table|Fig\.)\s*\d+[.:]\s*(?:[^\n]{0,60})\s*(?:\n|$)/gi, "\n");

  // Remove dotted page reference lines (TOC entries): "Some Topic ..... 42"
  cleaned = cleaned.replace(/[^\n]+\.{3,}\s*\d{1,4}\s*(?:\n|$)/g, "\n");

  // --- Word merging post-edit: fix PDF spacing artifacts ---
  // Fix letters glued across word boundaries: "обуче нного" → "обученного"
  cleaned = cleaned.replace(/(\p{Ll})\s(\p{Ll}{1,2}\p{Ll})/gu, (match, left, right) => {
    // Only merge if right part starts with lowercase (likely a suffix)
    if (right.length <= 3) return left + right;
    return match;
  });
  // Fix "Т е м а" → "Тема" (spaces between single letters)
  cleaned = cleaned.replace(/(?<=^|\s)(\p{L})\s(\p{L})\s(\p{L})\s(\p{L})(?=\s|$)/gu, "$1$2$3$4");
  // Fix "Г л а в а" → "Глава"
  cleaned = cleaned.replace(/(?<=^|\s)(\p{Lu})\s(\p{Ll})\s(\p{Ll})\s(\p{Ll})\s(\p{Ll})(?=\s|$)/gu, "$1$2$3$4$5");

  return cleaned.replace(/\s+/g, " ").trim();
}

function normalizeRetrievedChunks(chunks, topK) {
  const cleanedChunks = (Array.isArray(chunks) ? chunks : [])
    .map(chunk => ({
      ...chunk,
      text: cleanRagText(chunk.text)
    }))
    .filter(chunk => chunk.text.length > 20); // filter out empty artifacts

  // Apply minimum relevance score filter to avoid pulling irrelevant materials
  const MIN_SCORE = 0.25;
  let relevantChunks = cleanedChunks.filter(chunk => (chunk.score || 0) >= MIN_SCORE);

  // Type-aware score boost: code/command chunks are more specific and valuable
  const TYPE_BOOST = { code: 0.05, command: 0.04, definition: 0.02, text: 0 };
  relevantChunks = relevantChunks.map(chunk => {
    const chunkType = `${chunk.type || "text"}`;
    const boost = TYPE_BOOST[chunkType] || 0;
    return boost > 0 ? { ...chunk, score: toScore((chunk.score || 0) + boost) } : chunk;
  });

  // Adaptive threshold: if top chunks have good scores, filter out much-lower-scored ones
  // This prevents mixing unrelated materials (e.g. IoT content in a ROS course)
  if (relevantChunks.length > 3) {
    const maxScore = Math.max(...relevantChunks.map(c => c.score || 0));
    if (maxScore > 0.5) {
      const adaptiveThreshold = maxScore * 0.4; // must have at least 40% of max relevance
      relevantChunks = relevantChunks.filter(c => (c.score || 0) >= adaptiveThreshold);
    }
  }

  const deduped = dedupeChunks(relevantChunks);
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

    // Collect TOC from all materials
    const allToc = materials.filter(Boolean)
      .flatMap(m => Array.isArray(m.toc) ? m.toc : []);

    const query = buildRagQueryFromInput(input);
    const retrievalMessages = [];

    // Query Decomposition: split into focused sub-queries
    let subQueries = [query];
    try {
      const { decomposeQuery } = await import("./rag/query-decomposer.js");
      subQueries = await decomposeQuery(input);
    } catch (decomposeError) {
      console.warn("[rag] Query decomposition unavailable:", decomposeError?.message);
    }

    // Run all sub-queries in parallel against Qdrant
    const expandedTopK = Math.min(normalizedTopK * 3, 40);
    const perQueryTopK = Math.max(6, Math.ceil(expandedTopK / subQueries.length));

    const qdrantResults = await Promise.all(
      subQueries.map(sq => searchMaterialChunksInQdrant({
        documentIds,
        query: sq,
        topK: perQueryTopK,
        embedding: rag.embedding
      }).catch(() => ({ ok: false, hits: [] })))
    );

    // Merge hits from all sub-queries
    const allHits = [];
    const seenChunkIds = new Set();
    for (const result of qdrantResults) {
      if (!result.ok || !Array.isArray(result.hits)) continue;
      for (const hit of result.hits) {
        const chunkId = hit.chunk?.id || `${hit.materialId}-${hit.chunk?.order || 0}`;
        if (seenChunkIds.has(chunkId)) continue;
        seenChunkIds.add(chunkId);
        allHits.push(hit);
      }
    }

    // ── Auto-document-selection: prioritize the most relevant document ──
    if (allHits.length > 0 && documentIds.length > 1) {
      // Score each document by cumulative relevance of its chunks
      const docScores = new Map();
      for (const hit of allHits) {
        const mid = hit.materialId;
        const prev = docScores.get(mid) || { totalScore: 0, hitCount: 0, fileName: "" };
        prev.totalScore += (hit.score || 0);
        prev.hitCount += 1;
        prev.fileName = hit.fileName || byId.get(mid)?.fileName || mid;
        docScores.set(mid, prev);
      }

      // Rank documents by average score * hit count (relevance density)
      const ranked = [...docScores.entries()]
        .map(([id, info]) => ({
          id,
          fileName: info.fileName,
          avgScore: info.hitCount > 0 ? info.totalScore / info.hitCount : 0,
          hitCount: info.hitCount,
          relevance: (info.totalScore / info.hitCount) * Math.log2(1 + info.hitCount)
        }))
        .sort((a, b) => b.relevance - a.relevance);

      if (ranked.length > 1) {
        const topDoc = ranked[0];
        const secondDoc = ranked[1];
        const dominanceRatio = topDoc.relevance / (secondDoc.relevance || 0.001);

        console.log(`[rag] Document relevance ranking:`);
        for (const doc of ranked) {
          console.log(`[rag]   ${doc.fileName}: relevance=${doc.relevance.toFixed(3)}, avgScore=${doc.avgScore.toFixed(3)}, hits=${doc.hitCount}`);
        }

        // If top document is significantly more relevant (>1.3x), boost its chunks
        if (dominanceRatio > 1.3) {
          console.log(`[rag] Auto-selecting "${topDoc.fileName}" (${dominanceRatio.toFixed(1)}x more relevant than "${secondDoc.fileName}")`);
          // Boost top document's chunks by 30%
          for (const hit of allHits) {
            if (hit.materialId === topDoc.id) {
              hit.score = (hit.score || 0) * 1.3;
            }
          }
        }
      }
    }

    if (allHits.length > 0) {
      let chunks = normalizeRetrievedChunks(
        allHits.map((hit) => ({
          materialId: hit.materialId,
          fileName: hit.fileName || byId.get(hit.materialId)?.fileName || hit.materialId,
          score: hit.score,
          chunkId: hit.chunk?.id || "",
          chunkOrder: Number(hit.chunk?.order) || 0,
          text: `${hit.chunk?.text || ""}`.trim(),
          type: hit.chunk?.type || "text"
        })),
        expandedTopK
      );

      // Re-ranking: LLM-based relevance scoring
      try {
        const { rerankChunks } = await import("./rag/reranker.js");
        chunks = await rerankChunks(input, query, chunks, normalizedTopK);
      } catch (rerankError) {
        console.warn("[rag] Re-ranking unavailable:", rerankError?.message);
        chunks = chunks.slice(0, normalizedTopK);
      }

      return {
        enabled: true,
        topK: normalizedTopK,
        documents,
        chunks,
        toc: allToc,
        query,
        subQueries: subQueries.length > 1 ? subQueries : undefined,
        message: ""
      };
    }

    // Collect error messages from failed sub-queries
    const failedResults = qdrantResults.filter(r => !r.ok && !r.skipped);
    if (failedResults.length > 0) {
      retrievalMessages.push(`Qdrant retrieval issues: ${failedResults.map(r => r.message || "unknown").join("; ")}`);
    }

    // Fallback 1: try local vector records
    const records = await listMaterialVectorRecords(documentIds);
    if (records.length > 0) {
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

      if (chunks.length > 0) {
        return {
          enabled: true,
          topK: normalizedTopK,
          documents,
          chunks,
          toc: allToc,
          query,
          message: chunks.length > 0
            ? toMessage(retrievalMessages, "")
            : toMessage(retrievalMessages, "No relevant chunks were retrieved.")
        };
      }
    }

    // Fallback 2: load raw chunks directly from local storage
    try {
      const { getMaterialChunks } = await import("./material-store.js");
      const loadedChunks = [];
      for (const docId of documentIds) {
        try {
          const materialChunks = await getMaterialChunks(docId);
          if (Array.isArray(materialChunks)) {
            for (const chunk of materialChunks) {
              loadedChunks.push({
                materialId: docId,
                fileName: byId.get(docId)?.fileName || docId,
                score: 0.5,
                chunkId: chunk.id || `${docId}:chunk_${loadedChunks.length}`,
                chunkOrder: chunk.order || loadedChunks.length,
                text: `${chunk.text || ""}`.trim()
              });
            }
          }
        } catch { /* skip if material has no chunks */ }
      }
      if (loadedChunks.length > 0) {
        console.warn(`[rag] Fallback: loaded ${loadedChunks.length} raw chunks from local storage`);
        const chunks = normalizeRetrievedChunks(loadedChunks, normalizedTopK);
        return {
          enabled: true,
          topK: normalizedTopK,
          documents,
          chunks,
          toc: allToc,
          query,
          message: "Used local chunk fallback (Qdrant search returned no results)."
        };
      }
    } catch (fallbackError) {
      console.warn("[rag] Local chunk fallback failed:", fallbackError?.message);
    }

    return {
      enabled: true,
      topK: normalizedTopK,
      documents,
      chunks: [],
      query,
      message: toMessage(retrievalMessages, "No indexed vectors found for selected materials.")
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
