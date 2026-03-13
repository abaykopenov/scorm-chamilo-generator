import { isAllowedChat, escapeMarkdown } from "../config.mjs";
import { sendMessage } from "../api.mjs";
import { getChatSession, getCourseSettings, saveState } from "../state.mjs";
import { mainKeyboard, courseSettingsKeyboard } from "../ui/keyboards.mjs";
import { t } from "../i18n/index.mjs";
import { handleAuth } from "../auth.mjs";
import { handleStart, handleHelp } from "../commands/start.mjs";
import { handleDocumentUpload, handleMaterials, handleClearMaterials } from "../commands/materials.mjs";
import { handleListModels, handleSetModel, handleListEmbedModels, handleSetEmbedModel } from "../commands/models.mjs";
import { handleMyCourses } from "../commands/my-courses.mjs";
import { handleStatus } from "../commands/settings.mjs";
import { handleAdmin } from "../commands/admin.mjs";
import { handleCreateCommand, parseCreateArgs } from "../generation/executor.mjs";
import { getChamiloFlow, handleChamiloFlowStep } from "../commands/chamilo.mjs";
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

  if (command === "/create") {
    const parsed = parseCreateArgs(args, "/create");
    if (!parsed.ok) { await sendMessage(chatId, parsed.message); return; }
    // Show settings menu before generating
    const settings = getCourseSettings(chatId);
    const headerText = `${t("settingsTitle", escapeMarkdown(parsed.title))}\n\n${t("settingsModules", settings.moduleCount)}\n${t("settingsSections", settings.sectionsPerModule)}\n${t("settingsQuestions", settings.questionCount)}\n${t("settingsPassScore", settings.passingScore)}`;
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
