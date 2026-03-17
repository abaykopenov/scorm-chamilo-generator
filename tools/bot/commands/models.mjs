import { sendMessage } from "../api.mjs";
import { escapeMarkdown, normalizeModelName } from "../config.mjs";
import { fetchOllamaModelNames, fetchOllamaModelsWithDetails } from "../api.mjs";
import { getChatSession, setChatGenerationModel, setChatEmbeddingModel, saveState } from "../state.mjs";
import { resolveGenerationConfig, resolveEmbeddingConfig } from "../generation/executor.mjs";
import { createDefaultGenerateInput } from "../../../lib/course-defaults.js";

function formatSize(bytes) {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

function formatModelLine(name, paramSize, sizeBytes) {
  const esc = escapeMarkdown(name);
  const parts = [esc];
  if (paramSize) parts.push(`(${escapeMarkdown(paramSize)})`);
  else if (sizeBytes) parts.push(`(${formatSize(sizeBytes)})`);
  return parts.join(" ");
}

function findBestModelMatch(requested, models) {
  const req = `${requested || ""}`.trim().toLowerCase();
  if (!req || models.length === 0) return "";
  const exact = models.find(n => n.toLowerCase() === req);
  if (exact) return exact;
  const withTag = models.find(n => n.toLowerCase().startsWith(`${req}:`));
  if (withTag) return withTag;
  const contains = models.find(n => n.toLowerCase().includes(req));
  if (contains) return contains;
  return "";
}

export async function handleListModels(chatId) {
  try {
    const defaults = createDefaultGenerateInput();
    const gen = resolveGenerationConfig(defaults, chatId);
    const baseUrl = gen.baseUrl || defaults.generation.baseUrl;
    const models = await fetchOllamaModelsWithDetails(baseUrl);
    if (models.length === 0) { await sendMessage(chatId, `Ollama доступен, но список моделей пуст (${baseUrl}).`); return; }
    const session = getChatSession(chatId, false);
    const selected = normalizeModelName(session?.generationModel);
    const preview = models.slice(0, 20).map(({ name, paramSize, sizeBytes }) => {
      const label = formatModelLine(name, paramSize, sizeBytes);
      if (name === selected) return `✅ ${label} — выбрана`;
      if (name === gen.model) return `🔹 ${label} — активная`;
      return `• ${label}`;
    });
    const tail = models.length > 20 ? `\n... и еще ${models.length - 20}` : "";
    await sendMessage(chatId, [`<b>Модели Ollama</b> (${baseUrl}):`, ...preview, "", "Выбрать: /model <code>имя</code>", "Сброс: /model default"].join("\n") + tail);
  } catch (e) {
    await sendMessage(chatId, `Ошибка: ${escapeMarkdown(e.message || "unknown")}`);
  }
}

export async function handleSetModel(chatId, args) {
  const raw = `${args || ""}`.trim();
  if (!raw) {
    const defaults = createDefaultGenerateInput();
    const gen = resolveGenerationConfig(defaults, chatId);
    const session = getChatSession(chatId, false);
    const sel = normalizeModelName(session?.generationModel);
    await sendMessage(chatId, [`Текущая: ${escapeMarkdown(gen.model)}`, `Provider: ${escapeMarkdown(gen.provider)}`, `Override: ${escapeMarkdown(sel || "none")}`, "", "Установить: /model <code>имя</code>", "Сброс: /model default"].join("\n"));
    return;
  }
  if (["default", "reset", "clear", "none"].includes(raw.toLowerCase())) {
    setChatGenerationModel(chatId, ""); await saveState();
    const defaults = createDefaultGenerateInput(); const gen = resolveGenerationConfig(defaults, chatId);
    await sendMessage(chatId, `Модель сброшена. Активная: ${gen.model}`); return;
  }
  try {
    const defaults = createDefaultGenerateInput(); const gen = resolveGenerationConfig(defaults, chatId);
    const models = await fetchOllamaModelNames(gen.baseUrl || defaults.generation.baseUrl);
    const matched = findBestModelMatch(raw, models);
    const selected = matched || normalizeModelName(raw);
    setChatGenerationModel(chatId, selected); await saveState();
    await sendMessage(chatId, matched ? `✅ Модель: ${escapeMarkdown(matched)}` : `Модель: <code>${escapeMarkdown(selected)}</code>\n⚠️ Точного совпадения нет.`);
  } catch (e) {
    await sendMessage(chatId, `Ошибка: ${escapeMarkdown(e.message || "unknown")}`);
  }
}

export async function handleListEmbedModels(chatId) {
  try {
    const defaults = createDefaultGenerateInput();
    const emb = resolveEmbeddingConfig(defaults, chatId);
    const baseUrl = emb.baseUrl || defaults.rag.embedding.baseUrl;
    const models = await fetchOllamaModelNames(baseUrl);
    if (models.length === 0) { await sendMessage(chatId, `Список пуст (${baseUrl}).`); return; }
    const session = getChatSession(chatId, false);
    const selected = normalizeModelName(session?.embeddingModel);
    const preview = models.slice(0, 20).map(name => {
      const esc = escapeMarkdown(name);
      if (name === selected) return `✅ ${esc} (выбрана)`;
      if (name === emb.model) return `🔹 ${esc} (активная)`;
      return `• ${esc}`;
    });
    await sendMessage(chatId, [`<b>Модели для эмбеддингов</b> (${baseUrl}):`, ...preview, "", "Выбрать: /embed_model <code>имя</code>"].join("\n"));
  } catch (e) {
    await sendMessage(chatId, `Ошибка: ${escapeMarkdown(e.message || "unknown")}`);
  }
}

export async function handleSetEmbedModel(chatId, args) {
  const raw = `${args || ""}`.trim();
  if (!raw) {
    const defaults = createDefaultGenerateInput();
    const emb = resolveEmbeddingConfig(defaults, chatId);
    const session = getChatSession(chatId, false);
    const sel = normalizeModelName(session?.embeddingModel);
    await sendMessage(chatId, [`Текущая: ${escapeMarkdown(emb.model)}`, `Override: ${escapeMarkdown(sel || "none")}`, "", "Установить: /embed_model <code>имя</code>"].join("\n"));
    return;
  }
  if (["default", "reset", "clear", "none"].includes(raw.toLowerCase())) {
    setChatEmbeddingModel(chatId, ""); await saveState();
    const defaults = createDefaultGenerateInput(); const emb = resolveEmbeddingConfig(defaults, chatId);
    await sendMessage(chatId, `Эмбеддинг модель сброшена. Активная: ${emb.model}`); return;
  }
  try {
    const defaults = createDefaultGenerateInput(); const emb = resolveEmbeddingConfig(defaults, chatId);
    const models = await fetchOllamaModelNames(emb.baseUrl || defaults.rag.embedding.baseUrl);
    const matched = findBestModelMatch(raw, models);
    const selected = matched || normalizeModelName(raw);
    setChatEmbeddingModel(chatId, selected); await saveState();
    await sendMessage(chatId, matched ? `✅ Эмбеддинг модель: ${escapeMarkdown(matched)}` : `Модель: <code>${escapeMarkdown(selected)}</code>`);
  } catch (e) {
    await sendMessage(chatId, `Ошибка: ${escapeMarkdown(e.message || "unknown")}`);
  }
}
