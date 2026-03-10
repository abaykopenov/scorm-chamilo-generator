// ---------------------------------------------------------------------------
// LLM response parsers: JSON extraction, line-plan parsing, outline validation
// ---------------------------------------------------------------------------

// ── JSON extraction from LLM text ──────────────────────────────────────────

export function parseJsonFromLlmText(raw) {
  if (typeof raw !== "string") {
    throw new Error("LLM returned non-text response.");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("LLM returned empty response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fencedMatches = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fencedMatches) {
    const unwrapped = block.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(unwrapped);
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  const preview = trimmed.slice(0, 120).replace(/\s+/g, " ");
  throw new Error(`Model did not return valid JSON. Preview: ${preview}`);
}

// ── Line-plan text parser ──────────────────────────────────────────────────

export function parseLinePlanText(raw, input) {
  if (typeof raw !== "string") {
    throw new Error("LLM returned non-text response.");
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const topics = [];
  const questions = [];
  let title = "";
  let description = "";

  for (const line of lines) {
    if (line.startsWith("TITLE|")) {
      title = line.slice("TITLE|".length).trim();
      continue;
    }
    if (line.startsWith("DESCRIPTION|")) {
      description = line.slice("DESCRIPTION|".length).trim();
      continue;
    }
    if (line.startsWith("TOPIC|")) {
      const parts = line.split("|");
      const topicTitle = String(parts[1] || "").trim();
      const topicText = String(parts[2] || "").trim();
      const bulletText = parts.slice(3).join("|");
      const bullets = bulletText
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 3);
      while (bullets.length < 3) {
        bullets.push("Key takeaway " + (bullets.length + 1));
      }
      topics.push({
        title: topicTitle || "Topic " + (topics.length + 1),
        text: topicText || "Topic explanation " + (topics.length + 1) + ".",
        bullets
      });
      continue;
    }
    if (line.startsWith("QUESTION|")) {
      const parts = line.split("|");
      if (parts.length < 8) {
        continue;
      }
      const prompt = String(parts[1] || "").trim();
      const optionTexts = [
        String(parts[2] || "").trim(),
        String(parts[3] || "").trim(),
        String(parts[4] || "").trim(),
        String(parts[5] || "").trim()
      ];
      const parsedIndex = Math.trunc(Number(parts[6])) - 1;
      const correctOptionIndex = Number.isFinite(parsedIndex) ? Math.max(0, Math.min(3, parsedIndex)) : 0;
      const explanation = parts.slice(7).join("|").trim();
      const normalizedOptions = optionTexts.map((option, index) => option || "Option " + (index + 1));

      questions.push({
        prompt: prompt || "Control question " + (questions.length + 1),
        options: normalizedOptions,
        correctOptionIndex,
        explanation: explanation || "Explanation for question " + (questions.length + 1) + "."
      });
    }
  }

  const requiredQuestions = Math.max(1, Number(input?.finalTest?.questionCount || 8));
  while (questions.length < requiredQuestions) {
    questions.push({
      prompt: "Control question " + (questions.length + 1),
      options: ["Option 1", "Option 2", "Option 3", "Option 4"],
      correctOptionIndex: 0,
      explanation: "Explanation for question " + (questions.length + 1) + "."
    });
  }

  if (topics.length === 0) {
    throw new Error("Plan output did not contain TOPIC lines.");
  }

  return {
    title: title || String(input?.titleHint || "Course").trim(),
    description: description || ("Course for audience \"" + String(input?.audience || "learners") + "\"."),
    topics,
    questions: questions.slice(0, requiredQuestions)
  };
}

// ── Outline validation ─────────────────────────────────────────────────────

function collectOutlineTextBlocks(outline) {
  const blocks = [];
  for (const moduleItem of Array.isArray(outline?.modules) ? outline.modules : []) {
    for (const section of Array.isArray(moduleItem?.sections) ? moduleItem.sections : []) {
      for (const sco of Array.isArray(section?.scos) ? section.scos : []) {
        for (const screen of Array.isArray(sco?.screens) ? sco.screens : []) {
          for (const block of Array.isArray(screen?.blocks) ? screen.blocks : []) {
            if (block?.type === "text" || block?.type === "note") {
              blocks.push(String(block?.text || "").replace(/\s+/g, " ").trim());
            }
          }
        }
      }
    }
  }
  return blocks.filter(Boolean);
}

export function validateOutlineJson(parsed, input, validate = {}) {
  const modules = Array.isArray(parsed?.modules) ? parsed.modules : [];
  if (modules.length === 0) {
    return { ok: false, reason: "no-modules" };
  }

  const expectedModules = Number(validate?.expectedModules);
  if (Number.isFinite(expectedModules) && expectedModules > 0 && modules.length !== expectedModules) {
    return { ok: false, reason: "expected-modules-" + expectedModules + "-got-" + modules.length };
  }

  const firstSections = Array.isArray(modules?.[0]?.sections) ? modules[0].sections : [];
  const expectedSections = Number(validate?.expectedSections);
  if (Number.isFinite(expectedSections) && expectedSections > 0 && firstSections.length !== expectedSections) {
    return { ok: false, reason: "expected-sections-" + expectedSections + "-got-" + firstSections.length };
  }

  const firstScos = Array.isArray(firstSections?.[0]?.scos) ? firstSections[0].scos : [];
  const expectedScos = Number(validate?.expectedScos);
  if (Number.isFinite(expectedScos) && expectedScos > 0 && firstScos.length !== expectedScos) {
    return { ok: false, reason: "expected-scos-" + expectedScos + "-got-" + firstScos.length };
  }

  const firstScreens = Array.isArray(firstScos?.[0]?.screens) ? firstScos[0].screens : [];
  const expectedScreens = Number(validate?.expectedScreens);
  if (Number.isFinite(expectedScreens) && expectedScreens > 0 && firstScreens.length !== expectedScreens) {
    return { ok: false, reason: "expected-screens-" + expectedScreens + "-got-" + firstScreens.length };
  }

  const textBlocks = collectOutlineTextBlocks(parsed);
  if (textBlocks.length === 0) {
    return { ok: false, reason: "no-text-blocks" };
  }

  const placeholderPattern = /(?:\u043a\u043e\u043d\u0442\u0435\u043d\u0442\s+\u044d\u043a\u0440\u0430\u043d\u0430|\u0442\u0435\u043a\u0443\u0449\u0430\u044f\s+\u0442\u0435\u043c\u0430|\u043a\u043b\u044e\u0447\u0435\u0432\u043e\u0439\s+\u0442\u0435\u0437\u0438\u0441|screen\s*\d+|topic\s*\d+|module\s*\d+|sco\s*\d+|we need to generate json|json object only|focus\s+for\s+audience)/i;
  const placeholderCount = textBlocks.filter((text) => placeholderPattern.test(text)).length;
  const placeholderRatio = placeholderCount / textBlocks.length;
  const maxPlaceholderRatio = Number.isFinite(Number(validate?.maxPlaceholderRatio))
    ? Number(validate.maxPlaceholderRatio)
    : 0.12;
  if (placeholderRatio > maxPlaceholderRatio) {
    return { ok: false, reason: "placeholder-ratio-" + placeholderRatio.toFixed(3) };
  }

  const avgTextLength = textBlocks.reduce((sum, text) => sum + text.length, 0) / textBlocks.length;
  const minAvgTextLength = Number.isFinite(Number(validate?.minAvgTextLength))
    ? Number(validate.minAvgTextLength)
    : 120;
  if (avgTextLength < minAvgTextLength) {
    return { ok: false, reason: "avg-text-too-short-" + Math.round(avgTextLength) };
  }

  const unique = new Set(textBlocks.map((text) => text.toLowerCase()));
  const uniqueRatio = unique.size / textBlocks.length;
  const minUniqueRatio = Number.isFinite(Number(validate?.minUniqueRatio))
    ? Number(validate.minUniqueRatio)
    : (textBlocks.length >= 8 ? 0.7 : 0.55);
  if (uniqueRatio < minUniqueRatio) {
    return { ok: false, reason: "low-unique-ratio-" + uniqueRatio.toFixed(3) };
  }

  if (String(input?.language || "").toLowerCase().startsWith("ru")) {
    const joined = textBlocks.join(" ");
    const letters = (joined.match(/\p{L}/gu) || []).length;
    const cyr = (joined.match(/[\u0400-\u04FF]/g) || []).length;
    const cyrRatio = letters > 0 ? cyr / letters : 0;
    if (letters > 120 && cyrRatio < 0.2) {
      return { ok: false, reason: "low-cyrillic-ratio-" + cyrRatio.toFixed(3) };
    }
  }

  return {
    ok: true,
    reason: "",
    stats: {
      textBlocks: textBlocks.length,
      avgTextLength: Math.round(avgTextLength),
      uniqueRatio: Number(uniqueRatio.toFixed(3)),
      placeholderRatio: Number(placeholderRatio.toFixed(3))
    }
  };
}
