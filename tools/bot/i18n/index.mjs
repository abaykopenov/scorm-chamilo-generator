import { BOT_LANGUAGE } from "../config.mjs";
import { ru } from "./ru.mjs";

const locales = { ru };

export function t(key, ...args) {
  const strings = locales[BOT_LANGUAGE] || locales.ru;
  const val = strings[key];
  if (typeof val === "function") return val(...args);
  return val || key;
}
