import { sendMessage } from "../api.mjs";
import { escapeMarkdown } from "../config.mjs";
import { t } from "../i18n/index.mjs";
import { listCourses } from "../../../lib/course-store.js";

export async function handleMyCourses(chatId) {
  const courses = await listCourses({ limit: 15 });

  if (courses.length === 0) {
    await sendMessage(chatId, t("noCoursesYet"));
    return;
  }

  const lines = courses.map((c, i) => {
    const date = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString("ru-RU") : "—";
    const status = c.generationStatus === "completed" ? "✅" : "⏳";
    return `${i + 1}. ${status} <b>${escapeMarkdown(c.title)}</b>\n   📅 ${date} · 📦 ${c.moduleCount} мод.`;
  });

  // Each course gets preview + download + delete buttons
  const buttons = courses.slice(0, 10).map(c => {
    const short = `${c.title || "Курс"}`.slice(0, 20);
    return [
      { text: `👁 ${short}`, callback_data: `prev_${c.id}_0` },
      { text: "📥", callback_data: `dl_${c.id}` },
      { text: "🗑", callback_data: `delbtn_${c.id}` }
    ];
  });

  await sendMessage(chatId, `${t("coursesHeader")}\n\n${lines.join("\n\n")}`, {
    reply_markup: { inline_keyboard: buttons }
  });
}
