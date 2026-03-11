import { createId } from "../ids.js";
import { DEFAULT_LANGUAGE, LIMITS } from "../course-defaults.js";
import { clampNumber, toText, toTextArray } from "./shared.js";
import { 
  normalizeGenerationSettings, 
  normalizeRagSettings, 
  normalizeContentDepthMode, 
  normalizeAgentTopology, 
  normalizeEvidenceMode, 
  normalizeGenerationDefaults, 
  normalizeFinalTestSettings, 
  normalizeChamiloSettings 
} from "./input.js";

function normalizeBlocks(blocks, screenTitle) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [
      {
        type: "text",
        text: `Short instructional content for screen "${screenTitle}".`
      }
    ];
  }

  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return null;
      const type = ["text", "note", "list", "image"].includes(block.type) ? block.type : "text";
      if (type === "list") {
        return { type, items: toTextArray(block.items, [`Screen content "${screenTitle}"`]) };
      }
      if (type === "image") {
        return {
          type,
          src: toText(block.src, ""),
          alt: toText(block.alt, screenTitle)
        };
      }
      return {
        type,
        text: toText(block.text, `Short instructional content for screen "${screenTitle}".`)
      };
    })
    .filter(Boolean);
}

function normalizeQuestions(questions, desiredCount) {
  const normalized = Array.isArray(questions)
    ? questions.map((question, index) => ({
        id: question?.id || createId("question"),
        prompt: toText(question?.prompt, `Control question ${index + 1}`),
        options: Array.isArray(question?.options) && question.options.length > 0
          ? question.options.map((option, optionIndex) => ({
              id: option?.id || createId("option"),
              text: toText(option?.text, `Option ${optionIndex + 1}`)
            }))
          : Array.from({ length: 4 }, (_, i) => ({ id: createId("option"), text: `Option ${i + 1}` })),
        correctOptionId: question?.correctOptionId,
        explanation: toText(question?.explanation, ""),
        screenRefs: toTextArray(question?.screenRefs, []).slice(0, 6)
      }))
    : [];

  while (normalized.length < desiredCount) {
    normalized.push({
      id: createId("question"),
      prompt: `Control question ${normalized.length + 1}`,
      options: Array.from({ length: 4 }, (_, i) => ({ id: createId("option"), text: `Option ${i + 1}` })),
      correctOptionId: null,
      explanation: "",
      screenRefs: []
    });
  }

  normalized.length = desiredCount;

  return normalized.map((q) => {
    const fallback = q.options[0]?.id ?? createId("option");
    return {
      ...q,
      correctOptionId: q.options.some((o) => o.id === q.correctOptionId) ? q.correctOptionId : fallback
    };
  });
}

function normalizeEvidenceEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      return {
        factId: toText(entry.factId, `fact_${index + 1}`) || `fact_${index + 1}`,
        source: toText(entry.source, "") || "source",
        materialId: toText(entry.materialId, ""),
        chunkId: toText(entry.chunkId, ""),
        excerpt: toText(entry.excerpt, "")
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeCoursePayload(payload) {
  const title = toText(payload?.title, "New course");
  const description = toText(payload?.description, "Course draft.");
  const language = payload?.language === "en" ? "en" : DEFAULT_LANGUAGE;
  const generation = normalizeGenerationSettings(payload?.generation);
  const rag = normalizeRagSettings(payload?.rag, generation);
  const contentDepthMode = normalizeContentDepthMode(payload?.contentDepthMode, "deep");
  const agentTopology = normalizeAgentTopology(payload?.agentTopology, "v4");
  const evidenceMode = normalizeEvidenceMode(payload?.evidenceMode, "per-screen");
  const generationDefaults = normalizeGenerationDefaults(payload?.generationDefaults, { moduleCountDefault: 2 });
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  const finalTestSource = payload?.finalTest ?? {};
  const finalTestSettings = normalizeFinalTestSettings({
    enabled: payload?.finalTest?.enabled ?? true,
    questionCount: payload?.finalTest?.questionCount ?? payload?.finalTest?.questions?.length ?? LIMITS.questionCount.default,
    passingScore: finalTestSource.passingScore,
    attemptsLimit: finalTestSource.attemptsLimit,
    maxTimeMinutes: finalTestSource.maxTimeMinutes
  });

  return {
    id: payload?.id || createId("course"),
    title,
    description,
    language,
    generation,
    contentDepthMode,
    agentTopology,
    evidenceMode,
    generationDefaults,
    rag,
    sourceDocuments: (Array.isArray(payload?.sourceDocuments) ? payload.sourceDocuments : [])
      .map((doc) => ({
        id: toText(doc?.id, ""),
        fileName: toText(doc?.fileName, ""),
        status: toText(doc?.status, "")
      })).filter((doc) => doc.id),
    integrations: {
      chamilo: normalizeChamiloSettings(payload?.integrations?.chamilo)
    },
    modules: modules.map((m, mIdx) => ({
      id: m?.id || createId("module"),
      title: toText(m?.title, `Module ${mIdx + 1}`),
      order: mIdx + 1,
      sections: (Array.isArray(m?.sections) ? m.sections : []).map((s, sIdx) => ({
        id: s?.id || createId("section"),
        title: toText(s?.title, `Section ${mIdx + 1}.${sIdx + 1}`),
        order: sIdx + 1,
        scos: (Array.isArray(s?.scos) ? s.scos : []).map((sco, scoIdx) => ({
          id: sco?.id || createId("sco"),
          title: toText(sco?.title, `SCO ${mIdx + 1}.${sIdx + 1}.${scoIdx + 1}`),
          order: scoIdx + 1,
          masteryScore: sco?.masteryScore != null ? clampNumber(sco.masteryScore, LIMITS.passingScore) : undefined,
          maxTimeMinutes: sco?.maxTimeMinutes != null ? clampNumber(sco.maxTimeMinutes, LIMITS.maxTimeMinutes) : undefined,
          screens: (Array.isArray(sco?.screens) ? sco.screens : []).map((sc, scIdx) => {
            const scTitle = toText(sc?.title, `Screen ${scIdx + 1}`);
            return {
              id: sc?.id || createId("screen"),
              title: scTitle,
              order: scIdx + 1,
              bodyLong: toText(sc?.bodyLong, ""),
              keyTakeaways: toTextArray(sc?.keyTakeaways, []).slice(0, 5),
              practicalStep: toText(sc?.practicalStep, ""),
              evidence: normalizeEvidenceEntries(sc?.evidence),
              blocks: normalizeBlocks(sc?.blocks, scTitle)
            };
          })
        }))
      }))
    })),
    finalTest: {
      id: payload?.finalTest?.id || createId("final_test"),
      enabled: finalTestSettings.enabled,
      title: toText(payload?.finalTest?.title, "Final test"),
      questionCount: finalTestSettings.questionCount,
      passingScore: finalTestSettings.passingScore,
      attemptsLimit: finalTestSettings.attemptsLimit,
      maxTimeMinutes: finalTestSettings.maxTimeMinutes,
      questions: normalizeQuestions(payload?.finalTest?.questions, finalTestSettings.questionCount)
    }
  };
}
