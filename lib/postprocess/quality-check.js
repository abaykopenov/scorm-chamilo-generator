import { normalizeText, isRuText } from "./text-utils.js";

export function looksCorruptedNarrative(value) {
  const text = normalizeText(value);
  if (!text) {
    return true;
  }

  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters === 0) {
    return true;
  }

  const questionMarks = (text.match(/\?/g) || []).length;
  const replacements = (text.match(/\uFFFD/g) || []).length;
  const mojibakeLetters = (text.match(/[\u00D0\u00D1\u00C2\u00C3]/g) || []).length;
  const cyrillicLetters = (text.match(/[\u0400-\u04FF]/g) || []).length;

  if (replacements > 0) {
    return true;
  }

  if ((questionMarks / letters) > 0.18) {
    return true;
  }

  if (mojibakeLetters > 0 && cyrillicLetters < 6 && (mojibakeLetters / letters) > 0.12) {
    return true;
  }

  return false;
}

export function looksTechnicalNoise(value) {
  const text = normalizeText(value);
  if (!text) {
    return true;
  }

  const letters = (text.match(/\p{L}/gu) || []).length;
  const symbols = (text.match(/[{}\[\]<>$\/]/g) || []).length;

  if (/(?:self-contained|microflow|trainingmanagement|location_[a-z0-9_]+|app[- ]?functions?|bars?\/buttons?|\$\[[^\]]+\]|addday\s*\(|\[[a-z_][^\]]{0,60}\]\s*\/\s*\[[a-z_][^\]]{0,60}\])/i.test(text)) {
    return true;
  }

  if (!isRuText(text) && letters > 0 && (symbols / letters) > 0.16) {
    return true;
  }

  return false;
}

export function placeholderLike(text) {
  const value = normalizeText(text);
  if (!value) {
    return true;
  }

  return /(?:\bscreen\b|\btopic\b|\bmodule\b)\s*\d+(?:\.\d+){0,5}/i.test(value)
    || /\u044d\u043a\u0440\u0430\u043d\s*\d+(?:\.\d+){0,5}(?:\s+\u0440\u0430\u0441\u043a\u0440\u044b\u0432\u0430\u0435\u0442)?/i.test(value)
    || /\b\d+(?:\.\d+){2,6}\b/.test(value)
    || /\u043a\u043b\u044e\u0447\u0435\u0432\u0430\u044f\s+\u0438\u0434\u0435\u044f\s+\d+(?:\.\d+){1,5}|\u043f\u0440\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439\s+\u0441\u0446\u0435\u043d\u0430\u0440\u0438\u0439\s+\d+(?:\.\d+){1,5}|\u043c\u0438\u043d\u0438-\u0432\u044b\u0432\u043e\u0434/i.test(value)
    || /this screen|key points?:|practical (takeaway|step)|introduces (the )?topic|covers topic|context and objective|capture one practical takeaway|middle:|start:|end:/i.test(value)
    || /\u0444\u043e\u043a\u0443\u0441\s+\u044d\u043a\u0440\u0430\u043d\u0430|topic focus|core points|action:\s|practical step|current topic|\u0442\u0435\u043a\u0443\u0449\u0430\u044f\s+\u0442\u0435\u043c\u0430/i.test(value)
    || /\u0441\u043d\u0430\u0447\u0430\u043b\u0430\s+\u0437\u0430\u0444\u0438\u043a\u0441\u0438\u0440\u0443\u0435\u043c|\u0434\u0430\u043b\u0435\u0435\s+\u0432\u044b\u0434\u0435\u043b\u0438\u043c|\u0432\s+\u043a\u043e\u043d\u0446\u0435\s+\u0437\u0430\u0444\u0438\u043a\u0441\u0438\u0440\u0443\u0439\u0442\u0435|\u043d\u0430\u0447\u0430\u043b\u043e:|\u0441\u0435\u0440\u0435\u0434\u0438\u043d\u0430:|\u0438\u0442\u043e\u0433:/i.test(value);
}

export function isTemplatePrompt(value) {
  const text = `${value || ""}`.trim().toLowerCase();
  if (!text) {
    return true;
  }
  return /^control question\b/.test(text)
    || /^\u043a\u043e\u043d\u0442\u0440\u043e\u043b\u044c\u043d\u044b\u0439 \u0432\u043e\u043f\u0440\u043e\u0441\b/.test(text)
    || /^question\s+\d+\b/.test(text)
    || /^\u0447\u0442\u043e \u043b\u0443\u0447\u0448\u0435 \u0432\u0441\u0435\u0433\u043e \u043e\u0442\u0440\u0430\u0436\u0430\u0435\u0442 \u0438\u0437\u0443\u0447\u0435\u043d\u0438\u0435 \u0442\u0435\u043c\u044b\b/.test(text)
    || /^what best reflects learning the topic\b/.test(text)
    || /^which option best reflects learning\b/.test(text)
    || /^\u043a\u0430\u043a\u043e\u0435 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0435 \u0432\u0435\u0440\u043d\u043e \u043f\u043e \u0442\u0435\u043c\u0435\b/.test(text);
}

export function isTemplateOption(value) {
  const text = `${value || ""}`.trim().toLowerCase();
  if (!text) {
    return true;
  }
  return /^option\s+\d+\b/.test(text)
    || /^\u0432\u0430\u0440\u0438\u0430\u043d\u0442\s+\d+\b/.test(text)
    || /^\u0444\u043e\u043a\u0443\u0441\u0438\u0440\u0443\u0435\u0442\u0441\u044f \u043d\u0430 \u0446\u0435\u043b\u0438\b/.test(text)
    || /^\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u0443\u0435\u0442 \u0446\u0435\u043b\u044c\b/.test(text)
    || /^\u043f\u0435\u0440\u0435\u043d\u043e\u0441\u0438\u0442 \u0440\u0435\u0448\u0435\u043d\u0438\u0435\b/.test(text)
    || /^\u043d\u0435 \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u043d\u0438\u043a\u0430\u043a\u043e\u0439 \u043e\u0446\u0435\u043d\u043a\u0438 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u0430\b/.test(text)
    || /^focuses on the goal\b/.test(text)
    || /^ignores the goal\b/.test(text)
    || /^moves the decision to an external system\b/.test(text)
    || /^does not require any result evaluation\b/.test(text);
}


