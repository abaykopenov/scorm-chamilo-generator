import { sendMessage } from "../api.mjs";
import { t } from "../i18n/index.mjs";
import { mainKeyboard } from "../ui/keyboards.mjs";

export async function handleStart(chatId) {
  const text = `${t("welcome")}\n\n${t("onboarding")}`;
  await sendMessage(chatId, text, mainKeyboard());
}

export async function handleHelp(chatId) {
  await sendMessage(chatId, t("help"), mainKeyboard());
}
