import { createId } from "./ids.js";
import { rebuildCourseStructure } from "./structure-engine.js";

const MIN_SCREEN_TEXT_LENGTH = 180;
const MIN_SCREEN_TEXT_WORDS = 28;
const MIN_SCREEN_SENTENCES = 2;

function looksLikeMojibake(value) {
  const source = `${value || ""}`;
  if (!source) {
    return false;
  }
  return /(?:\u00D0.|\u00D1.|\u00C3.|\u00C2.)/.test(source)
    || /\u00EF\u00BF\u00BD/.test(source)
    || /\uFFFD/.test(source);
}

function textQualityScore(value) {
  const source = `${value || ""}`;
  const cyr = (source.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  const broken = (source.match(/\uFFFD/g) || []).length
    + (source.match(/\u00EF\u00BF\u00BD/g) || []).length
    + (source.match(/\u001A/g) || []).length;
  return (cyr * 2) + latin - (broken * 5);
}

function tryFixMojibake(value) {
  let current = `${value || ""}`;
  if (!current || !looksLikeMojibake(current)) {
    return current;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recoded = Buffer.from(current, "latin1").toString("utf8");
    if (!recoded || recoded === current) {
      break;
    }
    if (textQualityScore(recoded) >= textQualityScore(current)) {
      current = recoded;
      continue;
    }
    break;
  }

  return current;
}
function normalizeText(value) {
  return tryFixMojibake(`${value || ""}`)
    .replace(/\r/g, "\n")
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    .replace(/-\s*\n\s*/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*(?:\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u0435|Note)\s*:[^\n]*(?:\n|$)/gimu, "")
    .trim();
}

function truncateAtBoundary(text, maxLength) {
  const value = normalizeText(text);
  if (!value || value.length <= maxLength) {
    return value;
  }

  const sentenceBounds = [". ", "! ", "? ", ".", "!", "?"];
  for (const marker of sentenceBounds) {
    const index = value.lastIndexOf(marker, maxLength);
    if (index >= Math.floor(maxLength * 0.6)) {
      const end = marker.length > 1 ? index + marker.length - 1 : index + 1;
      return value.slice(0, end).trim();
    }
  }

  const chunk = value.slice(0, maxLength + 1);
  const wordBoundary = chunk.lastIndexOf(" ");
  if (wordBoundary >= Math.floor(maxLength * 0.55)) {
    return chunk.slice(0, wordBoundary).trim();
  }

  return value.slice(0, maxLength).trim();
}

function removeDanglingTail(text) {
  let value = normalizeText(text)
    .replace(/[,:;\-…]+\s*$/u, "")
    .trim();

  if (!/[.!?]$/.test(value)) {
    const orphan = value.match(/^(.*)\s+(\p{L}{1,2})$/u);
    if (orphan?.[1] && orphan[1].length >= 40) {
      value = orphan[1].trim();
    }
  }

  return value;
}

function cleanNarrativeText(text, maxLength) {
  return removeDanglingTail(truncateAtBoundary(text, maxLength));
}

function sentencePool(text) {
  const normalized = normalizeText(text).replace(/\n+/g, " ");
  if (!normalized) {
    return [];
  }

  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => cleanNarrativeText(part, 180))
    .filter((part) => part.length >= 20);

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(part);
  }

  return unique;
}

