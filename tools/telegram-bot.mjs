import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDefaultGenerateInput } from "../lib/course-defaults.js";
import { generateCourseDraft } from "../lib/course-generator.js";
import { isSupportedTextMaterial } from "../lib/document-parser.js";
import { indexMaterialDocument, getIndexedMaterialSummary } from "../lib/material-indexer.js";
import { saveUploadedMaterial } from "../lib/material-store.js";
import { saveCourse, getCourse } from "../lib/course-store.js";
import { exportCourseToScormArchive } from "../lib/scorm/exporter.js";
import { loadLocalEnvFiles } from "./load-env.mjs";
import prisma from "../lib/db.js";
import { sendAuthCode } from "../lib/mailer.js";

const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || "@university.edu")
  .split(",")
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);


loadLocalEnvFiles();

const BOT_TOKEN = `${process.env.TELEGRAM_BOT_TOKEN || ""}`.trim();
const TELEGRAM_API_URL = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

const POLL_TIMEOUT_SECONDS = clampInt(process.env.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS, 25, 5, 50);
const PROGRESS_STEP_PERCENT = clampInt(process.env.TELEGRAM_BOT_PROGRESS_STEP_PERCENT, 25, 10, 50);
const RETRY_DELAY_MS = 2500;
const BOT_LANGUAGE = `${process.env.TELEGRAM_BOT_LANGUAGE || ""}`.trim().toLowerCase() === "en" ? "en" : "ru";
const STATE_FILE_PATH = path.join(process.cwd(), ".data", "telegram-bot", "state.json");

const MAX_UPLOAD_SIZE_MB = clampInt(process.env.TELEGRAM_BOT_MAX_FILE_SIZE_MB, 50, 1, 200);
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_CHAT_MATERIALS = clampInt(process.env.TELEGRAM_BOT_MAX_CHAT_MATERIALS, 12, 1, 100);
const MAX_SESSION_FILE_ENTRIES = clampInt(process.env.TELEGRAM_BOT_MAX_FILE_ENTRIES, 40, 10, 300);
const RAG_TOP_K = clampInt(process.env.TELEGRAM_BOT_RAG_TOP_K, 6, 1, 30);

const GENERATION_PROVIDER = normalizeGenerationProvider(process.env.TELEGRAM_BOT_GENERATION_PROVIDER);
const GENERATION_MODEL = `${process.env.TELEGRAM_BOT_GENERATION_MODEL || ""}`.trim();
const GENERATION_BASE_URL = `${process.env.TELEGRAM_BOT_GENERATION_BASE_URL || ""}`.trim();
const GENERATION_TEMPERATURE = clampFloat(process.env.TELEGRAM_BOT_GENERATION_TEMPERATURE, null, 0, 1);

const EMBEDDING_PROVIDER = normalizeEmbeddingProvider(process.env.TELEGRAM_BOT_EMBEDDING_PROVIDER);
const EMBEDDING_MODEL = `${process.env.TELEGRAM_BOT_EMBEDDING_MODEL || ""}`.trim();
const EMBEDDING_BASE_URL = `${process.env.TELEGRAM_BOT_EMBEDDING_BASE_URL || ""}`.trim();

