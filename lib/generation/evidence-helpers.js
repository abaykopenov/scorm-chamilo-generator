// ---------------------------------------------------------------------------
// lib/generation/evidence-helpers.js — Evidence pack building and RAG context
// ---------------------------------------------------------------------------
import { screenSlotId, getPlanSlotFacts } from "../generation-planner.js";
import { firstSentence } from "../course-utils.js";

export function cleanEvidenceText(value) {
  return `${value || ""}`
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\uFFFD/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksNoisyEvidence(value) {
  const text = cleanEvidenceText(value);
  if (!text) {
    return true;
  }
  if (/(?:self-contained|microflow|trainingmanagement|addday\s*\(|\$\[[^\]]+\]|bars?\/buttons?|location_[a-z0-9_]+)/i.test(text)) {
    return true;
  }
  const letters = (text.match(/\p{L}/gu) || []).length;
  const symbols = (text.match(/[{}\[\]<>$\/\\]/g) || []).length;
  if (letters > 0 && (symbols / letters) > 0.15) {
    return true;
  }
  // Filter metadata fragments: author credentials, publisher, contact info
  if (/(?:ISBN[\s:\-]*[\dXx\-]{10,}|©\s*\d{4}|Все\s*права\s*защищены|All\s*rights\s*reserved)/i.test(text)) {
    return true;
  }
  if (/[Сс]вязаться\s+с\s+\S+\s+можно/i.test(text)) {
    return true;
  }
  // Dense credential blocks (2+ credential markers in short text)
  const credentialPatterns = [
    /Член[\-\s]*корреспондент/i,
    /Почетный\s*работник/i,
    /Почётный\s*работник/i,
    /[Нн]аучный\s*редактор/i,
    /[Дд]октор\s*(?:технических|физико|экономических|наук)/i,
  ];
  const credentialHits = credentialPatterns.filter(p => p.test(text)).length;
  if (credentialHits >= 2 && text.length < 400) {
    return true;
  }
  if (looksGarbledText(text)) {
    return true;
  }
  return false;
}

// Detect text where words are merged together (no spaces between them)
export function looksGarbledText(value) {
  const text = `${value || ""}`.trim();
  if (!text) return false;
  
  const words = text.split(/\s+/);
  let garbledCount = 0;
  for (const word of words) {
    const cyrillicRun = word.match(/[\u0400-\u04FF]+/g);
    if (cyrillicRun && cyrillicRun.some(run => run.length > 24)) {
      garbledCount++;
    }
  }
  return words.length > 0 && (garbledCount / words.length) > 0.15;
}

export function buildEvidencePack(plan, moduleIndex, sectionIndex, scoIndex, screenIndex) {
  const slotId = screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex);
  const facts = getPlanSlotFacts(plan, slotId);
  const seen = new Set();
  const pack = [];

  for (const fact of facts) {
    const text = cleanEvidenceText(fact?.text || "");
    if (!text || text.length < 45 || looksNoisyEvidence(text)) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pack.push({
      factId: `${fact?.id || `fact_${pack.length + 1}`}`,
      source: `${fact?.source || "source"}`,
      materialId: `${fact?.materialId || ""}`,
      chunkId: `${fact?.chunkId || ""}`,
      excerpt: text
    });
    if (pack.length >= 8) {
      break;
    }
  }

  return pack.slice(0, 8);
}

export function evidencePackToRagContext(baseRagContext, evidencePack, slotLabel, objective) {
  const pack = Array.isArray(evidencePack) ? evidencePack : [];
  const chunks = pack.map((item, index) => ({
    materialId: item.materialId || item.source || `planner_${slotLabel}`,
    fileName: item.source || `planner_${slotLabel}`,
    score: 1 - (index * 0.01),
    chunkId: item.chunkId || `${slotLabel}_chunk_${index + 1}`,
    chunkOrder: index + 1,
    text: item.excerpt
  }));

  return {
    ...(baseRagContext || {}),
    topK: Math.max(3, chunks.length),
    chunks,
    screenPlanHints: [
      {
        slotId: slotLabel,
        label: slotLabel,
        objective: objective || "",
        keyFacts: pack.slice(0, 3).map((item) => item.excerpt)
      }
    ]
  };
}

export function ensureLongBody(text, evidencePack, title, minChars) {
  const intro = cleanEvidenceText(text);
  
  if (intro.length >= minChars) {
    return intro;
  }
  
  const excerpts = (Array.isArray(evidencePack) ? evidencePack : [])
    .map((item) => cleanEvidenceText(item.excerpt))
    .filter((e) => e.length > 30)
    .filter((e) => !looksGarbledText(e));

  let body = intro;

  for (const excerpt of excerpts) {
    if (body.length >= minChars) break;
    
    const excerptNorm = excerpt.toLowerCase().slice(0, 80);
    const bodyNorm = body.toLowerCase();
    if (bodyNorm.includes(excerptNorm)) continue;
    if (excerptNorm.length > 40 && bodyNorm.includes(excerptNorm.slice(0, 40))) continue;
    
    body = `${body} ${excerpt}`.trim();
  }

  return body.replace(/\s+/g, " ").trim();
}

export function hasEvidenceGrounding(body, evidencePack) {
  const normalizedBody = `${body || ""}`.toLowerCase();
  const evidence = Array.isArray(evidencePack) ? evidencePack : [];
  if (evidence.length === 0) {
    return false;
  }

  return evidence.some((item) => {
    const tokens = cleanEvidenceText(item.excerpt)
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= 6)
      .slice(0, 6);
    return tokens.some((token) => normalizedBody.includes(token));
  });
}
