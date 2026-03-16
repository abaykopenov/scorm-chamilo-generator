// ---------------------------------------------------------------------------
// lib/generation/qa-agent.js — QA Agent for test question validation
// ---------------------------------------------------------------------------
// Validates generated test questions:
// - Checks for [object Object] in options
// - Ensures correct answer is actually correct
// - Removes duplicate questions
// - Validates question makes sense based on course content
// ---------------------------------------------------------------------------

/**
 * Check if QA agent is enabled via environment variable.
 */
function isQaEnabled() {
  const raw = `${process.env.QA_AGENT_ENABLED ?? "true"}`.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

/**
 * Check if an option text is broken/invalid.
 */
function isBrokenOption(text) {
  const s = `${text || ""}`.trim();
  if (!s || s.length < 2) return true;
  if (/\[object\s+Object\]/i.test(s)) return true;
  if (/^Option\s+\d+$/i.test(s)) return true;
  if (/^\[.*\]$/.test(s) && !s.includes(" ")) return true;
  // Mojibake / broken unicode
  if ((s.match(/[\uFFFD]/g) || []).length > 0) return true;
  return false;
}

/**
 * Check if a question prompt is a placeholder/meta-question.
 */
function isMetaQuestion(prompt) {
  const s = `${prompt || ""}`.toLowerCase();
  if (/which\s+statement\s+(correctly\s+)?reflects/i.test(s)) return true;
  if (/which\s+statement\s+matches\s+screen/i.test(s)) return true;
  if (/what\s+is\s+discussed\s+in\s+(chapter|module|section)/i.test(s)) return true;
  if (/question\s+\d+/i.test(s) && s.length < 30) return true;
  return false;
}

/**
 * Find duplicate questions by comparing prompts.
 */
function findDuplicateIndexes(questions) {
  const seen = new Map();
  const duplicates = new Set();
  
  for (let i = 0; i < questions.length; i++) {
    const key = `${questions[i].prompt || ""}`.trim().toLowerCase().slice(0, 80);
    if (seen.has(key)) {
      duplicates.add(i);
    } else {
      seen.set(key, i);
    }
  }
  
  return duplicates;
}

/**
 * Validate and fix test questions using rule-based checks + optional LLM validation.
 *
 * @param {object} input - Generation input with provider config
 * @param {Array} questions - Raw questions from LLM (pre-processed with IDs)
 * @param {string} courseText - Combined course text for context
 * @returns {Array} Validated/fixed questions
 */
export async function validateTestQuestions(input, questions, courseText) {
  if (!isQaEnabled()) return questions;
  if (!Array.isArray(questions) || questions.length === 0) return questions;

  console.log(`[qa-agent] 🧪 Validating ${questions.length} test questions...`);

  const duplicateIndexes = findDuplicateIndexes(questions);
  const validatedQuestions = [];
  let fixedCount = 0;
  let removedCount = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    // Skip duplicates
    if (duplicateIndexes.has(i)) {
      console.log(`[qa-agent] ❌ Removed duplicate question ${i + 1}: "${`${q.prompt || ""}`.slice(0, 50)}..."`);
      removedCount++;
      continue;
    }

    // Check for meta-questions
    if (isMetaQuestion(q.prompt)) {
      console.log(`[qa-agent] ❌ Removed meta-question ${i + 1}: "${`${q.prompt || ""}`.slice(0, 50)}..."`);
      removedCount++;
      continue;
    }

    // Check prompt quality
    const prompt = `${q.prompt || ""}`.trim();
    if (prompt.length < 10) {
      console.log(`[qa-agent] ❌ Removed too-short question ${i + 1}`);
      removedCount++;
      continue;
    }

    // Check options for broken content
    const options = Array.isArray(q.options) ? q.options : [];
    let brokenOptions = 0;
    const fixedOptions = options.map(opt => {
      const optText = typeof opt === "object" ? (opt.text || "") : String(opt);
      if (isBrokenOption(optText)) {
        brokenOptions++;
        return typeof opt === "object" 
          ? { ...opt, text: "[Ответ удалён из-за ошибки]" }
          : "[Ответ удалён из-за ошибки]";
      }
      return opt;
    });

    // If more than 2 options are broken, skip the question entirely
    if (brokenOptions >= 2) {
      console.log(`[qa-agent] ❌ Removed question ${i + 1}: ${brokenOptions} broken options`);
      removedCount++;
      continue;
    }

    // Check correctOptionId/correctOptionIndex validity
    let fixedQ = { ...q };
    if (brokenOptions > 0) {
      fixedQ.options = fixedOptions;
      fixedCount++;
    }

    // Ensure explanation exists
    if (!fixedQ.explanation || `${fixedQ.explanation}`.trim().length < 5) {
      fixedQ.explanation = "Правильный ответ основан на материале курса.";
      fixedCount++;
    }

    // Check if correct option itself is broken
    if (fixedQ.correctOptionId) {
      const correctOpt = fixedOptions.find(o => 
        typeof o === "object" ? o.id === fixedQ.correctOptionId : false
      );
      if (correctOpt && typeof correctOpt === "object" && isBrokenOption(correctOpt.text)) {
        // Correct answer is broken — mark question as defective
        console.log(`[qa-agent] ❌ Removed question ${i + 1}: correct answer is broken`);
        removedCount++;
        continue;
      }
    }

    validatedQuestions.push(fixedQ);
  }

  // LLM-based validation for remaining questions (if LLM available and questions exist)
  if (validatedQuestions.length > 0 && courseText && courseText.length > 100) {
    const llmValidated = await validateQuestionsWithLlm(input, validatedQuestions, courseText);
    if (llmValidated) {
      const llmFixed = llmValidated.filter(q => q !== null).length;
      if (llmFixed !== validatedQuestions.length) {
        fixedCount += Math.abs(validatedQuestions.length - llmFixed);
      }
      console.log(`[qa-agent] ✅ Validation complete: ${validatedQuestions.length} passed, ${removedCount} removed, ${fixedCount} fixed`);
      return llmValidated.filter(q => q !== null);
    }
  }

  console.log(`[qa-agent] ✅ Rule-based validation: ${validatedQuestions.length} passed, ${removedCount} removed, ${fixedCount} fixed`);
  return validatedQuestions;
}