function placeholderLike(text) {
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

function isPlaceholderTitle(value) {
  const text = cleanNarrativeText(value, 120);
  if (!text) {
    return true;
  }
  return /^(screen|topic|module|section|sco)\b/i.test(text)
    || /^\u044d\u043a\u0440\u0430\u043d\b/i.test(text)
    || /\b\d+(?:\.\d+){0,5}\b/.test(text);
}

function isWeakHierarchyTitle(value) {
  const normalized = cleanNarrativeText(value, 120).toLowerCase();
  if (!normalized) {
    return true;
  }
  return isPlaceholderTitle(normalized)
    || /\|\s*(module|section|sco)\s*\d+/i.test(normalized)
    || /^(?:module|section|sco)\s*\d+/i.test(normalized)
    || /^(?:\u043c\u043e\u0434\u0443\u043b\u044c|\u0440\u0430\u0437\u0434\u0435\u043b)\s*\d+(?:\.\d+){0,3}$/i.test(normalized);
}

function normalizeHierarchyTitles(modules, courseTitle) {
  const fallbackTopic = cleanNarrativeText(courseTitle || "\u0422\u0435\u043c\u0430 \u043a\u0443\u0440\u0441\u0430", 120)
    || "\u0422\u0435\u043c\u0430 \u043a\u0443\u0440\u0441\u0430";

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const moduleItem = modules[moduleIndex];
    const moduleRaw = cleanNarrativeText(moduleItem?.title || "", 140);
    const moduleFallback = `\u041c\u043e\u0434\u0443\u043b\u044c ${moduleIndex + 1}: ${fallbackTopic}`;
    moduleItem.title = isWeakHierarchyTitle(moduleRaw) ? moduleFallback : moduleRaw;

    const sections = Array.isArray(moduleItem?.sections) ? moduleItem.sections : [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex];
      const sectionRaw = cleanNarrativeText(section?.title || "", 120);
      const sectionFallback = `\u0420\u0430\u0437\u0434\u0435\u043b ${moduleIndex + 1}.${sectionIndex + 1}`;
      section.title = isWeakHierarchyTitle(sectionRaw) ? sectionFallback : sectionRaw;

      const scos = Array.isArray(section?.scos) ? section.scos : [];
      for (let scoIndex = 0; scoIndex < scos.length; scoIndex += 1) {
        const sco = scos[scoIndex];
        const scoRaw = cleanNarrativeText(sco?.title || "", 120);
        const scoFallback = `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`;
        sco.title = isWeakHierarchyTitle(scoRaw) ? scoFallback : scoRaw;

        const screens = Array.isArray(sco?.screens) ? sco.screens : [];
        for (let screenIndex = 0; screenIndex < screens.length; screenIndex += 1) {
          const screen = screens[screenIndex];
          const screenRaw = cleanNarrativeText(screen?.title || "", 120);
          const screenFallback = `\u042d\u043a\u0440\u0430\u043d ${screenIndex + 1}`;
          screen.title = isWeakHierarchyTitle(screenRaw) ? screenFallback : screenRaw;
        }
      }
    }
  }
}
function isLowQualityScreenText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return true;
  }
  if (placeholderLike(normalized)) {
    return true;
  }

  const sentences = sentencePool(normalized);
  const words = normalized.split(/\s+/).filter(Boolean).length;
  return normalized.length < MIN_SCREEN_TEXT_LENGTH
    || words < MIN_SCREEN_TEXT_WORDS
    || sentences.length < MIN_SCREEN_SENTENCES;
}

function buildBullets(seedText, fallbackTitle) {
  const fromText = sentencePool(seedText)
    .slice(0, 3)
    .map((item) => truncateAtBoundary(item, 140))
    .filter((item) => !placeholderLike(item));
  const ru = /[\u0400-\u04FF]/.test(`${seedText || ""} ${fallbackTitle || ""}`);

  const fallback = ru
    ? [
        `\u041a\u043b\u044e\u0447\u0435\u0432\u0430\u044f \u0438\u0434\u0435\u044f \u043f\u043e \u0442\u0435\u043c\u0435 ${fallbackTitle}`,
        `\u041a\u0430\u043a \u043f\u0440\u0438\u043c\u0435\u043d\u0438\u0442\u044c ${fallbackTitle} \u0432 \u0440\u0430\u0431\u043e\u0447\u0435\u0439 \u0437\u0430\u0434\u0430\u0447\u0435`,
        `\u041a\u0430\u043a\u043e\u0439 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u043f\u043e\u0441\u043b\u0435 \u0438\u0437\u0443\u0447\u0435\u043d\u0438\u044f ${fallbackTitle}`
      ]
    : [
        `Key idea for ${fallbackTitle}`,
        `How to apply ${fallbackTitle} in a real task`,
        `What result to verify after ${fallbackTitle}`
      ];

  const merged = [];
  const seen = new Set();
  for (const item of [...fromText, ...fallback]) {
    const text = cleanNarrativeText(item, 140);
    if (!text || placeholderLike(text)) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(text);
    if (merged.length >= 3) {
      break;
    }
  }

  while (merged.length < 3) {
    merged.push(ru ? `\u041a\u043b\u044e\u0447\u0435\u0432\u0430\u044f \u0438\u0434\u0435\u044f \u043f\u043e \u0442\u0435\u043c\u0435 ${fallbackTitle}` : `Key point for ${fallbackTitle}`);
  }

  return merged;
}

