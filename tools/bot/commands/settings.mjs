import { sendMessage, getModelParamSize } from "../api.mjs";
import { escapeMarkdown, normalizeModelName, RAG_TOP_K, MAX_UPLOAD_SIZE_MB, BOT_LANGUAGE } from "../config.mjs";
import { getChatSession, activeChats, getCourseSettings } from "../state.mjs";
import { resolveGenerationConfig, resolveEmbeddingConfig } from "../generation/executor.mjs";
import { createDefaultGenerateInput } from "../../../lib/course-defaults.js";
import { profileSettingsKeyboard } from "../ui/keyboards.mjs";

const AUDIENCE_LABELS = { student: "🎓 Студенты", specialist: "👨‍💼 Специалисты", advanced: "🏅 ПК" };
const STYLE_LABELS = { formal: "📋 Формальный", conversational: "💬 Разговорный", academic: "🏛 Академический" };

export async function handleStatus(chatId) {
  const defaults = createDefaultGenerateInput();
  const genConfig = resolveGenerationConfig(defaults, chatId);
  const embConfig = resolveEmbeddingConfig(defaults, chatId);
  const session = getChatSession(chatId, false);
  const materialCount = session?.materialIds?.length || 0;
  const selectedModel = normalizeModelName(session?.generationModel);
  const selectedEmbed = normalizeModelName(session?.embeddingModel);
  const settings = getCourseSettings(chatId);
  const langLabels = { ru: "🇷🇺 RU", en: "🇬🇧 EN", kk: "🇰🇿 KZ", auto: "🔄 Авто" };

  const modelName = selectedModel || genConfig.model;

  // Cloud provider display
  const CLOUD_LABELS = { groq: "⚡ Groq", gemini: "💎 Gemini", openrouter: "🌐 OpenRouter" };
  const cloudProvider = session?.cloudProvider || "";
  let providerLabel, modelLabel;
  if (cloudProvider && session?.cloudApiKey) {
    providerLabel = CLOUD_LABELS[cloudProvider] || `☁️ ${cloudProvider}`;
    modelLabel = escapeMarkdown(session?.cloudModelName || "default");
  } else {
    providerLabel = "💻 Ollama (локальный)";
    const paramSize = await getModelParamSize(modelName).catch(() => "");
    modelLabel = paramSize ? `${escapeMarkdown(modelName)} (${escapeMarkdown(paramSize)})` : escapeMarkdown(modelName);
  }

  const lines = [
    "<b>👤 Профиль генерации</b>",
    "",
    `🎓 <b>Аудитория:</b> ${AUDIENCE_LABELS[settings.audienceLevel] || AUDIENCE_LABELS.student}`,
    `📝 <b>Стиль:</b> ${STYLE_LABELS[settings.textStyle] || STYLE_LABELS.formal}`,
    `☁️ <b>Провайдер:</b> ${providerLabel}`,
    `🤖 <b>Модель:</b> <code>${modelLabel}</code>`,
    `🌐 <b>Язык:</b> ${langLabels[settings.outputLanguage] || langLabels.auto}`,
    "",
    `📦 Материалов: ${materialCount}`,
    `⚡ Генераций: ${activeChats.size}`,
    "",
    `<i>Нажмите кнопку для изменения</i>`
  ];

  const kb = profileSettingsKeyboard(settings, selectedModel || genConfig.model, session?.cloudProvider);
  await sendMessage(chatId, lines.join("\n"), kb);
}
