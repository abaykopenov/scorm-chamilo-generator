import { loadLocalEnvFiles } from "../load-env.mjs";
loadLocalEnvFiles();

export function clampInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function clampFloat(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeGenerationProvider(value) {
  const p = `${value || ""}`.trim().toLowerCase();
  return ["template", "ollama", "openai-compatible"].includes(p) ? p : "";
}

function normalizeEmbeddingProvider(value) {
  const p = `${value || ""}`.trim().toLowerCase();
  return ["ollama", "openai-compatible"].includes(p) ? p : "";
}

export const BOT_TOKEN = `${process.env.TELEGRAM_BOT_TOKEN || ""}`.trim();
export const TELEGRAM_API_URL = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

export const POLL_TIMEOUT_SECONDS = clampInt(process.env.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS, 25, 5, 50);
export const PROGRESS_STEP_PERCENT = clampInt(process.env.TELEGRAM_BOT_PROGRESS_STEP_PERCENT, 25, 10, 50);
export const RETRY_DELAY_MS = 2500;
export const BOT_LANGUAGE = `${process.env.TELEGRAM_BOT_LANGUAGE || ""}`.trim().toLowerCase() === "en" ? "en" : "ru";

export const MAX_UPLOAD_SIZE_MB = clampInt(process.env.TELEGRAM_BOT_MAX_FILE_SIZE_MB, 50, 1, 200);
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
export const MAX_CHAT_MATERIALS = clampInt(process.env.TELEGRAM_BOT_MAX_CHAT_MATERIALS, 12, 1, 100);
export const MAX_SESSION_FILE_ENTRIES = clampInt(process.env.TELEGRAM_BOT_MAX_FILE_ENTRIES, 40, 10, 300);
export const RAG_TOP_K = clampInt(process.env.TELEGRAM_BOT_RAG_TOP_K, 6, 1, 30);
export const MAX_GENERATIONS_PER_HOUR = clampInt(process.env.TELEGRAM_BOT_MAX_GENERATIONS_PER_HOUR, 5, 1, 100);
export const MAX_UPLOADS_PER_HOUR = clampInt(process.env.TELEGRAM_BOT_MAX_UPLOADS_PER_HOUR, 15, 1, 200);

export const GENERATION_PROVIDER = normalizeGenerationProvider(process.env.TELEGRAM_BOT_GENERATION_PROVIDER);
export const GENERATION_MODEL = `${process.env.TELEGRAM_BOT_GENERATION_MODEL || ""}`.trim();
export const GENERATION_BASE_URL = `${process.env.TELEGRAM_BOT_GENERATION_BASE_URL || ""}`.trim();
export const GENERATION_TEMPERATURE = clampFloat(process.env.TELEGRAM_BOT_GENERATION_TEMPERATURE, null, 0, 1);

export const EMBEDDING_PROVIDER = normalizeEmbeddingProvider(process.env.TELEGRAM_BOT_EMBEDDING_PROVIDER);
export const EMBEDDING_MODEL = `${process.env.TELEGRAM_BOT_EMBEDDING_MODEL || ""}`.trim();
export const EMBEDDING_BASE_URL = `${process.env.TELEGRAM_BOT_EMBEDDING_BASE_URL || ""}`.trim();

export const ALLOWED_CHAT_IDS = new Set(
  `${process.env.TELEGRAM_BOT_ALLOWED_CHAT_IDS || ""}`
    .split(",").map(v => v.trim()).filter(Boolean)
);

export const ADMIN_CHAT_IDS = new Set(
  `${process.env.TELEGRAM_BOT_ADMIN_IDS || ""}`
    .split(",").map(v => v.trim()).filter(Boolean)
);

export const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || "@university.edu")
  .split(",").map(d => d.trim().toLowerCase()).filter(Boolean);

export function isAllowedChat(chatId) {
  if (ALLOWED_CHAT_IDS.size === 0) return true;
  return ALLOWED_CHAT_IDS.has(`${chatId}`);
}

export function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.has(`${chatId}`);
}

export function normalizeModelName(value) {
  return `${value || ""}`.trim().slice(0, 200);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function escapeMarkdown(text) {
  return `${text || ""}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function errorMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