function buildScreenNarrative({ text, bullets, title, audience, phase, courseTitle }) {
  const ru = /[\u0400-\u04FF]/.test(`${text || ""} ${title || ""} ${audience || ""} ${courseTitle || ""}`);
  const safeTitle = cleanNarrativeText(title || (ru ? "\u0422\u0435\u043c\u0430" : "Topic"), 96) || (ru ? "\u0422\u0435\u043c\u0430" : "Topic");
  const safeAudience = cleanNarrativeText(audience || (ru ? "\u0441\u043b\u0443\u0448\u0430\u0442\u0435\u043b\u0438" : "learners"), 96) || (ru ? "\u0441\u043b\u0443\u0448\u0430\u0442\u0435\u043b\u0438" : "learners");
  const safeCourseTitle = cleanNarrativeText(courseTitle || "", 120);
  const genericTitle = /^(?:current|generic)\s+topic$/i.test(safeTitle)
    || /^(?:\u0442\u0435\u043a\u0443\u0449\u0430\u044f|\u043e\u0431\u0449\u0430\u044f)\s+\u0442\u0435\u043c\u0430$/i.test(safeTitle);
  const titleForNarrative = isPlaceholderTitle(safeTitle) || genericTitle
    ? (safeCourseTitle || (ru ? "\u0442\u0435\u043c\u0430 \u043a\u0443\u0440\u0441\u0430" : "course topic"))
    : safeTitle;

  const seedSentences = sentencePool(text)
    .filter((item) => !placeholderLike(item))
    .slice(0, 3);
  const sourceLine = seedSentences[0] || "";
  const variantSeed = `${titleForNarrative}|${phase}|${safeAudience}`;
  const variant = [...variantSeed].reduce((acc, char) => (acc * 33 + char.charCodeAt(0)) % 1024, 7) % 3;
  const contextTemplatesRu = [
    `\u0420\u0430\u0437\u0431\u0438\u0440\u0430\u0435\u043c \u0442\u0435\u043c\u0443 "${titleForNarrative}" \u0432 \u043f\u0440\u0438\u0432\u044f\u0437\u043a\u0435 \u043a \u0437\u0430\u0434\u0430\u0447\u0430\u043c \u0430\u0443\u0434\u0438\u0442\u043e\u0440\u0438\u0438 "${safeAudience}".`,
    `\u0426\u0435\u043b\u044c \u044d\u0442\u043e\u0433\u043e \u0448\u0430\u0433\u0430 \u2014 \u043f\u043e\u043d\u044f\u0442\u044c, \u043a\u0430\u043a "${titleForNarrative}" \u043f\u0440\u0438\u043c\u0435\u043d\u044f\u0435\u0442\u0441\u044f \u0432 \u0435\u0436\u0435\u0434\u043d\u0435\u0432\u043d\u043e\u0439 \u0440\u0430\u0431\u043e\u0442\u0435 "${safeAudience}".`,
    `\u0424\u043e\u043a\u0443\u0441 \u044d\u043a\u0440\u0430\u043d\u0430: "${titleForNarrative}". \u041d\u0438\u0436\u0435 \u2014 \u043a\u043b\u044e\u0447\u0435\u0432\u044b\u0435 \u0440\u0435\u0448\u0435\u043d\u0438\u044f \u0438 \u043f\u0440\u0438\u043c\u0435\u0440\u044b \u0434\u043b\u044f "${safeAudience}".`
  ];
  const contextTemplatesEn = [
    `This part explains "${titleForNarrative}" for ${safeAudience} with practical context.`,
    `The goal here is to apply "${titleForNarrative}" to a real ${safeAudience} workflow.`,
    `Focus topic: "${titleForNarrative}". Below are practical decisions and examples for ${safeAudience}.`
  ];
  const contextLine = ru ? contextTemplatesRu[variant] : contextTemplatesEn[variant];

  const detailItems = (Array.isArray(bullets) ? bullets : [])
    .map((item) => cleanNarrativeText(item, 120))
    .filter(Boolean)
    .filter((item) => !placeholderLike(item))
    .slice(0, 3);
  while (detailItems.length < 3) {
    detailItems.push(
      ru
        ? `\u041a\u043b\u044e\u0447\u0435\u0432\u0430\u044f \u0438\u0434\u0435\u044f \u043f\u043e \u0442\u0435\u043c\u0435 ${titleForNarrative}`
        : `Key point for ${titleForNarrative}`
    );
  }

  const bodySource = sourceLine
    ? (ru ? `\u041a\u043e\u043d\u0442\u0435\u043a\u0441\u0442: ${sourceLine}.` : `Context: ${sourceLine}.`)
    : (ru ? `\u041e\u043f\u043e\u0440\u043d\u0430\u044f \u043c\u044b\u0441\u043b\u044c: ${detailItems[0]}.` : `Anchor idea: ${detailItems[0]}.`);
  const detailLine = ru
    ? `\u041a\u043b\u044e\u0447\u0435\u0432\u044b\u0435 \u0442\u0435\u0437\u0438\u0441\u044b: 1) ${detailItems[0]}; 2) ${detailItems[1]}; 3) ${detailItems[2]}.`
    : `Key points: 1) ${detailItems[0]}; 2) ${detailItems[1]}; 3) ${detailItems[2]}.`;

  const actionLine = phase === "outro"
    ? (ru
      ? `\u0412 \u0438\u0442\u043e\u0433\u0435 \u0441\u043e\u0441\u0442\u0430\u0432\u044c\u0442\u0435 \u043a\u043e\u0440\u043e\u0442\u043a\u0438\u0439 \u0447\u0435\u043a-\u043b\u0438\u0441\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u0437\u043d\u0430\u043d\u0438\u0439 \u043f\u043e \u0442\u0435\u043c\u0435 "${titleForNarrative}" \u0434\u043b\u044f "${safeAudience}" \u0438 \u0437\u0430\u0444\u0438\u043a\u0441\u0438\u0440\u0443\u0439\u0442\u0435 \u043a\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u0443\u0441\u043f\u0435\u0445\u0430.`
      : `Finish by creating a short knowledge-check for "${titleForNarrative}" for ${safeAudience} with one clear success criterion.`)
    : (ru
      ? `\u041f\u0440\u0430\u043a\u0442\u0438\u043a\u0430: \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043e\u0434\u043d\u0443 \u0440\u0430\u0431\u043e\u0447\u0443\u044e \u0441\u0438\u0442\u0443\u0430\u0446\u0438\u044e, \u0433\u0434\u0435 "${titleForNarrative}" \u043d\u0443\u0436\u043d\u043e \u043f\u0440\u0438\u043c\u0435\u043d\u0438\u0442\u044c \u0441\u0440\u0430\u0437\u0443, \u0438 \u043e\u043f\u0438\u0448\u0438\u0442\u0435 \u0448\u0430\u0433\u0438 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u044f.`
      : `Practice: pick one real task where "${titleForNarrative}" must be applied immediately and outline the execution steps.`);

  return cleanNarrativeText([contextLine, bodySource, detailLine, actionLine].join("\n\n"), 980);
}

