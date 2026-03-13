import { sendMessage } from "../api.mjs";
import { isAdmin, escapeMarkdown } from "../config.mjs";
import { activeChats } from "../state.mjs";
import { t } from "../i18n/index.mjs";
import prisma from "../../../lib/db.js";

export async function handleAdmin(chatId, args) {
  if (!isAdmin(chatId)) {
    await sendMessage(chatId, t("adminNotAllowed"));
    return;
  }

  const parts = `${args || ""}`.trim().split(/\s+/);
  const sub = (parts[0] || "").toLowerCase();

  if (!sub || sub === "help") {
    await sendMessage(chatId, t("adminHelp"));
    return;
  }

  if (sub === "stats") {
    const totalUsers = await prisma.telegramUser.count();
    const approvedUsers = await prisma.telegramUser.count({ where: { status: "approved" } });
    const bannedUsers = await prisma.telegramUser.count({ where: { status: "banned" } });
    const totalLogs = await prisma.generationLog.count();
    const completedLogs = await prisma.generationLog.count({ where: { status: "completed" } });
    const failedLogs = await prisma.generationLog.count({ where: { status: "failed" } });

    await sendMessage(chatId, [
      "📊 <b>Статистика:</b>",
      "",
      `👥 Пользователей: ${totalUsers}`,
      `  ✅ Approved: ${approvedUsers}`,
      `  🚫 Banned: ${bannedUsers}`,
      "",
      `📋 Генераций: ${totalLogs}`,
      `  ✅ Completed: ${completedLogs}`,
      `  ❌ Failed: ${failedLogs}`,
      "",
      `🔄 Активных: ${activeChats.size}`
    ].join("\n"));
    return;
  }

  if (sub === "users") {
    const users = await prisma.telegramUser.findMany({ take: 20, orderBy: { createdAt: "desc" } });
    if (users.length === 0) { await sendMessage(chatId, "Пользователей нет."); return; }
    const lines = users.map((u, i) => {
      const status = u.status === "approved" ? "✅" : u.status === "banned" ? "🚫" : "⏳";
      return `${i + 1}. ${status} <code>${u.id}</code> ${escapeMarkdown(u.email || "—")} (gen: ${u.generationsCount || 0})`;
    });
    await sendMessage(chatId, `<b>Пользователи (последние 20):</b>\n\n${lines.join("\n")}`);
    return;
  }

  if (sub === "ban") {
    const target = `${parts[1] || ""}`.trim();
    if (!target) { await sendMessage(chatId, "Не указан chatId. Формат: /admin ban <code>chatId</code>"); return; }
    try {
      await prisma.telegramUser.update({ where: { id: target }, data: { status: "banned" } });
      await sendMessage(chatId, `🚫 Пользователь ${target} заблокирован.`);
    } catch { await sendMessage(chatId, `Пользователь ${target} не найден.`); }
    return;
  }

  if (sub === "unban") {
    const target = `${parts[1] || ""}`.trim();
    if (!target) { await sendMessage(chatId, "Не указан chatId."); return; }
    try {
      await prisma.telegramUser.update({ where: { id: target }, data: { status: "approved" } });
      await sendMessage(chatId, `✅ Пользователь ${target} разблокирован.`);
    } catch { await sendMessage(chatId, `Пользователь ${target} не найден.`); }
    return;
  }

  await sendMessage(chatId, t("adminHelp"));
}
