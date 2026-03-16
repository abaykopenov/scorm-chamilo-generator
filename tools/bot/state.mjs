import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nowIso, normalizeModelName, MAX_CHAT_MATERIALS, MAX_SESSION_FILE_ENTRIES } from "./config.mjs";

const STATE_FILE_PATH = path.join(process.cwd(), ".data", "telegram-bot", "state.json");

export let botState = createEmptyState();
export const activeChats = new Set();

function createEmptyState() {
  return { offset: 0, chatSessions: {} };
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
    ? Array.from(new Set(value.materialIds.map(i => `${i || ""}`.trim()).filter(Boolean)))
    : [];
  const files = Array.isArray(value?.files)
    ? value.files.map(normalizeSessionFileEntry).slice(-MAX_SESSION_FILE_ENTRIES)
    : [];
  return {
    materialIds: materialIds.slice(-MAX_CHAT_MATERIALS),
    generationModel: normalizeModelName(value?.generationModel),
    embeddingModel: normalizeModelName(value?.embeddingModel),
    courseSettings: value?.courseSettings || null,
    files,
    updatedAt: `${value?.updatedAt || ""}`.trim() || nowIso()
  };
}

function normalizeState(value) {
  const offsetRaw = Math.trunc(Number(value?.offset));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const sessionsRaw = value?.chatSessions && typeof value.chatSessions === "object" ? value.chatSessions : {};
  const chatSessions = {};
  for (const [chatId, session] of Object.entries(sessionsRaw)) {
    const key = `${chatId || ""}`.trim();
    if (key) chatSessions[key] = normalizeSession(session);
  }
  return { offset, chatSessions };
}

export async function loadState() {
  try {
    const content = await readFile(STATE_FILE_PATH, "utf8");
    botState = normalizeState(JSON.parse(content));
  } catch {
    botState = createEmptyState();
  }
  return botState;
}

export async function saveState() {
  await mkdir(path.dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, `${JSON.stringify({ ...botState, updatedAt: nowIso() }, null, 2)}\n`, "utf8");
}

export function getChatSession(chatId, createIfMissing = true) {
  const key = `${chatId || ""}`.trim();
  if (!key) return null;
  if (botState.chatSessions[key]) return botState.chatSessions[key];
  if (!createIfMissing) return null;
  const created = normalizeSession({});
  botState.chatSessions[key] = created;
  return created;
}

export function upsertSessionFile(chatId, entry) {
  const session = getChatSession(chatId, true);
  if (!session) return;
  const normalized = normalizeSessionFileEntry(entry);
  const key = normalized.materialId || normalized.telegramFileId || `${normalized.fileName}:${normalized.size}`;
  session.files = [
    ...session.files.filter(item => {
      const k = item.materialId || item.telegramFileId || `${item.fileName}:${item.size}`;
      return k !== key;
    }),
    normalized
  ].slice(-MAX_SESSION_FILE_ENTRIES);
  session.updatedAt = nowIso();
}

export function attachMaterialToSession(chatId, materialId) {
  const session = getChatSession(chatId, true);
  if (!session) return;
  const cleanId = `${materialId || ""}`.trim();
  if (!cleanId) return;
  session.materialIds = [...session.materialIds.filter(id => id !== cleanId), cleanId].slice(-MAX_CHAT_MATERIALS);
  session.updatedAt = nowIso();
}

export function setChatGenerationModel(chatId, modelName) {
  const session = getChatSession(chatId, true);
  if (!session) return "";
  session.generationModel = normalizeModelName(modelName);
  session.updatedAt = nowIso();
  return session.generationModel;
}

export function setChatEmbeddingModel(chatId, modelName) {
  const session = getChatSession(chatId, true);
  if (!session) return "";
  session.embeddingModel = normalizeModelName(modelName);
  session.updatedAt = nowIso();
  return session.embeddingModel;
}

export function clearSessionMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session) return false;
  session.materialIds = [];
  session.files = [];
  session.updatedAt = nowIso();
  return true;
}

export function getCourseSettings(chatId) {
  const session = getChatSession(chatId, false);
  return session?.courseSettings || {
    moduleCount: 2,
    sectionsPerModule: 2,
    questionCount: 8,
    passingScore: 80,
    outputLanguage: "auto",
    audienceLevel: "student",
    textStyle: "formal",
    screensPerSco: 2
  };
}

export function setCourseSettings(chatId, settings) {
  const session = getChatSession(chatId, true);
  if (!session) return;
  session.courseSettings = { ...getCourseSettings(chatId), ...settings };
  session.updatedAt = nowIso();
}

// Rate limiting
const rateLimitCounters = new Map();

export function checkRateLimit(chatId, action, maxPerHour) {
  const key = `${chatId}:${action}`;
  const now = Date.now();
  const hourAgo = now - 3600_000;
  let entry = rateLimitCounters.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitCounters.set(key, entry);
  }
  entry.timestamps = entry.timestamps.filter(t => t > hourAgo);
  if (entry.timestamps.length >= maxPerHour) {
    const oldestInWindow = entry.timestamps[0];
    const waitMinutes = Math.ceil((oldestInWindow + 3600_000 - now) / 60_000);
    return { allowed: false, remaining: 0, waitMinutes };
  }
  entry.timestamps.push(now);
  return { allowed: true, remaining: maxPerHour - entry.timestamps.length };
}