function ensureScreenTextDepth({ text, bullets, title, audience, phase, courseTitle }) {
  const normalized = cleanNarrativeText(text, 980);
  if (!isLowQualityScreenText(normalized)) {
    return normalized;
  }

  const rebuilt = buildScreenNarrative({
    text: normalized,
    bullets,
    title,
    audience,
    phase,
    courseTitle
  });

  if (!isLowQualityScreenText(rebuilt)) {
    return rebuilt;
  }

  const ru = /[\u0400-\u04FF]/.test(`${title || ""} ${courseTitle || ""} ${audience || ""}`);
  const extraLine = ru
    ? `\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0443\u0441\u0432\u043e\u0435\u043d\u0438\u044f: \u043e\u0442\u043c\u0435\u0442\u044c\u0442\u0435, \u043a\u0430\u043a\u0438\u0435 \u0434\u0432\u0430 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0438\u0437 \u044d\u043a\u0440\u0430\u043d\u0430 \u0432\u044b \u0432\u043d\u0435\u0434\u0440\u0438\u0442\u0435 \u0432 \u0431\u043b\u0438\u0436\u0430\u0439\u0448\u0435\u0439 \u0440\u0430\u0431\u043e\u0447\u0435\u0439 \u0437\u0430\u0434\u0430\u0447\u0435.`
    : "Adoption check: list two actions from this screen that you will apply in your next work task.";
  return cleanNarrativeText(`${rebuilt}\n\n${extraLine}`, 980);
}

