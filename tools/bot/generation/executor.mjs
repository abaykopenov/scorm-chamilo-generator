import { clampInt, escapeMarkdown, PROGRESS_STEP_PERCENT, normalizeModelName,
  GENERATION_PROVIDER, GENERATION_MODEL, GENERATION_BASE_URL, GENERATION_API_KEY, GENERATION_TEMPERATURE,
  BOT_LANGUAGE, MAX_GENERATIONS_PER_HOUR } from "../config.mjs";
import { isRagLlmEnabled } from "../../../lib/rag-llm-client.js";
import { sendMessage, editMessageText, sendDocument } from "../api.mjs";
import { getChatSession, activeChats, saveState, getCourseSettings, checkRateLimit } from "../state.mjs";
import { formatProgressMessage } from "../ui/progress.mjs";
import { buildScreenPreviewMessage } from "../ui/preview.mjs";
import { courseActionsKeyboard } from "../ui/keyboards.mjs";
import { t } from "../i18n/index.mjs";
import { createDefaultGenerateInput } from "../../../lib/course-defaults.js";
import { generateCourseDraft } from "../../../lib/course-generator.js";
import { saveCourse } from "../../../lib/course-store.js";
import { exportCourseToScormArchive } from "../../../lib/scorm/exporter.js";
import { normalizeCoursePayload } from "../../../lib/validation/course.js";
import prisma from "../../../lib/db.js";
import { postprocessGeneratedCourse } from "../../../lib/course-postprocess.js";
import { translateCourse } from "../../../lib/translation/translator-client.js";

const generationQueue = [];
let isQueueRunning = false;

const CYRILLIC_RE = /[\u0400-\u04ff]/;

const SUPPORTED_LANGUAGES = ["ru", "en", "kk"];

function resolveOutputLanguage(outputLanguage, fallback) {
  const lang = `${outputLanguage || ""}`.trim().toLowerCase();
  if (SUPPORTED_LANGUAGES.includes(lang)) return lang;
  // "auto" — use fallback (BOT_LANGUAGE from env)
  return fallback || "ru";
}

const CLOUD_PROVIDERS = {
  groq:       { baseUrl: "https://api.groq.com/openai/v1",       defaultModel: "llama-3.3-70b-versatile" },
  gemini:     { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1",         defaultModel: "deepseek/deepseek-chat-v3-0324:free" },
};

function resolveGenerationConfig(defaults, chatId) {
  const config = { ...defaults.generation };
  const session = chatId ? getChatSession(chatId, false) : null;
  const sessionModel = normalizeModelName(session?.generationModel);

  // 1) Cloud provider via TG settings (/status → Провайдер)
  if (session?.cloudProvider && session?.cloudApiKey && CLOUD_PROVIDERS[session.cloudProvider]) {
    const cloud = CLOUD_PROVIDERS[session.cloudProvider];
    config.provider = "openai-compatible";
    config.apiKey = session.cloudApiKey;
    config.model = session.cloudModelName || cloud.defaultModel;
    config.baseUrl = cloud.baseUrl;
    return config;
  }

  // 2) Local Ollama model via TG settings (/status → Модель)
  if (sessionModel) {
    config.provider = "ollama";
    config.model = sessionModel;
    config.baseUrl = "http://127.0.0.1:11434";
    config.apiKey = "";
    return config;
  }

  // 3) Fallback: env vars (if any) or defaults from course-defaults.js
  if (GENERATION_PROVIDER) config.provider = GENERATION_PROVIDER;
  if (GENERATION_MODEL) config.model = GENERATION_MODEL;
  if (GENERATION_BASE_URL) config.baseUrl = GENERATION_BASE_URL;
  if (GENERATION_API_KEY) config.apiKey = GENERATION_API_KEY;
  if (GENERATION_TEMPERATURE != null) config.temperature = GENERATION_TEMPERATURE;
  return config;
}

// Embedding config no longer needed - RAG is handled by external RAG-LLM service
// Kept for backwards compatibility, returns minimal config
function resolveEmbeddingConfig(defaults, chatId) {
  return {
    provider: "rag-llm",
    baseUrl: process.env.RAG_LLM_URL || "http://127.0.0.1:8000",
    model: "rag-llm"
  };
}

export { resolveGenerationConfig, resolveEmbeddingConfig };

// Returns material IDs from session without validation (RAG-LLM handles availability)
async function pruneUnavailableMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session || !session.materialIds || session.materialIds.length === 0) return [];
  return session.materialIds.slice();
}

