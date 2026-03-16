import { isAllowedChat, escapeMarkdown } from "../config.mjs";
import { sendMessage, editMessageText, telegramCall } from "../api.mjs";
import { getChatSession, getCourseSettings, setCourseSettings, setChatGenerationModel, saveState } from "../state.mjs";
import { courseSettingsKeyboard, profileSettingsKeyboard } from "../ui/keyboards.mjs";
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
  passingScore: { min: 50, max: 100, step: 10 },
  screensPerSco: { min: 1, max: 8, step: 1 }
};

const AUDIENCE_LABELS = { student: "🎓 Студенты", specialist: "👨‍💼 Специалисты", advanced: "🏅 Повышение квалификации" };
const STYLE_LABELS = { formal: "📋 Формальный", conversational: "💬 Разговорный", academic: "🏛 Академический" };

function buildSettingsText(topic, settings) {
  const s = settings;
  return [
    `⚙️ <b>Курс «${escapeMarkdown(topic)}»</b>`,
    ``,
    `📦 Модулей: ${s.moduleCount}`,
    `📑 Разделов: ${s.sectionsPerModule}`,
    `⏱ Экранов/SCO: ${s.screensPerSco || 2}`,
    `❓ Вопросов: ${s.questionCount}`,
    `🎯 Балл: ${s.passingScore}%`,
  ].join("\n");
}

