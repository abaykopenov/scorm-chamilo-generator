import { escapeMarkdown } from "../config.mjs";
import { navigationKeyboard } from "./keyboards.mjs";
import { t } from "../i18n/index.mjs";

export function flattenCourseScreens(course) {
  const screens = [];
  if (Array.isArray(course?.modules)) {
    for (const mod of course.modules) {
      for (const sec of (mod?.sections || [])) {
        for (const sco of (sec?.scos || [])) {
          for (const scr of (sco?.screens || [])) {
            screens.push({
              heading: `${mod.title} / ${sec.title} / ${sco.title}`,
              title: scr.title,
              blocks: scr.blocks || [],
              isQuiz: false
            });
          }
        }
      }
    }
  }
  if (course?.finalTest?.enabled && Array.isArray(course.finalTest.questions)) {
    screens.push({
      heading: `${course.title} / ${course.finalTest.title || "Итоговый тест"}`,
      title: `🏁 Тест: ${course.finalTest.questions.length} вопросов`,
      blocks: course.finalTest.questions.map((q, idx) => ({
        type: "text", text: `${idx + 1}. ${q.prompt}`
      })),
      isQuiz: true
    });
  }
  return screens;
}

export function buildScreenPreviewMessage(course, globalIndex) {
  const screens = flattenCourseScreens(course);
  if (screens.length === 0) return { text: t("previewEmpty"), reply_markup: null };

  const index = Math.max(0, Math.min(globalIndex, screens.length - 1));
  const screen = screens[index];

  let text = t("previewTitle", index + 1, screens.length) + "\n";
  text += `📍 <i>${escapeMarkdown(screen.heading)}</i>\n\n`;
  text += `<b>${escapeMarkdown(screen.title)}</b>\n\n`;

  const blockLines = [];
  for (const block of screen.blocks) {
    if (block.type === "note") continue;
    if (block.type === "list" && Array.isArray(block.items)) {
      for (const item of block.items) blockLines.push(`• ${escapeMarkdown(item)}`);
    } else if (block.type === "image") {
      blockLines.push("🖼 [Изображение]");
    } else if (block.text) {
      blockLines.push(escapeMarkdown(block.text));
    }
  }

  const content = blockLines.join("\n\n");
  text += content.length > 3000 ? content.slice(0, 3000) + "..." : content;

  return { text, reply_markup: navigationKeyboard(course.id, index, screens.length) };
}
