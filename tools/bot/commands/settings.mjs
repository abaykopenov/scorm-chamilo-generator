import { sendMessage } from "../api.mjs";
import { escapeMarkdown, normalizeModelName, RAG_TOP_K, MAX_UPLOAD_SIZE_MB, BOT_LANGUAGE } from "../config.mjs";
import { getChatSession, activeChats, getCourseSettings } from "../state.mjs";
import { resolveGenerationConfig, resolveEmbeddingConfig } from "../generation/executor.mjs";
import { createDefaultGenerateInput } from "../../../lib/course-defaults.js";

export async function handleStatus(chatId) {
  const defaults = createDefaultGenerateInput();
  const genConfig = resolveGenerationConfig(defaults, chatId);
  const embConfig = resolveEmbeddingConfig(defaults, chatId);
  const session = getChatSession(chatId, false);
  const materialCount = session?.materialIds?.length || 0;
  const selectedModel = normalizeModelName(session?.generationModel);
  const selectedEmbed = normalizeModelName(session?.embeddingModel);
  const settings = getCourseSettings(chatId);

  const lines = [
    "<b>⚙️ Статус бота:</b>",
    "",
    `🤖 <b>Генерация:</b>`,
    `  Provider: ${escapeMarkdown(genConfig.provider)}`,
    `  Model: ${escapeMarkdown(genConfig.model)}`,
    `  Override: ${escapeMarkdown(selectedModel || "—")}`,
    "",
    `📊 <b>Эмбеддинги:</b>`,
    `  Provider: ${escapeMarkdown(embConfig.provider)}`,
    `  Model: ${escapeMarkdown(embConfig.model)}`,
    `  Override: ${escapeMarkdown(selectedEmbed || "—")}`,
    "",
    `📐 <b>Настройки курса:</b>`,
    `  Модулей: ${settings.moduleCount}`,
    `  Разделов/модуль: ${settings.sectionsPerModule}`,
    `  Вопросов: ${settings.questionCount}`,
    `  Проходной балл: ${settings.passingScore}%`,
    "",
    `📦 <b>Текущее состояние:</b>`,
    `  Язык: ${escapeMarkdown(BOT_LANGUAGE)}`,
    `  RAG topK: ${RAG_TOP_K}`,
    `  Max файл: ${MAX_UPLOAD_SIZE_MB} MB`,
    `  Активных генераций: ${activeChats.size}`,
    `  Материалов в чате: ${materialCount}`
  ];

  await sendMessage(chatId, lines.join("\n"));
}