const ALLOWED_CHAT_IDS = new Set(
  `${process.env.TELEGRAM_BOT_ALLOWED_CHAT_IDS || ""}`
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const activeChats = new Set();
let stopped = false;
let botState = createEmptyState();

function clampInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function clampFloat(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeGenerationProvider(value) {
  const provider = `${value || ""}`.trim().toLowerCase();
  if (["template", "ollama", "openai-compatible"].includes(provider)) {
    return provider;
  }
  return "";
}

function normalizeEmbeddingProvider(value) {
  const provider = `${value || ""}`.trim().toLowerCase();
  if (["ollama", "openai-compatible"].includes(provider)) {
    return provider;
  }
  return "";
}

function normalizeModelName(value) {
  return `${value || ""}`.trim().slice(0, 200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function escapeMarkdown(text) {
  return `${text || ""}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isAllowedChat(chatId) {
  if (ALLOWED_CHAT_IDS.size === 0) {
    return true;
  }
  return ALLOWED_CHAT_IDS.has(`${chatId}`);
}

function createEmptyState() {
  return {
    offset: 0,
    chatSessions: {}
  };
}

function normalizeSessionFileEntry(value) {
  return {
    materialId: `${value?.materialId || ""}`.trim(),
    telegramFileId: `${value?.telegramFileId || ""}`.trim(),
    fileName: `${value?.fileName || "file"}`.trim() || "file",
    mimeType: `${value?.mimeType || ""}`.trim(),
    size: Math.max(0, Number(value?.size) || 0),
    status: ["indexed", "failed", "uploaded"].includes(`${value?.status || ""}`) ? value.status : "uploaded",
    message: `${value?.message || ""}`.trim(),
    updatedAt: `${value?.updatedAt || ""}`.trim() || nowIso()
  };
}

function normalizeSession(value) {
  const materialIds = Array.isArray(value?.materialIds)
    ? Array.from(new Set(value.materialIds.map((item) => `${item || ""}`.trim()).filter(Boolean)))
    : [];

  const files = Array.isArray(value?.files)
    ? value.files.map(normalizeSessionFileEntry).slice(-MAX_SESSION_FILE_ENTRIES)
    : [];

  return {
    materialIds: materialIds.slice(-MAX_CHAT_MATERIALS),
    generationModel: normalizeModelName(value?.generationModel),
    embeddingModel: normalizeModelName(value?.embeddingModel),
    files,
    updatedAt: `${value?.updatedAt || ""}`.trim() || nowIso()
  };
}

function normalizeState(value) {
  const base = createEmptyState();
  const offsetRaw = Math.trunc(Number(value?.offset));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const sessionsRaw = value?.chatSessions && typeof value.chatSessions === "object"
    ? value.chatSessions
    : {};

  const chatSessions = {};
  for (const [chatId, session] of Object.entries(sessionsRaw)) {
    const key = `${chatId || ""}`.trim();
    if (!key) {
      continue;
    }
    chatSessions[key] = normalizeSession(session);
  }

  return {
    ...base,
    offset,
    chatSessions
  };
}

async function loadState() {
  try {
    const content = await readFile(STATE_FILE_PATH, "utf8");
    const parsed = JSON.parse(content);
    return normalizeState(parsed);
  } catch {
    return createEmptyState();
  }
}

async function saveState() {
  await mkdir(path.dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(
    STATE_FILE_PATH,
    `${JSON.stringify({
      ...botState,
      updatedAt: nowIso()
    }, null, 2)}\n`,
    "utf8"
  );
}

function getChatSession(chatId, createIfMissing = true) {
  const key = `${chatId || ""}`.trim();
  if (!key) {
    return null;
  }
  const existing = botState.chatSessions[key];
  if (existing) {
    return existing;
  }
  if (!createIfMissing) {
    return null;
  }
  const created = normalizeSession({});
  botState.chatSessions[key] = created;
  return created;
}

function upsertSessionFile(chatId, entry) {
  const session = getChatSession(chatId, true);
  if (!session) {
    return;
  }
  const normalizedEntry = normalizeSessionFileEntry(entry);
  const uniqueKey = normalizedEntry.materialId || normalizedEntry.telegramFileId || `${normalizedEntry.fileName}:${normalizedEntry.size}`;
  session.files = [
    ...session.files.filter((item) => {
      const itemKey = item.materialId || item.telegramFileId || `${item.fileName}:${item.size}`;
      return itemKey !== uniqueKey;
    }),
    normalizedEntry
  ].slice(-MAX_SESSION_FILE_ENTRIES);
  session.updatedAt = nowIso();
}

function attachMaterialToSession(chatId, materialId) {
  const session = getChatSession(chatId, true);
  if (!session) {
    return;
  }
  const cleanId = `${materialId || ""}`.trim();
  if (!cleanId) {
    return;
  }
  session.materialIds = [...session.materialIds.filter((id) => id !== cleanId), cleanId].slice(-MAX_CHAT_MATERIALS);
  session.updatedAt = nowIso();
}

function setChatGenerationModel(chatId, modelName) {
  const session = getChatSession(chatId, true);
  if (!session) {
    return "";
  }
  const normalized = normalizeModelName(modelName);
  session.generationModel = normalized;
  session.updatedAt = nowIso();
  return normalized;
}

function setChatEmbeddingModel(chatId, modelName) {
  const session = getChatSession(chatId, true);
  if (!session) {
    return "";
  }
  const normalized = normalizeModelName(modelName);
  session.embeddingModel = normalized;
  session.updatedAt = nowIso();
  return normalized;
}

function clearSessionMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session) {
    return false;
  }
  session.materialIds = [];
  session.files = [];
  session.updatedAt = nowIso();
  return true;
}

async function pruneUnavailableMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session || session.materialIds.length === 0) {
    return [];
  }

  const current = session.materialIds.slice();
  const summary = await getIndexedMaterialSummary(current).catch(() => []);
  const available = new Set(summary.map((item) => item.id));
  const filtered = current.filter((id) => available.has(id));

  if (filtered.length !== current.length) {
    session.materialIds = filtered;
    session.updatedAt = nowIso();
    await saveState();
  }

  return filtered;
}

function parseCommand(rawText) {
  const text = `${rawText || ""}`.trim();
  if (!text.startsWith("/")) {
    return {
      command: "",
      args: text
    };
  }

  const firstSpace = text.indexOf(" ");
  const token = (firstSpace === -1 ? text : text.slice(0, firstSpace)).trim();
  const args = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
  return {
    command: token.split("@")[0].toLowerCase(),
    args
  };
}

function parseCreateArgs(rawArgs, cmd = "/create") {
  const args = `${rawArgs || ""}`.trim();
  if (!args) {
    return {
      ok: false,
      message: cmd === "/quiz"
        ? "Формат команды:\n/quiz <code>тема</code>"
        : [
          "Формат команды:",
          "/create <code>тема</code>",
          "/create <code>тема</code> | <code>аудитория</code> | <code>цель 1, цель 2</code>"
        ].join("\n")
    };
  }

  const parts = args.split("|").map((part) => part.trim()).filter(Boolean);
  const title = `${parts[0] || ""}`.trim().slice(0, 160);
  if (!title) {
    return {
      ok: false,
      message: `Не удалось прочитать тему. Укажите тему после команды ${cmd}.`
    };
  }

  const audience = `${parts[1] || ""}`.trim().slice(0, 160);
  const goals = `${parts[2] || ""}`
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    ok: true,
    topic: title,
    title,
    audience,
    goals
  };
}

function resolveGenerationConfig(defaults, chatId = null) {
  const config = {
    ...defaults.generation
  };

  const session = chatId ? getChatSession(chatId, false) : null;
  const sessionModel = normalizeModelName(session?.generationModel);

  if (GENERATION_PROVIDER) {
    config.provider = GENERATION_PROVIDER;
  }
  if (GENERATION_MODEL) {
    config.model = GENERATION_MODEL;
  }
  if (GENERATION_BASE_URL) {
    config.baseUrl = GENERATION_BASE_URL;
  }
  if (GENERATION_TEMPERATURE != null) {
    config.temperature = GENERATION_TEMPERATURE;
  }

  if (sessionModel) {
    config.model = sessionModel;
    if (config.provider === "template") {
      config.provider = "ollama";
    }
  }

  return config;
}

function resolveEmbeddingConfig(defaults, chatId = null) {
  const fallback = defaults?.rag?.embedding || {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "nomic-embed-text"
  };
  const provider = EMBEDDING_PROVIDER || fallback.provider;
  
  const config = {
    provider: ["ollama", "openai-compatible"].includes(provider) ? provider : "ollama",
    baseUrl: EMBEDDING_BASE_URL || fallback.baseUrl,
    model: EMBEDDING_MODEL || fallback.model
  };
  
  const session = chatId ? getChatSession(chatId, false) : null;
  const sessionEmbedModel = normalizeModelName(session?.embeddingModel);
  if (sessionEmbedModel) {
    config.model = sessionEmbedModel;
  }
  
  return config;
}

async function buildGenerateInputForChat(chatId, createArgs) {
  const defaults = createDefaultGenerateInput();
  const materialIds = await pruneUnavailableMaterials(chatId);
  const generation = resolveGenerationConfig(defaults, chatId);
  const embedding = resolveEmbeddingConfig(defaults, chatId);

  return {
    ...defaults,
    titleHint: createArgs.title,
    audience: createArgs.audience || defaults.audience,
    learningGoals: createArgs.goals.length > 0 ? createArgs.goals : defaults.learningGoals,
    language: BOT_LANGUAGE,
    generation,
    rag: {
      ...defaults.rag,
      enabled: materialIds.length > 0,
      topK: RAG_TOP_K,
      documentIds: materialIds,
      embedding
    }
  };
}

async function telegramCall(method, payload, options = {}) {
  const { multipart = false, timeoutSeconds = 40 } = options;
  const url = `${TELEGRAM_API_URL}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: multipart ? undefined : { "Content-Type": "application/json" },
    body: multipart ? payload : JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutSeconds * 1000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const description = `${data?.description || `HTTP ${response.status}`}`.trim();
    throw new Error(`Telegram API ${method} failed: ${description}`);
  }

  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  try {
    const result = await telegramCall("sendMessage", {
      chat_id: chatId,
      text: `${text || ""}`.slice(0, 4096),
      parse_mode: "HTML",
      ...options
    });
    return result;
  } catch (err) {
    if (err.message && err.message.includes("bot was blocked by the user")) {
      console.warn(`[telegram-bot] Attempted to message ${chatId}, but bot was blocked.`);
      return null;
    }
    throw err;
  }
}

async function editMessageText(chatId, messageId, text, options = {}) {
  try {
    const result = await telegramCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${text || ""}`.slice(0, 4096),
      parse_mode: "HTML",
      ...options
    });
    return result;
  } catch (err) {
    if (err.message && err.message.includes("message is not modified")) {
      return null;
    }
    console.warn(`[telegram-bot] Failed to edit message ${messageId}: ${err.message}`);
    return null;
  }
}

async function sendDocument(chatId, zipBuffer, fileName, caption) {
  const form = new FormData();
  form.set("chat_id", `${chatId}`);
  if (caption) {
    form.set("caption", `${caption}`.slice(0, 1024));
  }
  form.set(
    "document",
    new Blob([zipBuffer], { type: "application/zip" }),
    `${fileName || "course-scorm12.zip"}`
  );
  return telegramCall("sendDocument", form, { multipart: true, timeoutSeconds: 120 });
}

async function downloadTelegramFile(fileId) {
  const metadata = await telegramCall("getFile", { file_id: fileId });
  const filePath = `${metadata?.file_path || ""}`.trim();
  if (!filePath) {
    throw new Error("Telegram did not return file_path for this document.");
  }

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    throw new Error(`Failed to download file from Telegram (HTTP ${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Downloaded file is empty.");
  }

  return {
    buffer,
    filePath
  };
}

function findBestModelMatch(requestedModel, availableModels) {
  const requested = `${requestedModel || ""}`.trim().toLowerCase();
  const models = Array.isArray(availableModels) ? availableModels.filter(Boolean) : [];
  if (!requested || models.length === 0) {
    return "";
  }

  const exact = models.find((name) => name.toLowerCase() === requested);
  if (exact) {
    return exact;
  }

  const withTag = models.find((name) => name.toLowerCase().startsWith(`${requested}:`));
  if (withTag) {
    return withTag;
  }

  const contains = models.find((name) => name.toLowerCase().includes(requested));
  if (contains) {
    return contains;
  }

  return "";
}

async function fetchOllamaModelNames(baseUrl) {
  const normalizedBaseUrl = `${baseUrl || ""}`.trim().replace(/\/$/, "");
  if (!normalizedBaseUrl) {
    throw new Error("Ollama base URL is empty.");
  }

  const response = await fetch(`${normalizedBaseUrl}/api/tags`, {
    method: "GET",
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/tags returned HTTP ${response.status}.`);
  }

  const payload = await response.json().catch(() => ({}));
  const names = Array.isArray(payload?.models)
    ? payload.models.map((item) => `${item?.name || ""}`.trim()).filter(Boolean)
    : [];

  return Array.from(new Set(names));
}

function buildHelpText() {
  return [
    "🎓 <b>Добро пожаловать в SCORM Generator Bot!</b>",
    "Я помогу вам создать интерактивные курсы и тесты (SCORM 1.2) из ваших документов.",
    "",
    "🚀 <b>Генерация (Создание контента):</b>",
    "• /create <code>тема</code> — сгенерировать полноценный обучающий курс",
    "• /create <code>тема</code> | <code>аудитория</code> | <code>цель</code> — более точная генерация",
    "• /quiz <code>тема</code> — сгенерировать только тестирование (Quiz) по теме",
    "",
    "📚 <b>Как использовать свои файлы (RAG):</b>",
    "1️⃣ Просто отправьте мне любой документ <b>(PDF, DOCX, TXT и др.)</b>",
    "2️⃣ Я его проиндексирую и сохраню в память",
    "3️⃣ После загрузки вы сможете нажать кнопку <b>«Сгенерировать курс / тест»</b> — весь контент будет основан на вашем тексте!",
    "",
    "📁 <b>Управление файлами:</b>",
    "• /materials — посмотреть загруженные документы",
    "• /clear_materials — очистить список файлов",
    "",
    "⚙️ <b>Настройки системы:</b>",
    "• /status — посмотреть текущие лимиты и статус бота",
    "• /models — список доступных моделей (генерация)",
    "• /model <code>имя_модели</code> — выбрать модель генерации",
    "• /embed_models — список доступных моделей (эмбеддингов)",
    "• /embed_model <code>имя_модели</code> — выбрать эмбеддинг модель",
    "• /help — показать это меню"
  ].join("\n");
}

function buildStatusText(chatId) {
  const defaults = createDefaultGenerateInput();
  const generationConfig = resolveGenerationConfig(defaults, chatId);
  const embeddingConfig = resolveEmbeddingConfig(defaults, chatId);
  const session = getChatSession(chatId, false);
  const materialCount = session?.materialIds?.length || 0;
  const selectedModel = normalizeModelName(session?.generationModel);
  const selectedEmbedModel = normalizeModelName(session?.embeddingModel);

  return [
    "Статус Telegram-бота:",
    `- generation.provider: ${escapeMarkdown(generationConfig.provider)}`,
    `- generation.model: ${escapeMarkdown(generationConfig.model)}`,
    `- chat.model.override: ${escapeMarkdown(selectedModel || "none")}`,
    `- embedding.provider: ${escapeMarkdown(embeddingConfig.provider)}`,
    `- embedding.model: ${escapeMarkdown(embeddingConfig.model)}`,
    `- chat.embed_model.override: ${escapeMarkdown(selectedEmbedModel || "none")}`,
    `- generation.language: ${escapeMarkdown(BOT_LANGUAGE)}`,
    `- rag.topK: ${RAG_TOP_K}`,
    `- max upload size: ${MAX_UPLOAD_SIZE_MB} MB`,
    `- активных генераций: ${activeChats.size}`,
    `- материалов в этом чате: ${materialCount}`
  ].join("\n");
}

function buildMaterialsText(chatId) {
  const session = getChatSession(chatId, false);
  if (!session || session.files.length === 0) {
    return "В этом чате пока нет загруженных материалов.";
  }

  const lines = session.files
    .slice(-15)
    .reverse()
    .map((file, index) => {
      const mark = file.status === "indexed" ? "indexed" : file.status;
      return `${index + 1}. ${escapeMarkdown(file.fileName)} (${formatFileSize(file.size)}) - ${mark}${file.materialId ? ` [${file.materialId}]` : ""}`;
    });

  return [
    `Материалов в чате: ${session.materialIds.length}`,
    ...lines
  ].join("\n");
}

async function handleListModelsCommand(chatId) {
  try {
    const defaults = createDefaultGenerateInput();
    const generation = resolveGenerationConfig(defaults, chatId);
    const baseUrl = generation.baseUrl || defaults.generation.baseUrl;
    const models = await fetchOllamaModelNames(baseUrl);

    if (models.length === 0) {
      await sendMessage(chatId, `Ollama доступен, но список моделей пуст (${baseUrl}).`);
      return;
    }

    const session = getChatSession(chatId, false);
    const selectedModel = normalizeModelName(session?.generationModel);
    const effectiveModel = generation.model;

    const preview = models
      .slice(0, 20)
      .map((name) => {
        const escapedName = escapeMarkdown(name);
        if (name === selectedModel) {
          return `* ${escapedName} (chat override)`;
        }
        if (name === effectiveModel) {
          return `* ${escapedName} (active)`;
        }
        return `- ${escapedName}`;
      });

    const tail = models.length > 20 ? `\n... и еще ${models.length - 20}` : "";
    await sendMessage(
      chatId,
      [
        `Модели Ollama (${baseUrl}):`,
        ...preview,
        "",
        "Выбрать модель: /model <code>имя</code>",
        "Сброс: /model default"
      ].join("\n") + tail
    );
  } catch (error) {
    await sendMessage(chatId, `Не удалось получить список моделей: ${errorMessage(error, "unknown error")}`);
  }
}

async function handleModelCommand(chatId, args) {
  const raw = `${args || ""}`.trim();

  if (!raw) {
    const defaults = createDefaultGenerateInput();
    const generation = resolveGenerationConfig(defaults, chatId);
    const session = getChatSession(chatId, false);
    const selectedModel = normalizeModelName(session?.generationModel);

    await sendMessage(
      chatId,
      [
        `Текущая модель: ${escapeMarkdown(generation.model)}`,
        `Provider: ${escapeMarkdown(generation.provider)}`,
        `Override для чата: ${escapeMarkdown(selectedModel || "none")}`,
        "",
        "Установить: /model <code>имя</code>",
        "Сбросить: /model default",
        "Список моделей: /models"
      ].join("\n")
    );
    return;
  }

  const command = raw.toLowerCase();
  if (["default", "reset", "clear", "none"].includes(command)) {
    setChatGenerationModel(chatId, "");
    await saveState();

    const defaults = createDefaultGenerateInput();
    const generation = resolveGenerationConfig(defaults, chatId);
    await sendMessage(chatId, `Модель для чата сброшена. Активная модель: ${generation.model} (${generation.provider}).`);
    return;
  }

  try {
    const defaults = createDefaultGenerateInput();
    const generation = resolveGenerationConfig(defaults, chatId);
    const models = await fetchOllamaModelNames(generation.baseUrl || defaults.generation.baseUrl);
    const matched = findBestModelMatch(raw, models);
    const selected = matched || normalizeModelName(raw);
    setChatGenerationModel(chatId, selected);
    await saveState();

    if (matched) {
      await sendMessage(chatId, `Модель для чата установлена: ${escapeMarkdown(matched)}`);
      return;
    }

    await sendMessage(
      chatId,
      [
        `Модель установлена как: <code>${escapeMarkdown(selected)}</code>`,
        "В списке /models точного совпадения не найдено.",
        "Если модель не существует, генерация вернет ошибку."
      ].join("\n")
    );
  } catch (error) {
    await sendMessage(chatId, `Не удалось установить модель: ${escapeMarkdown(errorMessage(error, "unknown error"))}`);
  }
}

async function handleListEmbedModelsCommand(chatId) {
  try {
    const defaults = createDefaultGenerateInput();
    const embedding = resolveEmbeddingConfig(defaults, chatId);
    const baseUrl = embedding.baseUrl || defaults.rag.embedding.baseUrl;
    const models = await fetchOllamaModelNames(baseUrl);

    if (models.length === 0) {
      await sendMessage(chatId, `Ollama доступен, но список моделей пуст (${baseUrl}).`);
      return;
    }

    const session = getChatSession(chatId, false);
    const selectedModel = normalizeModelName(session?.embeddingModel);
    const effectiveModel = embedding.model;

    const preview = models
      .slice(0, 20)
      .map((name) => {
        const escapedName = escapeMarkdown(name);
        if (name === selectedModel) {
          return `* ${escapedName} (chat override)`;
        }
        if (name === effectiveModel) {
          return `* ${escapedName} (active)`;
        }
        return `- ${escapedName}`;
      });

    const tail = models.length > 20 ? `\n... и еще ${models.length - 20}` : "";
    await sendMessage(
      chatId,
      [
        `Модели Ollama для эмбеддингов (${baseUrl}):`,
        ...preview,
        "",
        "Выбрать модель: /embed_model <code>имя</code>",
        "Сброс: /embed_model default"
      ].join("\n") + tail
    );
  } catch (error) {
    await sendMessage(chatId, `Не удалось получить список моделей: ${escapeMarkdown(errorMessage(error, "unknown error"))}`);
  }
}

async function handleEmbedModelCommand(chatId, args) {
  const raw = `${args || ""}`.trim();

  if (!raw) {
    const defaults = createDefaultGenerateInput();
    const embedding = resolveEmbeddingConfig(defaults, chatId);
    const session = getChatSession(chatId, false);
    const selectedModel = normalizeModelName(session?.embeddingModel);

    await sendMessage(
      chatId,
      [
        `Текущая эмбеддинг модель: ${escapeMarkdown(embedding.model)}`,
        `Provider: ${escapeMarkdown(embedding.provider)}`,
        `Override для чата: ${escapeMarkdown(selectedModel || "none")}`,
        "",
        "Установить: /embed_model <code>имя</code>",
        "Сбросить: /embed_model default",
        "Список моделей: /embed_models"
      ].join("\n")
    );
    return;
  }

  const command = raw.toLowerCase();
  if (["default", "reset", "clear", "none"].includes(command)) {
    setChatEmbeddingModel(chatId, "");
    await saveState();

    const defaults = createDefaultGenerateInput();
    const embedding = resolveEmbeddingConfig(defaults, chatId);
    await sendMessage(chatId, `Эмбеддинг модель для чата сброшена. Активная модель: ${embedding.model} (${embedding.provider}).`);
    return;
  }

  try {
    const defaults = createDefaultGenerateInput();
    const embedding = resolveEmbeddingConfig(defaults, chatId);
    const models = await fetchOllamaModelNames(embedding.baseUrl || defaults.rag.embedding.baseUrl);
    const matched = findBestModelMatch(raw, models);
    const selected = matched || normalizeModelName(raw);
    setChatEmbeddingModel(chatId, selected);
    await saveState();

    if (matched) {
      await sendMessage(chatId, `Эмбеддинг модель для чата установлена: ${escapeMarkdown(matched)}`);
      return;
    }

    await sendMessage(
      chatId,
      [
        `Model установлена как: <code>${escapeMarkdown(selected)}</code>`,
        "В списке /embed_models точного совпадения не найдено.",
        "Если модель не существует, индексация вернет ошибку."
      ].join("\n")
    );
  } catch (error) {
    await sendMessage(chatId, `Не удалось установить модель: ${escapeMarkdown(errorMessage(error, "unknown error"))}`);
  }
}

const generationQueue = [];
let isQueueRunning = false;

async function processGenerationQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;

  while (generationQueue.length > 0) {
    const task = generationQueue.shift();
    await executeGeneration(task.chatId, task.parsed, task.isQuiz);

    // Notify next users about their position
    for (const [i, waitTask] of generationQueue.entries()) {
      void editMessageText(waitTask.chatId, waitTask.statusMsgId, `⏳ Вы в очереди. Ваше место: ${i + 1}`).catch(() => { });
    }
  }

  isQueueRunning = false;
}

async function handleCreateCommand(chatId, parsed, isQuiz = false) {
  const statusMsg = await sendMessage(chatId, `⏳ Добавлен в очередь. Вы ${generationQueue.length + 1}-й...`);
  const statusMsgId = statusMsg?.message_id;

  generationQueue.push({ chatId, parsed, isQuiz, statusMsgId });
  void processQueueWrapper();
}

async function processQueueWrapper() {
  try {
    await processGenerationQueue();
  } catch (e) {
    console.error(`[telegram-bot] queue processing error:`, e);
    isQueueRunning = false;
  }
}

async function executeGeneration(chatId, parsed, isQuiz) {
  const chatKey = `${chatId}`;
  activeChats.add(chatKey);
  let lastProgress = -PROGRESS_STEP_PERCENT;

  let progressMsgId = null;

  try {
    const input = await buildGenerateInputForChat(chatId, parsed);
    if (isQuiz) {
      input.isQuizOnly = true;
      input.finalTest = {
        ...input.finalTest,
        enabled: true,
        questionCount: 15 // make it a solid test
      };
    }

    const materialCount = Array.isArray(input?.rag?.documentIds) ? input.rag.documentIds.length : 0;
    const initialText = `🧠 Запускаю генерацию ${isQuiz ? "теста" : "курса"}: "${escapeMarkdown(parsed.title)}"${materialCount > 0 ? ` | материалов: ${materialCount}` : ""}\n[0%] Подготовка...`;

    const progressMsg = await sendMessage(chatId, initialText);
    progressMsgId = progressMsg?.message_id;

    const course = await generateCourseDraft(input, {
      onProgress: (percent, stage, message) => {
        const value = clampInt(percent, 0, 0, 100);
        if (value < lastProgress + Math.max(10, PROGRESS_STEP_PERCENT) && value !== 100) {
          return; // debounce quick edits to prevent Telegram rate limit
        }
        lastProgress = value;
        const stageText = `${stage || ""}`.trim();
        const messageText = `${message || ""}`.trim();
        const statusText = [
          `⏳ Прогресс: ${value}%`,
          stageText ? `Текущий этап: ${escapeMarkdown(stageText)}` : "",
          messageText ? `❯ ${escapeMarkdown(messageText)}` : ""
        ].filter(Boolean).join("\n");

        if (progressMsgId) {
          void editMessageText(chatId, progressMsgId, statusText).catch(() => { });
        }
      }
    });

    const savedCourse = await saveCourse({
      ...course,
      generationStatus: "completed",
      completedModules: Array.isArray(course?.modules) ? course.modules.length : 0,
      lastError: ""
    });

    if (progressMsgId) {
      void editMessageText(chatId, progressMsgId, `🚀 Упаковываю SCORM-архив...`).catch(() => { });
    }

    const archive = await exportCourseToScormArchive(savedCourse);
    await sendDocument(
      chatId,
      archive.zipBuffer,
      archive.fileName,
      [
        `SCORM готов: ${escapeMarkdown(savedCourse.title)}`,
        `Course ID: ${savedCourse.id}`,
        `SCO: ${archive.scoCount}`
      ].join("\n")
    );

    if (progressMsgId) {
      void editMessageText(chatId, progressMsgId, `✅ SCORM сгенерирован успешно!`).catch(() => { });
    }

    const previewMsg = buildScreenPreviewMessage(savedCourse, 0);
    if (previewMsg.text) {
      await sendMessage(chatId, previewMsg.text, previewMsg.reply_markup ? { reply_markup: previewMsg.reply_markup } : {});
    }
  } catch (error) {
    if (progressMsgId) {
      void editMessageText(chatId, progressMsgId, `❌ Ошибка генерации: ${escapeMarkdown(errorMessage(error, "unknown error"))}`).catch(() => { });
    } else {
      await sendMessage(chatId, `Ошибка генерации: ${escapeMarkdown(errorMessage(error, "unknown error"))}`);
    }
  } finally {
    activeChats.delete(chatKey);
  }
}

async function handleDocumentUpload(chatId, message) {
  const document = message?.document;
  if (!document) {
    return false;
  }

  const fileId = `${document.file_id || ""}`.trim();
  const fileName = `${document.file_name || "material"}`.trim() || "material";
  const mimeType = `${document.mime_type || ""}`.trim();
  const fileSize = Math.max(0, Number(document.file_size) || 0);

  if (!fileId) {
    await sendMessage(chatId, "Telegram не передал file_id для документа.");
    return true;
  }

  if (!isSupportedTextMaterial({ fileName, mimeType })) {
    await sendMessage(
      chatId,
      "Неподдерживаемый формат. Поддерживаются: pdf, docx/doc/odt/rtf, txt, md, csv, json, html, xml."
    );
    return true;
  }

  if (fileSize > MAX_UPLOAD_SIZE_BYTES) {
    await sendMessage(
      chatId,
      `Файл слишком большой (${formatFileSize(fileSize)}). Лимит: ${MAX_UPLOAD_SIZE_MB} MB.`
    );
    return true;
  }

  try {
    await sendMessage(chatId, `Получил файл "${escapeMarkdown(fileName)}" (${formatFileSize(fileSize)}). Скачиваю...`);

    const { buffer } = await downloadTelegramFile(fileId);
    const material = await saveUploadedMaterial({
      fileName,
      mimeType,
      buffer
    });

    await sendMessage(chatId, `Файл сохранён как materialId=${escapeMarkdown(material.id)}. Индексирую...`);

    const defaults = createDefaultGenerateInput();
    const embedding = resolveEmbeddingConfig(defaults);
    const result = await indexMaterialDocument(material.id, { embedding });

    if (!result?.ok) {
      upsertSessionFile(chatId, {
        materialId: material.id,
        telegramFileId: fileId,
        fileName: material.fileName,
        mimeType: material.mimeType,
        size: material.size,
        status: "failed",
        message: `${result?.message || "Indexing failed."}`
      });
      await saveState();
      await sendMessage(chatId, `Не удалось проиндексировать "${escapeMarkdown(material.fileName)}": ${escapeMarkdown(result?.message || "unknown error")}`);
      return true;
    }

    attachMaterialToSession(chatId, material.id);
    upsertSessionFile(chatId, {
      materialId: material.id,
      telegramFileId: fileId,
      fileName: material.fileName,
      mimeType: material.mimeType,
      size: material.size,
      status: "indexed",
      message: ""
    });
    await saveState();

    const session = getChatSession(chatId, false);
    const materialCount = session?.materialIds?.length || 0;

    await sendMessage(
      chatId,
      [
        `Готово: "${escapeMarkdown(material.fileName)}" проиндексирован.`,
        `Chunks: ${result.chunksCount ?? 0}`,
        `Материалов в чате: ${materialCount}`,
        "Что вы хотите сделать дальше?"
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📝 Сгенерировать Курс", callback_data: `create_course^${material.fileName.slice(0, 30)}` }],
            [{ text: "🧠 Сгенерировать Тест (Quiz)", callback_data: `create_quiz^${material.fileName.slice(0, 30)}` }],
            [{ text: "🗑 Очистить материалы чата", callback_data: `clear_materials` }]
          ]
        }
      }
    );
    return true;
  } catch (error) {
    await sendMessage(chatId, `Ошибка загрузки файла: ${escapeMarkdown(errorMessage(error, "unknown error"))}`);
    return true;
  }
}

async function handleMessage(message) {
  const chatId = message?.chat?.id;
  if (!chatId) {
    return;
  }

  if (!isAllowedChat(chatId)) {
    await sendMessage(chatId, "Доступ к боту ограничен для текущей инсталляции.");
    return;
  }

  let dbUser = await prisma.telegramUser.findUnique({ where: { id: String(chatId) } });
  if (!dbUser) {
    dbUser = await prisma.telegramUser.create({ data: { id: String(chatId), status: "guest" } });
  }

  if (dbUser.status === "banned") {
    await sendMessage(chatId, "❌ Ваш аккаунт заблокирован администратором.");
    return;
  }

  const text = `${message?.text || ""}`.trim();

  // ----- AUTHENTICATION FLOW -----
  if (dbUser.status !== "approved") {
    if (text === "/start") {
      const domainsText = ALLOWED_EMAIL_DOMAINS.join(", ");
      await sendMessage(chatId, `🎓 Добро пожаловать! Этот бот предназначен исключительно для сотрудников и студентов университета.\n\nПожалуйста, отправьте вашу корпоративную почту (она должна заканчиваться на ${domainsText}), чтобы получить код доступа.`);
      return;
    }

    if (dbUser.status === "guest") {
      const emailLower = text.toLowerCase();
      const isValidDomain = ALLOWED_EMAIL_DOMAINS.some(domain => emailLower.endsWith(domain)) && emailLower.includes("@");

      if (!isValidDomain) {
        await sendMessage(chatId, `⚠️ Неверный формат. Почта должна оканчиваться на один из разрешенных доменов: ${ALLOWED_EMAIL_DOMAINS.join(", ")}. Попробуйте снова:`);
        return;
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
      const expiresAt = new Date(Date.now() + 10 * 60000); // 10 minutes

      await prisma.telegramUser.update({
        where: { id: dbUser.id },
        data: { email: text, status: "pending_code", authCode: code, authCodeExpiresAt: expiresAt, failedAttempts: 0 }
      });

      const sent = await sendAuthCode(text, code);
      if (sent) {
        await sendMessage(chatId, `✅ Мы отправили 6-значный код на почту ${escapeMarkdown(text)}.\nПожалуйста, введите его здесь (код действителен 10 минут):`);
      } else {
        await sendMessage(chatId, `❌ Ошибка отправки письма на ${escapeMarkdown(text)}. Пожалуйста, свяжитесь с поддержкой.`);
      }
      return;
    }

    if (dbUser.status === "pending_code") {
      if (text.length === 6 && /^\d+$/.test(text)) {
        if (dbUser.authCode === text && dbUser.authCodeExpiresAt && new Date() < dbUser.authCodeExpiresAt) {
          await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { status: "approved", authCode: null, authCodeExpiresAt: null, failedAttempts: 0 } });
          await sendMessage(chatId, "🎉 Почта успешно подтверждена! Теперь вы можете генерировать курсы и отправлять документы. Используйте команду /help.");
        } else {
          const attempts = dbUser.failedAttempts + 1;
          if (attempts >= 3) {
            await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { status: "guest", authCode: null, failedAttempts: 0 } });
            await sendMessage(chatId, "❌ Превышено количество попыток или код устарел. Отправьте вашу почту заново.");
          } else {
            await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { failedAttempts: attempts } });
            await sendMessage(chatId, `⚠️ Неверный код. Осталось попыток: ${3 - attempts}`);
          }
        }
      } else {
        await sendMessage(chatId, "Укажите 6-значный код из письма.");
      }
      return;
    }
    return;
  }
  // ----- END AUTHENTICATION FLOW -----

  if (message?.document) {
    await handleDocumentUpload(chatId, message);
    await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { documentsCount: { increment: 1 } } });
    return;
  }

  if (!text) {
    return;
  }

  const parsedCommand = parseCommand(text);
  const { command, args } = parsedCommand;

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, buildHelpText());
    return;
  }

  if (command === "/status") {
    await sendMessage(chatId, buildStatusText(chatId));
    return;
  }

  if (command === "/models") {
    await handleListModelsCommand(chatId);
    return;
  }

  if (command === "/model") {
    await handleModelCommand(chatId, args);
    return;
  }

  if (command === "/embed_models") {
    await handleListEmbedModelsCommand(chatId);
    return;
  }

  if (command === "/embed_model") {
    await handleEmbedModelCommand(chatId, args);
    return;
  }

  if (command === "/materials") {
    await sendMessage(chatId, buildMaterialsText(chatId));
    return;
  }

  if (command === "/clear_materials") {
    const cleared = clearSessionMaterials(chatId);
    if (cleared) {
      await saveState();
      await sendMessage(chatId, "Материалы этого чата очищены.");
    } else {
      await sendMessage(chatId, "В этом чате нет материалов для очистки.");
    }
    return;
  }

  if (command === "/quiz") {
    const parsed = parseCreateArgs(args, "/quiz");
    if (!parsed.ok) {
      await sendMessage(chatId, parsed.message);
      return;
    }

    const log = await prisma.generationLog.create({
      data: { chatId: String(chatId), title: parsed.topic + " (Quiz)", status: "started" }
    });

    try {
      await handleCreateCommand(chatId, parsed, true);
      await prisma.generationLog.update({ where: { id: log.id }, data: { status: "completed" } });
      await prisma.telegramUser.update({ where: { id: String(chatId) }, data: { generationsCount: { increment: 1 } } });
    } catch (e) {
      await prisma.generationLog.update({ where: { id: log.id }, data: { status: "failed" } });
      throw e;
    }
    return;
  }

  if (command === "/create") {
    const parsed = parseCreateArgs(args, "/create");
    if (!parsed.ok) {
      await sendMessage(chatId, parsed.message);
      return;
    }

    const log = await prisma.generationLog.create({
      data: { chatId: String(chatId), title: parsed.topic, status: "started" }
    });

    try {
      await handleCreateCommand(chatId, parsed, false);
      await prisma.generationLog.update({ where: { id: log.id }, data: { status: "completed" } });
      await prisma.telegramUser.update({ where: { id: String(chatId) }, data: { generationsCount: { increment: 1 } } });
    } catch (e) {
      await prisma.generationLog.update({ where: { id: log.id }, data: { status: "failed" } });
      throw e;
    }
    return;
  }

  if (!command) {
    await sendMessage(
      chatId,
      [
        "Неизвестный формат сообщения.",
        "Используйте /create <code>тема</code> для генерации SCORM ZIP.",
        "Либо отправьте документ, чтобы загрузить материал.",
        "Команда /help покажет полный список."
      ].join("\n")
    );
    return;
  }

  await sendMessage(chatId, "Неизвестная команда. Используйте /help.");
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || "";

  await telegramCall("answerCallbackQuery", { callback_query_id: query.id }).catch(() => { });

  if (!chatId) return;

  if (data.startsWith("create_course^")) {
    const topic = data.split("^")[1] || "Без темы";
    await editMessageText(chatId, messageId, `✅ Вы выбрали: Сгенерировать Курс по "<b>${escapeMarkdown(topic)}</b>"\n\nЗапускаем добавление в очередь...`);
    // Mock user message logic to trigger handleCreateCommand directly
    await handleMessage({
      chat: { id: chatId },
      text: `/create ${topic}`
    });
  } else if (data.startsWith("create_quiz^")) {
    const topic = data.split("^")[1] || "Без темы";
    await editMessageText(chatId, messageId, `✅ Вы выбрали: Сгенерировать Тест по "<b>${escapeMarkdown(topic)}</b>"\n\nЗапускаем добавление в очередь...`);
    await handleMessage({
      chat: { id: chatId },
      text: `/quiz ${topic}`
    });
  } else if (data === "clear_materials") {
    await editMessageText(chatId, messageId, `Очищаю материалы...`);
    await handleMessage({
      chat: { id: chatId },
      text: `/clear_materials`
    });
  } else if (data.startsWith("prev_")) {
    const parts = data.split("_");
    const courseId = parts[1];
    const index = parseInt(parts[2] || "0", 10);
    const course = await getCourse(courseId);
    if (!course) {
      await editMessageText(chatId, messageId, "Курс устарел или был удален с сервера.");
      return;
    }
    const msg = buildScreenPreviewMessage(course, index);
    if (msg.text) {
      await editMessageText(chatId, messageId, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {}).catch(() => {});
    }
  }
}

function flattenCourseScreens(course) {
  const screens = [];
  if (Array.isArray(course?.modules)) {
    course.modules.forEach((mod) => {
      if (Array.isArray(mod?.sections)) {
        mod.sections.forEach((sec) => {
          if (Array.isArray(sec?.scos)) {
            sec.scos.forEach((sco) => {
              if (Array.isArray(sco?.screens)) {
                sco.screens.forEach((scr) => {
                  screens.push({
                    heading: `${mod.title} / ${sec.title} / ${sco.title}`,
                    title: scr.title,
                    blocks: scr.blocks || [],
                    isQuiz: false
                  });
                });
              }
            });
          }
        });
      }
    });
  }

  if (course?.finalTest?.enabled && Array.isArray(course.finalTest.questions)) {
    screens.push({
      heading: `${course.title} / ${course.finalTest.title || "Итоговый тест"}`,
      title: `🏁 Тест: ${course.finalTest.questions.length} вопросов`,
      blocks: course.finalTest.questions.map((q, idx) => ({
        type: "text",
        text: `${idx + 1}. ${q.prompt}`
      })),
      isQuiz: true
    });
  }

  return screens;
}

function buildScreenPreviewMessage(course, globalIndex) {
  const screens = flattenCourseScreens(course);
  if (screens.length === 0) {
    return { text: "Экранов не найдено", reply_markup: null };
  }

  let index = Math.max(0, Math.min(globalIndex, screens.length - 1));
  const screen = screens[index];

  let text = `📺 <b>Предпросмотр (Экран ${index + 1} из ${screens.length})</b>\n`;
  text += `📍 <i>${escapeMarkdown(screen.heading)}</i>\n\n`;
  text += `<b>${escapeMarkdown(screen.title)}</b>\n\n`;

  let blockLines = [];
  for (const block of screen.blocks) {
    if (block.type === "note") continue;
    if (block.type === "list" && Array.isArray(block.items)) {
      for (const item of block.items) {
        blockLines.push(`• ${escapeMarkdown(item)}`);
      }
    } else if (block.type === "image") {
       blockLines.push(`🖼 [Изображение]`);
    } else if (block.text) {
       blockLines.push(`${escapeMarkdown(block.text)}`);
    }
  }

  const content = blockLines.join("\n\n");
  text += content.length > 3000 ? content.slice(0, 3000) + "..." : content;

  const buttons = [];
  if (index > 0) {
    buttons.push({ text: "⬅️ Назад", callback_data: `prev_${course.id}_${index - 1}` });
  }
  if (index < screens.length - 1) {
    buttons.push({ text: "Вперед ➡️", callback_data: `prev_${course.id}_${index + 1}` });
  }

  return {
    text,
    reply_markup: buttons.length > 0 ? JSON.stringify({ inline_keyboard: [buttons] }) : null
  };
}

async function getUpdates(offset) {
  return telegramCall(
    "getUpdates",
    {
      offset,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ["message", "callback_query"]
    },
    { timeoutSeconds: POLL_TIMEOUT_SECONDS + 10 }
  );
}

async function run() {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  let me = null;
  while (!stopped) {
    try {
      me = await telegramCall("getMe", {});
      break;
    } catch (error) {
      console.error(`[telegram-bot] bootstrap error: ${errorMessage(error, "unknown error")}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (!me) {
    return;
  }

  console.log(`[telegram-bot] started as @${me?.username || "unknown"} (${me?.id || "n/a"})`);

  botState = await loadState();
  let offset = botState.offset;
  if (offset > 0) {
    console.log(`[telegram-bot] resume offset: ${offset}`);
  }

  while (!stopped) {
    try {
      const updates = await getUpdates(offset);
      if (!Array.isArray(updates) || updates.length === 0) {
        continue;
      }

      for (const update of updates) {
        const updateId = Math.trunc(Number(update?.update_id));
        if (Number.isFinite(updateId)) {
          offset = Math.max(offset, updateId + 1);
        }
        if (update?.message) {
          try {
            await handleMessage(update.message);
          } catch (msgErr) {
            console.error(`[telegram-bot] error processing message ${updateId}:`, msgErr);
          }
        } else if (update?.callback_query) {
          try {
            await handleCallbackQuery(update.callback_query);
          } catch (cbErr) {
            console.error(`[telegram-bot] error processing callback ${updateId}:`, cbErr);
          }
        }
      }

      botState.offset = offset;
      await saveState();
    } catch (error) {
      console.error(`[telegram-bot] polling error: ${errorMessage(error, "unknown error")}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  botState.offset = offset;
  await saveState().catch(() => { });
  console.log("[telegram-bot] stopped");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    console.log(`[telegram-bot] received ${signal}, exiting immediately.`);
    process.exit(0);
  });
}

run().catch((error) => {
  console.error(`[telegram-bot] fatal: ${errorMessage(error, "unknown error")}`);
  process.exit(1);
});
