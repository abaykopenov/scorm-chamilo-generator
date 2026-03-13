import { clampInt, escapeMarkdown, PROGRESS_STEP_PERCENT, normalizeModelName,
  GENERATION_PROVIDER, GENERATION_MODEL, GENERATION_BASE_URL, GENERATION_TEMPERATURE,
  EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_BASE_URL, RAG_TOP_K, BOT_LANGUAGE,
  MAX_GENERATIONS_PER_HOUR } from "../config.mjs";
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
import { getIndexedMaterialSummary } from "../../../lib/material-indexer.js";
import prisma from "../../../lib/db.js";

const generationQueue = [];
let isQueueRunning = false;

function resolveGenerationConfig(defaults, chatId) {
  const config = { ...defaults.generation };
  const session = chatId ? getChatSession(chatId, false) : null;
  const sessionModel = normalizeModelName(session?.generationModel);
  if (GENERATION_PROVIDER) config.provider = GENERATION_PROVIDER;
  if (GENERATION_MODEL) config.model = GENERATION_MODEL;
  if (GENERATION_BASE_URL) config.baseUrl = GENERATION_BASE_URL;
  if (GENERATION_TEMPERATURE != null) config.temperature = GENERATION_TEMPERATURE;
  if (sessionModel) {
    config.model = sessionModel;
    if (config.provider === "template") config.provider = "ollama";
  }
  return config;
}

function resolveEmbeddingConfig(defaults, chatId) {
  const fb = defaults?.rag?.embedding || { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text" };
  const provider = EMBEDDING_PROVIDER || fb.provider;
  const config = {
    provider: ["ollama", "openai-compatible"].includes(provider) ? provider : "ollama",
    baseUrl: EMBEDDING_BASE_URL || fb.baseUrl,
    model: EMBEDDING_MODEL || fb.model
  };
  const session = chatId ? getChatSession(chatId, false) : null;
  const sessionEmbed = normalizeModelName(session?.embeddingModel);
  if (sessionEmbed) config.model = sessionEmbed;
  return config;
}

export { resolveGenerationConfig, resolveEmbeddingConfig };

async function pruneUnavailableMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session || session.materialIds.length === 0) return [];
  const current = session.materialIds.slice();
  const summary = await getIndexedMaterialSummary(current).catch(() => []);
  const available = new Set(summary.map(i => i.id));
  const filtered = current.filter(id => available.has(id));
  if (filtered.length !== current.length) {
    session.materialIds = filtered;
    await saveState();
  }
  return filtered;
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
    language: BOT_LANGUAGE,
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
      enabled: materialIds.length > 0,
      topK: RAG_TOP_K,
      documentIds: materialIds,
      embedding
    }
  };

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

  try {
    const input = await buildGenerateInputForChat(chatId, parsed, isQuiz);
    const materialCount = Array.isArray(input?.rag?.documentIds) ? input.rag.documentIds.length : 0;
    const initialText = isQuiz
      ? t("genStartingQuiz", escapeMarkdown(parsed.title), materialCount)
      : t("genStarting", escapeMarkdown(parsed.title), materialCount);

    const progressMsg = await sendMessage(chatId, initialText);
    progressMsgId = progressMsg?.message_id;

    const course = await generateCourseDraft(input, {
      onProgress: (percent, stage, message) => {
        const value = clampInt(percent, 0, 0, 100);
        if (value < lastProgress + Math.max(10, PROGRESS_STEP_PERCENT) && value !== 100) return;
        lastProgress = value;
        const statusText = formatProgressMessage(value, stage || "", message || "", startedAt);
        if (progressMsgId) void editMessageText(chatId, progressMsgId, statusText).catch(() => {});
      }
    });

    const savedCourse = await saveCourse({
      ...course,
      generationStatus: "completed",
      completedModules: Array.isArray(course?.modules) ? course.modules.length : 0,
      lastError: ""
    });

    if (progressMsgId) void editMessageText(chatId, progressMsgId, t("genPacking")).catch(() => {});

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
    await executeGeneration(task.chatId, task.parsed, task.isQuiz);
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

  const log = await prisma.generationLog.create({
    data: { chatId: String(chatId), title: parsed.topic + (isQuiz ? " (Quiz)" : ""), status: "started" }
  });

  const statusMsg = await sendMessage(chatId, t("genQueued", generationQueue.length + 1));
  generationQueue.push({ chatId, parsed, isQuiz, statusMsgId: statusMsg?.message_id });

  try {
    await processGenerationQueue();
    await prisma.generationLog.update({ where: { id: log.id }, data: { status: "completed" } });
    await prisma.telegramUser.update({ where: { id: String(chatId) }, data: { generationsCount: { increment: 1 } } });
  } catch (e) {
    await prisma.generationLog.update({ where: { id: log.id }, data: { status: "failed" } });
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
