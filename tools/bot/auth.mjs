import prisma from "../../lib/db.js";
import { sendMessage } from "./api.mjs";
import { ALLOWED_EMAIL_DOMAINS, escapeMarkdown } from "./config.mjs";
import { mainKeyboard } from "./ui/keyboards.mjs";
import { t } from "./i18n/index.mjs";
import { sendAuthCode } from "../../lib/mailer.js";

export async function handleAuth(chatId, dbUser, text) {
  if (dbUser.status === "banned") {
    await sendMessage(chatId, t("authBanned"));
    return true;
  }

  if (dbUser.status === "approved") return false;

  if (text === "/start") {
    const domains = ALLOWED_EMAIL_DOMAINS.join(", ");
    await sendMessage(chatId, `${t("welcome")}\n\n${t("authEnterEmail", domains)}`);
    return true;
  }

  if (dbUser.status === "guest") {
    const emailLower = text.toLowerCase();
    const isValid = ALLOWED_EMAIL_DOMAINS.some(d => emailLower.endsWith(d)) && emailLower.includes("@");
    if (!isValid) {
      await sendMessage(chatId, t("authInvalidDomain", ALLOWED_EMAIL_DOMAINS.join(", ")));
      return true;
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60000);
    await prisma.telegramUser.update({
      where: { id: dbUser.id },
      data: { email: text, status: "pending_code", authCode: code, authCodeExpiresAt: expiresAt, failedAttempts: 0 }
    });
    const sent = await sendAuthCode(text, code);
    await sendMessage(chatId, sent ? t("authCodeSent", escapeMarkdown(text)) : t("authCodeFailed", escapeMarkdown(text)));
    return true;
  }

  if (dbUser.status === "pending_code") {
    if (text.length === 6 && /^\d+$/.test(text)) {
      if (dbUser.authCode === text && dbUser.authCodeExpiresAt && new Date() < dbUser.authCodeExpiresAt) {
        await prisma.telegramUser.update({
          where: { id: dbUser.id },
          data: { status: "approved", authCode: null, authCodeExpiresAt: null, failedAttempts: 0 }
        });
        await sendMessage(chatId, t("authSuccess"), mainKeyboard());
      } else {
        const attempts = dbUser.failedAttempts + 1;
        if (attempts >= 3) {
          await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { status: "guest", authCode: null, failedAttempts: 0 } });
          await sendMessage(chatId, t("authTooManyAttempts"));
        } else {
          await prisma.telegramUser.update({ where: { id: dbUser.id }, data: { failedAttempts: attempts } });
          await sendMessage(chatId, t("authWrongCode", 3 - attempts));
        }
      }
    } else {
      await sendMessage(chatId, t("authEnterCode"));
    }
    return true;
  }

  return true;
}
