// ---------------------------------------------------------------------------
// lib/generation/module-memory.js — Shared Memory for multi-agent pipeline
// ---------------------------------------------------------------------------
// Accumulates summaries of already-generated modules so that subsequent
// modules do not repeat the same topics.
// ---------------------------------------------------------------------------

/**
 * Extract top keywords from a screen's text content.
 * Returns an array of the most frequent meaningful terms.
 */
function extractKeywordsFromText(text, maxKeywords = 8) {
  const raw = `${text || ""}`.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!raw) return [];

  const stopwords = new Set([
    // Russian
    "это", "для", "при", "без", "что", "как", "или", "его", "она", "они", "они",
    "все", "так", "уже", "был", "его", "ещё", "бы", "же", "ли", "того", "этой",
    "этих", "были", "было", "будет", "можно", "также", "более", "между", "после",
    "через", "когда", "если", "очень", "может", "только", "нужно", "каждый",
    "другие", "данный", "данные", "является", "которые", "который", "которая",
    "использовать", "используется", "позволяет", "необходимо", "например",
    "следует", "должен", "включает", "обеспечивает", "представляет", "являются",
    "основные", "различные", "определенные", "определённые", "определить",
    // English
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "has",
    "have", "not", "but", "can", "will", "all", "one", "its", "use", "used",
    "using", "module", "screen", "section", "course", "text"
  ]);

  const words = raw.split(/\s+/).filter(w => w.length >= 3 && !stopwords.has(w));
  const freq = new Map();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

/**
 * Extract topic information from a completed module.
 * Returns an object with screen titles and key terms.
 */
export function extractModuleTopics(modulePayload) {
  const sections = Array.isArray(modulePayload?.sections) ? modulePayload.sections : [];
  const screenTitles = [];
  const allText = [];

  for (const section of sections) {
    const scos = Array.isArray(section?.scos) ? section.scos : [];
    for (const sco of scos) {
      const screens = Array.isArray(sco?.screens) ? sco.screens : [];
      for (const screen of screens) {
        const title = `${screen?.title || ""}`.trim();
        if (title && title.length > 3) {
          screenTitles.push(title);
        }
        // Collect body text for keyword extraction
        const bodyLong = `${screen?.bodyLong || ""}`.trim();
        if (bodyLong) {
          allText.push(bodyLong);
        }
        // Also collect block text
        const blocks = Array.isArray(screen?.blocks) ? screen.blocks : [];
        for (const block of blocks) {
          const blockText = `${block?.text || ""}`.trim();
          if (blockText && blockText.length > 20) {
            allText.push(blockText);
          }
        }
      }
    }
  }

  const combinedText = allText.join(" ");
  const keywords = extractKeywordsFromText(combinedText, 10);

  return {
    screenTitles: screenTitles.slice(0, 8),
    keywords
  };
}

/**
 * Build a prompt section describing already-generated modules.
 * This section is injected into the system prompt so the LLM avoids repeating topics.
 *
 * @param {Array<{ module: number, title: string, topics: { screenTitles: string[], keywords: string[] } }>} moduleMemory
 * @returns {string}
 */
export function buildMemoryPromptSection(moduleMemory) {
  if (!Array.isArray(moduleMemory) || moduleMemory.length === 0) {
    return "";
  }

  const lines = moduleMemory.map(m => {
    const titlePart = `Module ${m.module} "${m.title}"`;
    const keywordPart = m.topics?.keywords?.length > 0
      ? `: ${m.topics.keywords.join(", ")}`
      : "";
    const screenPart = m.topics?.screenTitles?.length > 0
      ? `\n    Screens: ${m.topics.screenTitles.join("; ")}`
      : "";
    return `  - ${titlePart}${keywordPart}${screenPart}`;
  });

  return [
    "ALREADY COVERED MODULES (DO NOT REPEAT these topics, terms, or explanations):",
    ...lines,
    "",
    "You MUST generate ONLY NEW content that is NOT covered in the modules above.",
    "Do NOT re-explain concepts, terms, or commands that were already introduced."
  ].join("\n");
}

/**
 * Build moduleMemory array from a list of already-generated modules.
 * Used by batch-generator to accumulate state across module generation.
 *
 * @param {Array} modules - Array of completed module payloads
 * @returns {Array<{ module: number, title: string, topics: object }>}
 */
export function buildModuleMemory(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    return [];
  }

  return modules.map((m, i) => ({
    module: i + 1,
    title: `${m?.title || `Module ${i + 1}`}`.trim(),
    topics: extractModuleTopics(m)
  }));
}