function buildProfileText(settings, modelName) {
  const s = settings;
  const audienceLabel = AUDIENCE_LABELS[s.audienceLevel] || AUDIENCE_LABELS.student;
  const styleLabel = STYLE_LABELS[s.textStyle] || STYLE_LABELS.formal;
  const langLabels = { ru: "🇷🇺 Русский", en: "🇬🇧 English", kk: "🇰🇿 Қазақша", auto: "🔄 Авто" };
  const displayModel = (modelName || "auto").split(":")[0];
  return [
    `👤 <b>Профиль генерации</b>`,
    ``,
    `🎓 <b>Аудитория:</b> ${audienceLabel}`,
    `📝 <b>Стиль:</b> ${styleLabel}`,
    `🤖 <b>Модель:</b> <code>${escapeMarkdown(displayModel)}</code>`,
    `🌐 <b>Язык:</b> ${langLabels[s.outputLanguage] || langLabels.auto}`,
    ``,
    `<i>Нажмите кнопку для изменения</i>`,
  ].join("\n");
}

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

    const session = getChatSession(chatId, false);
    const text = buildSettingsText(topic, settings);
    const kb = courseSettingsKeyboard(settings, topic);
    await editMessageText(chatId, messageId, text, kb);
    return;
  }

  // ── Profile settings (separate screen, via /status or ⚙️) ──

  // Language toggle
  if (data === "profile_lang") {
    const settings = getCourseSettings(chatId);
    const cycle = { auto: "ru", ru: "en", en: "kk", kk: "auto" };
    settings.outputLanguage = cycle[settings.outputLanguage || "auto"] || "auto";
    setCourseSettings(chatId, settings);
    await saveState();
    const session = getChatSession(chatId, false);
    const text = buildProfileText(settings, session?.generationModel);
    const kb = profileSettingsKeyboard(settings, session?.generationModel);
    await editMessageText(chatId, messageId, text, kb);
    return;
  }

  // Model cycling
  if (data === "profile_model") {
    const session = getChatSession(chatId, true);
    let availableModels = [];
    try {
      const resp = await fetch("http://127.0.0.1:11434/api/tags");
      if (resp.ok) {
        const tags = await resp.json();
        availableModels = (tags.models || [])
          .map(m => m.name)
          .filter(n => !n.includes("embedding"));
      }
    } catch { /* Ollama unavailable */ }
    if (availableModels.length === 0) {
      availableModels = ["qwen3-coder:latest", "qwen2.5:72b", "gpt-oss:20b"];
    }
    const currentModel = session?.generationModel || "";
    const currentIndex = availableModels.indexOf(currentModel);
    const nextIndex = (currentIndex + 1) % availableModels.length;
    const nextModel = availableModels[nextIndex];
    setChatGenerationModel(chatId, nextModel);
    await saveState();
    const settings = getCourseSettings(chatId);
    const text = buildProfileText(settings, nextModel);
    const kb = profileSettingsKeyboard(settings, nextModel);
    await editMessageText(chatId, messageId, text, kb);
    return;
  }

  // Audience level toggle
  if (data === "profile_audience") {
    const settings = getCourseSettings(chatId);
    const cycle = { student: "specialist", specialist: "advanced", advanced: "student" };
    settings.audienceLevel = cycle[settings.audienceLevel || "student"] || "student";
    setCourseSettings(chatId, settings);
    await saveState();
    const session = getChatSession(chatId, false);
    const text = buildProfileText(settings, session?.generationModel);
    const kb = profileSettingsKeyboard(settings, session?.generationModel);
    await editMessageText(chatId, messageId, text, kb);
    return;
  }

  // Text style toggle
  if (data === "profile_style") {
    const settings = getCourseSettings(chatId);
    const cycle = { formal: "conversational", conversational: "academic", academic: "formal" };
    settings.textStyle = cycle[settings.textStyle || "formal"] || "formal";
    setCourseSettings(chatId, settings);
    await saveState();
    const session = getChatSession(chatId, false);
    const text = buildProfileText(settings, session?.generationModel);
    const kb = profileSettingsKeyboard(settings, session?.generationModel);
    await editMessageText(chatId, messageId, text, kb);
    return;
  }

  // Ollama URL
  if (data === "profile_url") {
    const session = getChatSession(chatId, true);
    session._awaitingOllamaUrl = true;
    await saveState();
    await editMessageText(chatId, messageId,
      `🔗 <b>Введите URL Ollama сервера:</b>\n\nТекущий: <code>${escapeMarkdown(session?.ollamaUrl || "http://127.0.0.1:11434")}</code>\n\nПример: <code>http://192.168.1.100:11434</code>\nИли отправьте <code>local</code> для локального.`
    );
    return;
  }

  // Materials list with delete buttons
  if (data === "profile_mats") {
    const session = getChatSession(chatId, false);
    const files = session?.files || [];
    if (files.length === 0) {
      await editMessageText(chatId, messageId,
        `📚 Нет загруженных материалов.\n\nОтправьте PDF или DOCX файл.`,
        { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "profile_back" }]] } }
      );
      return;
    }
    const materialsList = files.map((f, i) =>
      `${i + 1}. 📄 ${escapeMarkdown(f.fileName)} (${f.status === "indexed" ? "✅" : "⏳"})`
    ).join("\n");
    const text = `📚 <b>Материалы:</b>\n\n${materialsList}\n\n<i>Нажмите 🗑 для удаления</i>`;
    const fileButtons = files.map((f, i) => [
      { text: `🗑 ${f.fileName.slice(0, 25)}`, callback_data: `profile_delfile_${i}` }
    ]);
    fileButtons.push([{ text: "⬅️ Назад", callback_data: "profile_back" }]);
    await editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: fileButtons } });
    return;
  }

  // Delete individual file
  if (data.startsWith("profile_delfile_")) {
    const fileIndex = parseInt(data.slice(16), 10);
    const session = getChatSession(chatId, true);
    if (!session || !session.files || fileIndex < 0 || fileIndex >= session.files.length) {
      await editMessageText(chatId, messageId, "❌ Файл не найден.");
      return;
    }
    const removed = session.files.splice(fileIndex, 1)[0];
    // Also remove from materialIds if present
    if (removed.materialId) {
      session.materialIds = (session.materialIds || []).filter(id => id !== removed.materialId);
    }
    await saveState();
    // Re-show materials list
    const files = session.files;
    if (files.length === 0) {
      await editMessageText(chatId, messageId,
        `✅ Файл «${escapeMarkdown(removed.fileName)}» удалён.\n\n📚 Больше нет материалов.`,
        { reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "profile_back" }]] } }
      );
      return;
    }
    const materialsList = files.map((f, i) =>
      `${i + 1}. 📄 ${escapeMarkdown(f.fileName)} (${f.status === "indexed" ? "✅" : "⏳"})`
    ).join("\n");
    const text = `✅ <b>${escapeMarkdown(removed.fileName)}</b> удалён\n\n📚 <b>Материалы:</b>\n\n${materialsList}`;
    const fileButtons = files.map((f, i) => [
      { text: `🗑 ${f.fileName.slice(0, 25)}`, callback_data: `profile_delfile_${i}` }
    ]);
    fileButtons.push([{ text: "⬅️ Назад", callback_data: "profile_back" }]);
    await editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: fileButtons } });
    return;
  }

  // Back to profile from materials
  if (data === "profile_back") {
    const settings = getCourseSettings(chatId);
    const session = getChatSession(chatId, false);
    const text = buildProfileText(settings, session?.generationModel);
    const kb = profileSettingsKeyboard(settings, session?.generationModel);
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
    const session = getChatSession(chatId, false);
    const text = buildSettingsText(topic, settings);
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

  // Download PDF (must be before dl_ check to avoid prefix collision)
  if (data.startsWith("dlpdf_")) {
    const courseId = data.slice(6); // remove "dlpdf_"
    try {
      await editMessageText(chatId, messageId, "📄 Генерирую PDF...");
      const course = await getCourse(courseId);
      if (!course) { await editMessageText(chatId, messageId, t("previewExpired")); return; }
      const { exportCourseToPdf } = await import("../../../lib/export/pdf-exporter.js");
      const pdfBuffer = await exportCourseToPdf(course);
      const fileName = `${(course.title || "course").replace(/[^\p{L}\p{N}_-]+/gu, "_")}.pdf`;
      await sendDocument(chatId, pdfBuffer, fileName, `📄 PDF: ${escapeMarkdown(course.title)}`);
    } catch (e) {
      console.error(`[bot] PDF export error: ${e?.message || e}`);
      await sendMessage(chatId, `Ошибка PDF: ${escapeMarkdown(e?.message || "unknown")}`);
    }
    return;
  }

  // Download PPTX (must be before dl_ check to avoid prefix collision)
  if (data.startsWith("dlpptx_")) {
    const courseId = data.slice(7); // remove "dlpptx_"
    try {
      await editMessageText(chatId, messageId, "📊 Генерирую PPTX...");
      const course = await getCourse(courseId);
      if (!course) { await editMessageText(chatId, messageId, t("previewExpired")); return; }
      const { exportCourseToPptx } = await import("../../../lib/export/pptx-exporter.js");
      const pptxBuffer = await exportCourseToPptx(course);
      const fileName = `${(course.title || "course").replace(/[^\p{L}\p{N}_-]+/gu, "_")}.pptx`;
      await sendDocument(chatId, pptxBuffer, fileName, `📊 PPTX: ${escapeMarkdown(course.title)}`);
    } catch (e) {
      console.error(`[bot] PPTX export error: ${e?.message || e}`);
      await sendMessage(chatId, `Ошибка PPTX: ${escapeMarkdown(e?.message || "unknown")}`);
    }
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