async function buildGenerateInputForChat(chatId, parsed, isQuiz) {
  const defaults = createDefaultGenerateInput();
  const materialIds = await pruneUnavailableMaterials(chatId);
  const generation = resolveGenerationConfig(defaults, chatId);
  const embedding = resolveEmbeddingConfig(defaults, chatId);
  const settings = getCourseSettings(chatId);

  const input = {
    ...defaults,
    titleHint: parsed.title,
    audience: parsed.audience || defaults.audience,
    learningGoals: parsed.goals.length > 0 ? parsed.goals : defaults.learningGoals,
    language: resolveOutputLanguage(settings.outputLanguage, BOT_LANGUAGE),
    structure: {
      ...defaults.structure,
      moduleCount: settings.moduleCount,
      sectionsPerModule: settings.sectionsPerModule
    },
    finalTest: {
      ...defaults.finalTest,
      enabled: true,
      questionCount: settings.questionCount,
      passingScore: settings.passingScore
    },
    generation,
    rag: {
      ...defaults.rag,
      enabled: materialIds.length > 0 || isRagLlmEnabled(),
      topK: RAG_TOP_K,
      documentIds: materialIds,
      embedding
    }
  };

  console.log(`[executor] Language resolved: outputLanguage="${settings.outputLanguage}", BOT_LANGUAGE="${BOT_LANGUAGE}", final="${input.language}"`);
  console.log(`[executor] Generation: provider="${generation.provider}", model="${generation.model}", baseUrl="${generation.baseUrl}", hasApiKey=${Boolean(generation.apiKey)}, apiKeyPrefix="${(generation.apiKey||'').slice(0,8)}..."`);

  if (isQuiz) {
    input.isQuizOnly = true;
    input.finalTest.questionCount = Math.max(input.finalTest.questionCount, 15);
  }

  return input;
}

async function executeGeneration(chatId, parsed, isQuiz) {
  const chatKey = `${chatId}`;
  activeChats.add(chatKey);
  let lastProgress = -PROGRESS_STEP_PERCENT;
  let progressMsgId = null;
  const startedAt = Date.now();
  const settings = getCourseSettings(chatId);

  try {
    const input = await buildGenerateInputForChat(chatId, parsed, isQuiz);
    const materialCount = Array.isArray(input?.rag?.documentIds) ? input.rag.documentIds.length : 0;
    const initialText = isQuiz
      ? t("genStartingQuiz", escapeMarkdown(parsed.title), materialCount)
      : t("genStarting", escapeMarkdown(parsed.title), materialCount);

    const progressMsg = await sendMessage(chatId, initialText);
    progressMsgId = progressMsg?.message_id;
    const draftMsg = progressMsgId; 

    // 1 & 2. Build Course Draft
    const finalJson = await generateCourseDraft(input, {
      onProgress: (percent, stage, message) => {
        const value = clampInt(percent, 0, 0, 100);
        if (value < lastProgress + Math.max(10, PROGRESS_STEP_PERCENT) && value !== 100) return;
        lastProgress = value;
        const statusText = formatProgressMessage(value, stage || "", message || "", startedAt);
        if (draftMsg) void editMessageText(chatId, draftMsg, statusText).catch(() => {});
      }
    });

    // 3. Post-process
    const cleanedJson = postprocessGeneratedCourse(finalJson, input);

    // 4. Finalize
    await editMessageText(chatId, draftMsg, `🔄 *Финализация*\\n\\n🧹 Очистка курса...`);
    const translatedJson = cleanedJson;

    // 5. Final Validation
    const validDraft = normalizeCoursePayload(translatedJson);

    // Save course
    const savedCourse = await saveCourse({
      ...validDraft,
      generationStatus: "completed",
      completedModules: Array.isArray(validDraft?.modules) ? validDraft.modules.length : 0,
      lastError: ""
    });

    // Export to archives
    await editMessageText(chatId, draftMsg, `📦 Упаковка архивов...`);

    const archive = await exportCourseToScormArchive(savedCourse);
    await sendDocument(chatId, archive.zipBuffer, archive.fileName, [
      `SCORM готов: ${escapeMarkdown(savedCourse.title)}`,
      `Course ID: ${savedCourse.id}`,
      `SCO: ${archive.scoCount}`
    ].join("\n"));

    if (progressMsgId) void editMessageText(chatId, progressMsgId, t("genDone")).catch(() => {});

    const previewMsg = buildScreenPreviewMessage(savedCourse, 0);
    if (previewMsg.text) {
      await sendMessage(chatId, previewMsg.text, previewMsg.reply_markup ? { reply_markup: previewMsg.reply_markup } : {});
    }
  } catch (error) {
    const msg = t("genError", escapeMarkdown(error instanceof Error ? error.message : "unknown error"));
    if (progressMsgId) void editMessageText(chatId, progressMsgId, msg).catch(() => {});
    else await sendMessage(chatId, msg);
  } finally {
    activeChats.delete(chatKey);
  }
}