function getBlockIndex(blocks, type) {
  return blocks.findIndex((block) => block?.type === type);
}

function ensureTextBlock(blocks, text) {
  const index = getBlockIndex(blocks, "text");
  const payload = {
    type: "text",
    text: cleanNarrativeText(text, 880)
  };

  if (index >= 0) {
    blocks[index] = payload;
    return;
  }

  blocks.unshift(payload);
}

function ensureListBlock(blocks, items) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => cleanNarrativeText(item, 140))
    .filter(Boolean)
    .slice(0, 3);

  while (normalizedItems.length < 3) {
    normalizedItems.push(`Key point ${normalizedItems.length + 1}`);
  }

  const index = getBlockIndex(blocks, "list");
  const payload = {
    type: "list",
    items: normalizedItems
  };

  if (index >= 0) {
    blocks[index] = payload;
    return;
  }

  blocks.push(payload);
}

function isRuText(value) {
  return /[\u0400-\u04FF]/.test(`${value || ""}`);
}

function isTemplatePrompt(value) {
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

function isTemplateOption(value) {
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

function collectQuestionKnowledge(modules, courseTitle) {
  const fallbackTopic = cleanNarrativeText(courseTitle || "Course", 120) || "Course";
  const entries = [];

  for (const moduleItem of Array.isArray(modules) ? modules : []) {
    for (const sectionItem of Array.isArray(moduleItem?.sections) ? moduleItem.sections : []) {
      for (const scoItem of Array.isArray(sectionItem?.scos) ? sectionItem.scos : []) {
        for (const screenItem of Array.isArray(scoItem?.screens) ? scoItem.screens : []) {
          const topicCandidates = [
            screenItem?.title,
            scoItem?.title,
            sectionItem?.title,
            moduleItem?.title,
            fallbackTopic
          ].map((value) => cleanNarrativeText(value || "", 120));
          const topic = topicCandidates.find((value) => value && !isPlaceholderTitle(value)) || fallbackTopic;

          const textPayload = (Array.isArray(screenItem?.blocks) ? screenItem.blocks : [])
            .map((block) => {
              if (block?.type === "text") {
                return `${block?.text || ""}`;
              }
              if (block?.type === "list" && Array.isArray(block?.items)) {
                return block.items.join(". ");
              }
              return "";
            })
            .filter(Boolean)
            .join(" ");

          for (const sentence of sentencePool(textPayload)) {
            entries.push({
              topic: topic || fallbackTopic,
              statement: cleanNarrativeText(sentence, 170)
            });
          }
        }
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.statement) {
      continue;
    }
    const key = entry.statement.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }

  if (unique.length > 0) {
    return unique;
  }

  const ru = isRuText(fallbackTopic);
  return [
    {
      topic: fallbackTopic,
      statement: ru
        ? `\u0422\u0435\u043c\u0430 \u043a\u0443\u0440\u0441\u0430 "${fallbackTopic}" \u043e\u043f\u0438\u0441\u044b\u0432\u0430\u0435\u0442 \u043a\u043b\u044e\u0447\u0435\u0432\u044b\u0435 \u0440\u0430\u0431\u043e\u0447\u0438\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0438 \u043e\u0436\u0438\u0434\u0430\u0435\u043c\u044b\u0439 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442.`
        : `The course topic "${fallbackTopic}" describes key work actions and expected outcomes.`
    }
  ];
}

function pickDistinctDistractors(pool, correct, index, ru) {
  const source = (Array.isArray(pool) ? pool : []).filter((entry) => entry?.statement && entry.statement !== correct.statement);
  const sameTopic = source.filter((entry) => `${entry.topic || ""}`.toLowerCase() === `${correct.topic || ""}`.toLowerCase());
  const otherTopics = source.filter((entry) => `${entry.topic || ""}`.toLowerCase() !== `${correct.topic || ""}`.toLowerCase());
  const ordered = [...otherTopics, ...sameTopic];
  const picked = [];
  const seen = new Set();

  if (ordered.length > 0) {
    const start = (index * 3) % ordered.length;
    for (let offset = 0; offset < ordered.length && picked.length < 3; offset += 1) {
      const candidate = ordered[(start + offset) % ordered.length];
      const statement = cleanNarrativeText(candidate?.statement || "", 170);
      const key = statement.toLowerCase();
      if (!statement || seen.has(key)) {
        continue;
      }
      seen.add(key);
      picked.push(statement);
    }
  }

  while (picked.length < 3) {
    const fallbackPool = ru
      ? [
          "\u0412\u044b\u043f\u043e\u043b\u043d\u0438\u0442\u044c \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0431\u0435\u0437 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u043e\u0432 \u0438 \u0444\u0438\u043a\u0441\u0430\u0446\u0438\u0438 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442\u0430.",
          "\u041f\u0440\u043e\u043f\u0443\u0441\u0442\u0438\u0442\u044c \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u0435 \u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u043e\u0433\u043e \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0430 \u043f\u0440\u0438 \u043e\u0442\u043a\u043b\u043e\u043d\u0435\u043d\u0438\u0438.",
          "\u041e\u0433\u0440\u0430\u043d\u0438\u0447\u0438\u0442\u044c\u0441\u044f \u0443\u0441\u0442\u043d\u044b\u043c \u0441\u043e\u0433\u043b\u0430\u0441\u043e\u0432\u0430\u043d\u0438\u0435\u043c \u0431\u0435\u0437 \u0437\u0430\u043f\u0438\u0441\u0438 \u0432 \u0441\u0438\u0441\u0442\u0435\u043c\u0435."
        ]
      : [
          "Perform the action without document checks or result logging.",
          "Skip notifying the responsible officer about the deviation.",
          "Use only verbal approval without entering records in the system."
        ];
    picked.push(fallbackPool[picked.length % fallbackPool.length]);
  }

  return picked;
}

function deterministicShuffle(values, seed) {
  const items = Array.isArray(values) ? [...values] : [];
  let state = (seed + 1) * 1103515245;
  for (let index = items.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483647;
    const swapIndex = state % (index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function buildKnowledgeQuestion(index, question, context) {
  const pool = context?.knowledge?.length ? context.knowledge : collectQuestionKnowledge([], context?.courseTitle || "Course");
  const ru = Boolean(context?.ru);
  const correct = pool[index % pool.length];
  const distractors = pickDistinctDistractors(pool, correct, index, ru);

  const optionTexts = [correct.statement, ...distractors.slice(0, 3)];
  const options = [];
  const seen = new Set();
  for (const text of optionTexts) {
    const normalized = cleanNarrativeText(text, 170);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      id: createId("option"),
      text: normalized
    });
  }

  while (options.length < 4) {
    options.push({
      id: createId("option"),
      text: ru
        ? `\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u043f\u043e \u0442\u0435\u043c\u0435 "${correct.topic}".`
        : `Additional option for "${correct.topic}".`
    });
  }

  const promptTemplates = ru
    ? [
        `\u0412 \u0440\u0430\u0431\u043e\u0447\u0435\u043c \u043a\u0435\u0439\u0441\u0435 \u043f\u043e \u0442\u0435\u043c\u0435 "${correct.topic}" \u043d\u0443\u0436\u043d\u043e \u0432\u044b\u0431\u0440\u0430\u0442\u044c \u0432\u0435\u0440\u043d\u043e\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435. \u041a\u0430\u043a\u043e\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u043a\u043e\u0440\u0440\u0435\u043a\u0442\u0435\u043d?`,
        `\u041a\u0430\u043a\u043e\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u0442\u043e\u0447\u043d\u043e \u0441\u043e\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0443\u0435\u0442 \u0442\u0440\u0435\u0431\u043e\u0432\u0430\u043d\u0438\u044f\u043c \u043f\u043e \u0442\u0435\u043c\u0435 "${correct.topic}"?`,
        `\u041a\u0430\u043a\u043e\u0439 \u043f\u0440\u0430\u043a\u0442\u0438\u0447\u0435\u0441\u043a\u0438\u0439 \u0432\u044b\u0432\u043e\u0434 \u0438\u0437 \u0442\u0435\u043c\u044b "${correct.topic}" \u0431\u0443\u0434\u0435\u0442 \u0432\u0435\u0440\u043d\u044b\u043c \u0434\u043b\u044f \u0441\u043e\u0442\u0440\u0443\u0434\u043d\u0438\u043a\u0430?`,
        `\u0412\u044b \u043f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u0442\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0435 \u043f\u0440\u043e\u0446\u0435\u0441\u0441\u0430 "${correct.topic}". \u041a\u0430\u043a\u043e\u0435 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0435 \u0432\u0435\u0440\u043d\u043e?`
      ]
    : [
        `In a work scenario on "${correct.topic}", which action is correct?`,
        `Which option fully matches the requirement in "${correct.topic}"?`,
        `What practical takeaway from "${correct.topic}" is valid?`,
        `You are reviewing execution for "${correct.topic}". Which statement is correct?`
      ];

  const shuffledOptions = deterministicShuffle(options, index);
  const correctOption = shuffledOptions.find((option) => option.text === options[0].text) || shuffledOptions[0];
  const prompt = cleanNarrativeText(promptTemplates[index % promptTemplates.length], 240);
  const sourceSnippet = truncateAtBoundary(correct.statement, 150);

  return {
    id: `${question?.id || createId("question")}`,
    prompt,
    options: shuffledOptions,
    correctOptionId: correctOption.id,
    explanation: cleanNarrativeText(
      question?.explanation || (ru
        ? `\u041f\u0440\u0430\u0432\u0438\u043b\u044c\u043d\u044b\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442\u0441\u044f \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u0435\u043c \u0442\u0435\u043c\u044b "${correct.topic}": ${sourceSnippet}`
        : `The correct option is supported by "${correct.topic}": ${sourceSnippet}`),
      240
    )
  };
}
function normalizeQuestion(question, index, context) {
  if (context?.forceKnowledgeQuestions) {
    return buildKnowledgeQuestion(index, question, context);
  }

  const prompt = cleanNarrativeText(question?.prompt || "", 240);
  const sourceOptions = Array.isArray(question?.options) ? question.options : [];
  const rawOptions = sourceOptions
    .map((option, optionIndex) => ({
      id: `${option?.id || createId("option")}`,
      text: cleanNarrativeText(option?.text || option, 160) || `Option ${optionIndex + 1}`
    }))
    .filter((option) => option.text);

  const genericPrompt = isTemplatePrompt(prompt);
  const genericOptions = rawOptions.length < 4 || rawOptions.filter((option) => isTemplateOption(option.text)).length >= 2;
  if (genericPrompt || genericOptions) {
    return buildKnowledgeQuestion(index, question, context);
  }

  const options = [];
  const seen = new Set();
  for (const option of rawOptions) {
    const key = option.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push(option);
  }

  while (options.length < 4) {
    options.push({
      id: createId("option"),
      text: isRuText(context?.courseTitle) ? "\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u043e\u0442\u0432\u0435\u0442\u0430." : "Additional answer option."
    });
  }

  const knownOptionIds = new Set(options.map((option) => option.id));
  const correctOptionId = knownOptionIds.has(question?.correctOptionId)
    ? question.correctOptionId
    : options[0].id;

  return {
    id: `${question?.id || createId("question")}`,
    prompt,
    options,
    correctOptionId,
    explanation: cleanNarrativeText(question?.explanation || "", 240)
      || (isRuText(context?.courseTitle)
        ? "\u041f\u0440\u0430\u0432\u0438\u043b\u044c\u043d\u044b\u0439 \u043e\u0442\u0432\u0435\u0442 \u0441\u043e\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0443\u0435\u0442 \u0441\u043e\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u044e \u043a\u0443\u0440\u0441\u0430."
        : "The correct answer matches the course content.")
  };
}

function normalizeScreens(modules, audience, courseTitle) {
  for (const moduleItem of modules) {
    const sections = Array.isArray(moduleItem?.sections) ? moduleItem.sections : [];
    for (const section of sections) {
      const scos = Array.isArray(section?.scos) ? section.scos : [];
      for (const sco of scos) {
        const screens = Array.isArray(sco?.screens) ? sco.screens : [];
        for (let screenIndex = 0; screenIndex < screens.length; screenIndex += 1) {
          const screen = screens[screenIndex];
          const phase = screenIndex === 0
            ? "intro"
            : (screenIndex === screens.length - 1 ? "outro" : "core");

          const blocks = (Array.isArray(screen?.blocks) ? [...screen.blocks] : []).filter((block) => block?.type !== "note");
          const textIndex = getBlockIndex(blocks, "text");
          const listIndex = getBlockIndex(blocks, "list");
          const textSource = textIndex >= 0
            ? `${blocks[textIndex]?.text || ""}`
            : blocks
              .map((block) => {
                if (block?.type === "text") {
                  return `${block?.text || ""}`;
                }
                if (block?.type === "list" && Array.isArray(block?.items)) {
                  return block.items.join(". ");
                }
                return "";
              })
              .filter(Boolean)
              .join(" ");

          const title = cleanNarrativeText(screen?.title || "Screen", 120) || "Screen";
          const bulletTopic = isPlaceholderTitle(title)
            ? (cleanNarrativeText(courseTitle || "", 120) || title)
            : title;
          const listSeed = listIndex >= 0 && Array.isArray(blocks[listIndex]?.items)
            ? blocks[listIndex].items.join(". ")
            : textSource;
          const bullets = buildBullets(listSeed, bulletTopic);

          const normalizedText = ensureScreenTextDepth({
            text: textSource,
            bullets,
            title,
            audience,
            phase,
            courseTitle
          });

          ensureTextBlock(blocks, normalizedText);
          ensureListBlock(blocks, bullets);

          screen.title = title;
          screen.blocks = blocks;
        }
      }
    }
  }
}

export function postprocessGeneratedCourse(course, input) {
  const structured = rebuildCourseStructure(course, input?.structure || {});

  structured.title = cleanNarrativeText(structured.title || input?.titleHint || "Course", 160) || (input?.titleHint || "Course");
  structured.description = cleanNarrativeText(
    structured.description
      || `Auto-generated course for audience "${input?.audience || "learners"}".`,
    460
  );

  normalizeHierarchyTitles(structured.modules || [], structured.title || input?.titleHint || "Course");
  normalizeScreens(structured.modules || [], input?.audience || "learners", structured.title || input?.titleHint || "Course");

  const desiredQuestions = Math.max(0, Math.trunc(Number(input?.finalTest?.questionCount) || 0));
  const sourceQuestions = Array.isArray(structured?.finalTest?.questions) ? structured.finalTest.questions : [];
  const questionContext = {
    courseTitle: structured.title || input?.titleHint || "Course",
    ru: isRuText(structured.title || input?.titleHint || ""),
    knowledge: collectQuestionKnowledge(structured.modules || [], structured.title || input?.titleHint || "Course"),
    forceKnowledgeQuestions: true
  };
  const questions = Array.from({ length: desiredQuestions }, (_, questionIndex) =>
    normalizeQuestion(sourceQuestions[questionIndex], questionIndex, questionContext)
  );

  structured.finalTest = {
    ...(structured.finalTest || {}),
    id: `${structured?.finalTest?.id || createId("final_test")}`,
    enabled: Boolean(input?.finalTest?.enabled),
    title: cleanNarrativeText(structured?.finalTest?.title || "Final test", 120) || "Final test",
    questionCount: desiredQuestions,
    passingScore: Number(input?.finalTest?.passingScore) || 70,
    attemptsLimit: Number(input?.finalTest?.attemptsLimit) || 1,
    maxTimeMinutes: Number(input?.finalTest?.maxTimeMinutes) || 20,
    questions
  };

  return structured;
}