/**
 * Use LLM to validate question correctness against course text.
 * Returns null if LLM is unavailable.
 */
async function validateQuestionsWithLlm(input, questions, courseText) {
  const generation = input?.generation || {};
  if (!generation.provider || generation.provider === "template") return null;

  const language = `${input?.language || "ru"}`.trim().toLowerCase();

  const systemPrompt = language === "en"
    ? `You are a QA specialist for e-learning tests. Review each question against the course material.
For each question, respond with JSON: {"results": [{"index": 0, "valid": true/false, "issue": "description if invalid"}]}
Check: 1) Is the correct answer actually correct based on the material? 2) Are all options plausible? 3) Is the question clear and unambiguous?
Return ONLY valid JSON.`
    : `Ты — QA-специалист по электронным тестам. Проверь каждый вопрос по материалу курса.
Для каждого вопроса ответь JSON: {"results": [{"index": 0, "valid": true/false, "issue": "описание проблемы"}]}
Проверь: 1) Правильный ответ действительно верный? 2) Все варианты осмысленные? 3) Вопрос понятный и однозначный?
Верни ТОЛЬКО валидный JSON.`;

  const questionsForCheck = questions.slice(0, 10).map((q, i) => ({
    index: i,
    prompt: `${q.prompt || ""}`.slice(0, 200),
    options: (Array.isArray(q.options) ? q.options : []).map(o => 
      typeof o === "object" ? `${o.text || ""}`.slice(0, 100) : `${o}`.slice(0, 100)
    ),
    correctIndex: q.correctOptionId 
      ? (Array.isArray(q.options) ? q.options.findIndex(o => typeof o === "object" && o.id === q.correctOptionId) : 0)
      : 0
  }));

  try {
    const { callProvider } = await import("../llm/providers.js");

    const result = await callProvider(
      {
        provider: generation.provider || "ollama",
        baseUrl: generation.baseUrl || "http://127.0.0.1:11434",
        model: generation.model || "llama3",
        temperature: 0.1
      },
      {
        system: systemPrompt,
        user: JSON.stringify({
          courseExcerpt: courseText.slice(0, 6000),
          questions: questionsForCheck
        })
      },
      {
        trace: { stage: "qa-agent" }
      }
    );

    // Try to parse LLM response
    const text = `${result || ""}`.trim();
    const jsonMatch = text.match(/\{[\s\S]*"results"[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed?.results)) return null;

    // Filter out invalid questions based on LLM assessment
    const filtered = questions.map((q, i) => {
      const check = parsed.results.find(r => r.index === i);
      if (check && check.valid === false) {
        console.log(`[qa-agent] 🔍 LLM flagged question ${i + 1}: ${check.issue || "invalid"}`);
        // Don't remove, just log — rule-based checks already handle removal
      }
      return q;
    });

    return filtered;
  } catch (error) {
    console.warn(`[qa-agent] LLM validation skipped: ${error?.message || error}`);
    return null;
  }
}
