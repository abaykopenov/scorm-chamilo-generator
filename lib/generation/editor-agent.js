// ---------------------------------------------------------------------------
// lib/generation/editor-agent.js — Technical Editor Agent
// ---------------------------------------------------------------------------
// A separate LLM call that refines screen text after Writer+Critic:
// - Deduplication of repeated concepts
// - Language hygiene (removes English garbage, [object Object], broken chars)
// - Style improvement (active verbs, professional tone)
// - Formatting cleanup
// ---------------------------------------------------------------------------

const EDITOR_SYSTEM_PROMPT = `You are a professional technical editor for e-learning courses.
Your task: refine the provided screen text following these strict rules.

RULES:
1. DEDUPLICATION: If the same concept is explained twice — remove the duplicate. Keep only the best explanation.
2. LANGUAGE HYGIENE: Remove all English garbage fragments embedded in Russian text (like "andcode fromany"), remove [object Object], fix broken Unicode characters, remove stray formatting artifacts.
3. STYLE: Use active verbs. Replace "plays a role" with "organizes", "is important for" with "enables", "it should be noted that" with direct statement. Remove filler phrases: "it is important to note", "in the framework of", "it should be understood that".
4. FORMATTING: Ensure logical paragraph breaks. Remove orphan sentences that don't contribute information.
5. PRESERVE: Keep all technical terms, commands, code examples, and factual content intact. Do NOT change technical accuracy.
6. LENGTH: The refined text should be roughly the same length as original (±20%). Do NOT drastically shorten or expand.

OUTPUT: Return ONLY the refined text. No comments, no explanations, no markdown formatting markers.`;

const EDITOR_SYSTEM_PROMPT_RU = `Ты — профессиональный технический редактор электронных курсов.
Твоя задача: отредактировать текст экрана по строгим правилам.

ПРАВИЛА:
1. ДЕДУПЛИКАЦИЯ: Если одно и то же понятие объясняется дважды — удали повтор. Оставь лучшее объяснение.
2. ЯЗЫКОВАЯ ГИГИЕНА: Удали весь английский мусор, встроенный в русский текст (типа "andcode fromany"), удали [object Object], исправь сломанные символы Unicode, удали артефакты форматирования.
3. СТИЛЬ: Используй активные глаголы. Заменяй "играет роль" на "организует", "является важным для" на "обеспечивает", "следует отметить, что" на прямое утверждение. Убирай фразы-наполнители.
4. ФОРМАТИРОВАНИЕ: Обеспечь логичные разрывы абзацев. Убери сиротские предложения, не несущие информации.
5. СОХРАНИ: Все технические термины, команды, примеры кода и фактическое содержание. НЕ меняй техническую точность.
6. ДЛИНА: Текст после редактирования должен быть примерно той же длины (±20%). НЕ сокращай и не расширяй радикально.

ВЫВОД: Верни ТОЛЬКО отредактированный текст. Без комментариев, без пояснений, без маркеров форматирования.`;

/**
 * Check if editor agent is enabled via environment variable.
 */
function isEditorEnabled() {
  const raw = `${process.env.EDITOR_AGENT_ENABLED ?? "true"}`.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/**
 * Check if text quality is poor enough to warrant editing.
 * Returns true if the text has issues that the editor should fix.
 */
function needsEditing(text) {
  if (!text || text.length < 50) return false;

  // Check for [object Object]
  if (/\[object\s+Object\]/i.test(text)) return true;

  // Check for English garbage in Russian text
  const hasCyrillic = /[\u0400-\u04FF]/.test(text);
  if (hasCyrillic) {
    const englishFragments = text.match(/\b[a-zA-Z]{4,}(?:\s+[a-zA-Z]{3,}){2,}\b/g);
    if (englishFragments && englishFragments.length >= 2) return true;
  }

  // Check for filler phrases
  const fillerPatterns = [
    /следует\s+отметить/i,
    /важно\s+понимать/i,
    /необходимо\s+учитывать/i,
    /в\s+рамках\s+данного/i,
    /играет\s+(?:важную\s+)?роль/i,
    /it\s+is\s+important\s+to\s+note/i,
    /it\s+should\s+be\s+noted/i
  ];
  const fillerCount = fillerPatterns.filter(p => p.test(text)).length;
  if (fillerCount >= 2) return true;

  // Check for broken Unicode / mojibake
  const brokenChars = (text.match(/[\uFFFD]/g) || []).length;
  if (brokenChars > 0) return true;

  // Check for duplicate paragraphs (same text appears twice)
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim().toLowerCase()).filter(p => p.length > 30);
  const seen = new Set();
  for (const p of paragraphs) {
    const key = p.slice(0, 60);
    if (seen.has(key)) return true;
    seen.add(key);
  }

  return false;
}

/**
 * Refine screen text using an LLM editor agent.
 * 
 * @param {object} input - Generation input with provider config
 * @param {object} screen - Screen object with bodyLong, blocks, etc.
 * @returns {object} Screen with refined text
 */
export async function refineScreenText(input, screen) {
  if (!isEditorEnabled()) return screen;

  const bodyLong = `${screen?.bodyLong || ""}`.trim();
  if (!bodyLong || bodyLong.length < 80) return screen;

  // Only edit if text has quality issues
  if (!needsEditing(bodyLong)) return screen;

  const language = `${input?.language || "ru"}`.trim().toLowerCase();
  const systemPrompt = language === "en" ? EDITOR_SYSTEM_PROMPT : EDITOR_SYSTEM_PROMPT_RU;

  try {
    const generation = input?.generation || {};
    const { callProvider } = await import("../llm/providers.js");

    const result = await callProvider(
      {
        provider: generation.provider || "ollama",
        baseUrl: generation.baseUrl || "http://127.0.0.1:11434",
        model: generation.model || "llama3",
        temperature: 0.3
      },
      {
        system: systemPrompt,
        user: bodyLong
      },
      {
        jsonMode: false,
        trace: { stage: "editor-agent" }
      }
    );

    const refined = `${result || ""}`.trim();

    // Sanity checks: don't replace if the result is too short or empty
    if (!refined || refined.length < bodyLong.length * 0.5) {
      console.warn("[editor-agent] Rejected edit: result too short", {
        original: bodyLong.length,
        refined: refined.length
      });
      return screen;
    }

    // Don't replace if the result is way too long (hallucination)
    if (refined.length > bodyLong.length * 2.5) {
      console.warn("[editor-agent] Rejected edit: result too long", {
        original: bodyLong.length,
        refined: refined.length
      });
      return screen;
    }

    console.log(`[editor-agent] ✏️ Refined screen "${screen?.title || "?"}": ${bodyLong.length} → ${refined.length} chars`);

    return {
      ...screen,
      bodyLong: refined,
      // Also update blocks if they contain text blocks
      blocks: Array.isArray(screen.blocks)
        ? screen.blocks.map(block => {
            if (block?.type === "text" && block.text === bodyLong) {
              return { ...block, text: refined };
            }
            return block;
          })
        : screen.blocks
    };
  } catch (error) {
    console.warn(`[editor-agent] Failed to refine screen: ${error?.message || error}`);
    return screen;
  }
}
