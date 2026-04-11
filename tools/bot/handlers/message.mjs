import { isAllowedChat, escapeMarkdown } from "../config.mjs";
import { sendMessage } from "../api.mjs";
import { getChatSession, getCourseSettings, setChatCloudProvider, saveState } from "../state.mjs";
import { mainKeyboard, courseSettingsKeyboard, profileSettingsKeyboard } from "../ui/keyboards.mjs";
import { t } from "../i18n/index.mjs";
import { handleAuth } from "../auth.mjs";
import { handleStart, handleHelp } from "../commands/start.mjs";
import { handleDocumentUpload, handleMaterials, handleClearMaterials } from "../commands/materials.mjs";
import { handleListModels, handleSetModel, handleListEmbedModels, handleSetEmbedModel } from "../commands/models.mjs";
import { handleMyCourses } from "../commands/my-courses.mjs";
import { handleStatus } from "../commands/settings.mjs";
import { handleAdmin } from "../commands/admin.mjs";
import { handleCreateCommand, parseCreateArgs } from "../generation/executor.mjs";
import { getChamiloFlow, handleChamiloFlowStep, handleChamiloSettings } from "../commands/chamilo.mjs";
import prisma from "../../../lib/db.js";

function parseCommand(rawText) {
  const text = `${rawText || ""}`.trim();
  if (!text.startsWith("/")) return { command: "", args: text };
  const firstSpace = text.indexOf(" ");
  const token = (firstSpace === -1 ? text : text.slice(0, firstSpace)).trim();
  const args = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
  return { command: token.split("@")[0].toLowerCase(), args };
}

// Map keyboard button labels to commands
const KEYBOARD_MAP = {
  [t("kbCreateCourse")]: "create_prompt",
  [t("kbCreateQuiz")]: "quiz_prompt",
  [t("kbMyFiles")]: "/materials",
  [t("kbMyCourses")]: "/my_courses",
  [t("kbSettings")]: "/status",
  [t("kbHelp")]: "/help"
};

export async function handleMessage(message) {
  const chatId = message?.chat?.id;
  if (!chatId) return;

  if (!isAllowedChat(chatId)) {
    await sendMessage(chatId, t("accessDenied"));
    return;
  }

  let dbUser = await prisma.telegramUser.findUnique({ where: { id: String(chatId) } });
  if (!dbUser) {
    dbUser = await prisma.telegramUser.create({ data: { id: String(chatId), status: "guest" } });
  }

  const text = `${message?.text || ""}`.trim();

  // Auth check
  const handled = await handleAuth(chatId, dbUser, text);
  if (handled) return;

  // Document upload
  if (message?.document) {
    await handleDocumentUpload(chatId, message);
    await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { documentsCount: { increment: 1 } } });
    return;
  }

  if (!text) return;

  // Cloud API key input
  const session = getChatSession(chatId, false);
  if (session?._awaitingCloudApiKey) {
    const provider = session._awaitingCloudApiKey;
    const CLOUD_DEFAULTS = {
      groq: "llama-3.3-70b-versatile",
      gemini: "gemini-2.0-flash",
      openrouter: "deepseek/deepseek-chat-v3-0324:free"
    };
    const defaultModel = CLOUD_DEFAULTS[provider] || "";
    setChatCloudProvider(chatId, provider, text, defaultModel);
    delete session._awaitingCloudApiKey;
    await saveState();
    await sendMessage(chatId,
      `✅ Провайдер <b>${provider.toUpperCase()}</b> настроен!\n` +
      `🤖 Модель: <code>${escapeMarkdown(defaultModel)}</code>\n\n` +
      `Чтобы сменить модель, зайдите в /status → ☁️ Провайдер.`
    );
    return;
  }

  // Cloud model name input
  if (session?._awaitingCloudModel) {
    session.cloudModelName = text.trim();
    delete session._awaitingCloudModel;
    await saveState();
    await sendMessage(chatId,
      `✅ Модель изменена на: <code>${escapeMarkdown(text.trim())}</code>`
    );
    return;
  }

  // Check if there's an active Chamilo flow
  if (getChamiloFlow(chatId)) {
    const consumed = await handleChamiloFlowStep(chatId, text);
    if (consumed) return;
  }

  // Check reply keyboard buttons
  const kbAction = KEYBOARD_MAP[text];
  if (kbAction === "create_prompt") {
    await sendMessage(chatId, "📝 Введите тему курса:\n\nФормат: <code>тема</code>\nИли: <code>тема | аудитория | цели</code>");
    return;
  }
  if (kbAction === "quiz_prompt") {
    await sendMessage(chatId, "🧠 Введите тему теста:\n\nФормат: <code>тема</code>");
    return;
  }
  if (kbAction) {
    // Redirect to command handler
    const redirected = { ...message, text: kbAction };
    await handleMessage(redirected);
    return;
  }

  // Parse slash commands
  const { command, args } = parseCommand(text);

  if (command === "/start") { await handleStart(chatId); return; }
  if (command === "/help") { await handleHelp(chatId); return; }
  if (command === "/status") { await handleStatus(chatId); return; }
  if (command === "/models") { await handleListModels(chatId); return; }
  if (command === "/model") { await handleSetModel(chatId, args); return; }
  if (command === "/embed_models") { await handleListEmbedModels(chatId); return; }
  if (command === "/embed_model") { await handleSetEmbedModel(chatId, args); return; }
  if (command === "/materials") { await handleMaterials(chatId); return; }
  if (command === "/clear_materials") { await handleClearMaterials(chatId); return; }
  if (command === "/my_courses") { await handleMyCourses(chatId); return; }
  if (command === "/admin") { await handleAdmin(chatId, args); return; }
  if (command === "/chamilo_settings" || command === "/chamilo") { await handleChamiloSettings(chatId); return; }

  if (command === "/create") {
    const parsed = parseCreateArgs(args, "/create");
    if (!parsed.ok) { await sendMessage(chatId, parsed.message); return; }
    // Show settings menu before generating
    const settings = getCourseSettings(chatId);
    const headerText = `⚙️ <b>Настройки курса «${escapeMarkdown(parsed.title)}»</b>\n\n📦 Модулей: ${settings.moduleCount}\n📑 Разделов: ${settings.sectionsPerModule}\n⏱ Экранов/SCO: ${settings.screensPerSco || 2}\n❓ Вопросов: ${settings.questionCount}\n🎯 Балл: ${settings.passingScore}%`;
    const session = getChatSession(chatId, false);
    const kb = courseSettingsKeyboard(settings, parsed.title);
    await sendMessage(chatId, headerText, kb);
    return;
  }

  if (command === "/quiz") {
    const parsed = parseCreateArgs(args, "/quiz");
    if (!parsed.ok) { await sendMessage(chatId, parsed.message); return; }
    await handleCreateCommand(chatId, parsed, true);
    return;
  }

  if (!command) {
    await sendMessage(chatId, t("unknownMessage"), mainKeyboard());
    return;
  }

  await sendMessage(chatId, t("unknownCommand"));
}
