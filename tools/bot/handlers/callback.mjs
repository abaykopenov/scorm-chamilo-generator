import { isAllowedChat, escapeMarkdown } from "../config.mjs";
import { sendMessage, editMessageText, telegramCall } from "../api.mjs";
import { getChatSession, getCourseSettings, setCourseSettings, saveState } from "../state.mjs";
import { courseSettingsKeyboard } from "../ui/keyboards.mjs";
import { buildScreenPreviewMessage } from "../ui/preview.mjs";
import { t } from "../i18n/index.mjs";
import { handleCreateCommand, parseCreateArgs } from "../generation/executor.mjs";
import { getCourse } from "../../../lib/course-store.js";
import { exportCourseToScormArchive } from "../../../lib/scorm/exporter.js";
import { sendDocument } from "../api.mjs";
import { startChamiloFlow } from "../commands/chamilo.mjs";

const SETTINGS_LIMITS = {
  moduleCount: { min: 1, max: 10, step: 1 },
  sectionsPerModule: { min: 1, max: 10, step: 1 },
  questionCount: { min: 0, max: 30, step: 2 },
  passingScore: { min: 50, max: 100, step: 10 }
};

export async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || "";

  await telegramCall("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
  if (!chatId) return;

  // Course settings adjustments
  if (data.startsWith("cfg_inc^") || data.startsWith("cfg_dec^")) {
    const parts = data.split("^");
    const direction = parts[0] === "cfg_inc^" ? 1 : -1;
    // Fix: parts[0] is "cfg_inc" or "cfg_dec"
    const isInc = data.startsWith("cfg_inc^");
    const field = parts[1];
    const topic = parts.slice(2).join("^");
    const limit = SETTINGS_LIMITS[field];
    if (!limit) return;

    const settings = getCourseSettings(chatId);
    const delta = isInc ? limit.step : -limit.step;
    settings[field] = Math.max(limit.min, Math.min(limit.max, (settings[field] || limit.min) + delta));
    setCourseSettings(chatId, settings);
    await saveState();

    const text = `${t("settingsTitle", escapeMarkdown(topic))}\n\n${t("settingsModules", settings.moduleCount)}\n${t("settingsSections", settings.sectionsPerModule)}\n${t("settingsQuestions", settings.questionCount)}\n${t("settingsPassScore", settings.passingScore)}`;
    const kb = courseSettingsKeyboard(settings, topic);
    await editMessageText(chatId, messageId, text, kb);
    return;
  }

  if (data.startsWith("cfg_go^")) {
    const topic = data.slice(7);
    await editMessageText(chatId, messageId, `✅ Запускаем генерацию по теме «<b>${escapeMarkdown(topic)}</b>»...`);
    const parsed = parseCreateArgs(topic);
    if (parsed.ok) await handleCreateCommand(chatId, parsed, false);
    return;
  }

  if (data === "cfg_cancel") {
    await editMessageText(chatId, messageId, "❌ Генерация отменена.");
    return;
  }

  if (data === "noop") return;

  // Create course / quiz from inline button
  if (data.startsWith("create_course^")) {
    const topic = data.split("^")[1] || "Без темы";
    await editMessageText(chatId, messageId, `✅ Создаём курс «<b>${escapeMarkdown(topic)}</b>»...`);
    // Show settings menu first
    const settings = getCourseSettings(chatId);
    const text = `${t("settingsTitle", escapeMarkdown(topic))}\n\n${t("settingsModules", settings.moduleCount)}\n${t("settingsSections", settings.sectionsPerModule)}\n${t("settingsQuestions", settings.questionCount)}\n${t("settingsPassScore", settings.passingScore)}`;
    const kb = courseSettingsKeyboard(settings, topic);
    await sendMessage(chatId, text, kb);
    return;
  }

  if (data.startsWith("create_quiz^")) {
    const topic = data.split("^")[1] || "Без темы";
    await editMessageText(chatId, messageId, `✅ Создаём тест «<b>${escapeMarkdown(topic)}</b>»...`);
    const parsed = parseCreateArgs(topic);
    if (parsed.ok) await handleCreateCommand(chatId, parsed, true);
    return;
  }

  if (data === "clear_materials") {
    await editMessageText(chatId, messageId, "Очищаю...");
    const { handleClearMaterials } = await import("../commands/materials.mjs");
    await handleClearMaterials(chatId);
    return;
  }

  // Preview navigation
  if (data.startsWith("prev_")) {
    // Format: prev_{courseId}_{index} — courseId may contain underscores!
    const withoutPrefix = data.slice(5); // remove "prev_"
    const lastUnderscore = withoutPrefix.lastIndexOf("_");
    if (lastUnderscore === -1) return;
    const courseId = withoutPrefix.slice(0, lastUnderscore);
    const index = parseInt(withoutPrefix.slice(lastUnderscore + 1) || "0", 10);
    const course = await getCourse(courseId);
    if (!course) { await editMessageText(chatId, messageId, t("previewExpired")); return; }
    const msg = buildScreenPreviewMessage(course, index);
    if (msg.text) await editMessageText(chatId, messageId, msg.text, msg.reply_markup ? { reply_markup: msg.reply_markup } : {}).catch(() => {});
    return;
  }

  // Download ZIP
  if (data.startsWith("dl_")) {
    const courseId = data.slice(3); // remove "dl_"
    try {
      const course = await getCourse(courseId);
      if (!course) { await sendMessage(chatId, t("previewExpired")); return; }
      const archive = await exportCourseToScormArchive(course);
      await sendDocument(chatId, archive.zipBuffer, archive.fileName, `SCORM: ${escapeMarkdown(course.title)}`);
    } catch (e) {
      await sendMessage(chatId, `Ошибка: ${escapeMarkdown(e.message || "unknown")}`);
    }
    return;
  }

  // Delete confirmation
  if (data.startsWith("delbtn_")) {
    const courseId = data.slice(7); // remove "delbtn_"
    const course = await getCourse(courseId);
    const title = course ? escapeMarkdown(course.title) : courseId;
    await editMessageText(chatId, messageId,
      `⚠️ Удалить курс «<b>${title}</b>»?\nЭто действие нельзя отменить.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Да, удалить", callback_data: `delyes_${courseId}` },
              { text: "❌ Отмена", callback_data: "delno" }
            ]
          ]
        }
      }
    );
    return;
  }

  // Delete confirmed
  if (data.startsWith("delyes_")) {
    const courseId = data.slice(7); // remove "delyes_"
    const { deleteCourse } = await import("../../../lib/course-store.js");
    const deleted = await deleteCourse(courseId);
    if (deleted) {
      await editMessageText(chatId, messageId, "🗑 Курс удалён.");
    } else {
      await editMessageText(chatId, messageId, "❌ Курс не найден или уже удалён.");
    }
    return;
  }

  // Delete cancelled
  if (data === "delno") {
    await editMessageText(chatId, messageId, "Удаление отменено.");
    return;
  }

  // Chamilo upload trigger
  if (data.startsWith("chamilo_")) {
    const courseId = data.slice(8); // remove "chamilo_"
    await startChamiloFlow(chatId, courseId);
    return;
  }
}