async function processGenerationQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;
  while (generationQueue.length > 0) {
    const task = generationQueue.shift();
    try {
      await executeGeneration(task.chatId, task.parsed, task.isQuiz);
      if (task.logId) {
        await prisma.generationLog.update({ where: { id: task.logId }, data: { status: "completed" } });
        await prisma.telegramUser.update({ where: { id: String(task.chatId) }, data: { generationsCount: { increment: 1 } } });
      }
    } catch (e) {
      if (task.logId) {
        await prisma.generationLog.update({ where: { id: task.logId }, data: { status: "failed" } });
      }
    }
    for (const [i, waitTask] of generationQueue.entries()) {
      void editMessageText(waitTask.chatId, waitTask.statusMsgId, t("genQueued", i + 1)).catch(() => {});
    }
  }
  isQueueRunning = false;
}

export async function handleCreateCommand(chatId, parsed, isQuiz = false) {
  // Check if user already has an active generation
  const chatKey = `${chatId}`;
  if (activeChats.has(chatKey)) {
    await sendMessage(chatId, "⏳ У вас уже идёт генерация. Дождитесь её завершения.");
    return;
  }

  // Rate limit check
  const check = checkRateLimit(chatId, "generate", MAX_GENERATIONS_PER_HOUR);
  if (!check.allowed) {
    await sendMessage(chatId, t("genRateLimit", check.waitMinutes));
    return;
  }

  try {
    const log = await prisma.generationLog.create({
      data: { chatId: String(chatId), title: parsed.topic + (isQuiz ? " (Quiz)" : ""), status: "started" }
    });

    const statusMsg = await sendMessage(chatId, t("genQueued", generationQueue.length + 1));
    generationQueue.push({ chatId, parsed, isQuiz, statusMsgId: statusMsg?.message_id, logId: log.id });
    
    // Fire and forget: run queue in background so bot doesn't hang!
    processGenerationQueue().catch(e => console.error("[executor] Queue error:", e));
  } catch (e) {
    console.error("[executor] Failed to enqueue:", e);
    await sendMessage(chatId, "❌ Ошибка постановки в очередь генерации.");
  }
}

export function parseCreateArgs(rawArgs, cmd = "/create") {
  const args = `${rawArgs || ""}`.trim();
  if (!args) return { ok: false, message: cmd === "/quiz" ? t("quizFormat") : t("createFormat") };
  const parts = args.split("|").map(p => p.trim()).filter(Boolean);
  const title = `${parts[0] || ""}`.trim().slice(0, 160);
  if (!title) return { ok: false, message: t("createNoTopic", cmd) };
  const audience = `${parts[1] || ""}`.trim().slice(0, 160);
  const goals = `${parts[2] || ""}`.split(/[,;\n]/).map(p => p.trim()).filter(Boolean).slice(0, 8);
  return { ok: true, topic: title, title, audience, goals };
}
