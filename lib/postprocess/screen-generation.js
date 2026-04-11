import { 
  cleanNarrativeText, 
  sentencePool, 
  truncateAtBoundary, 
  normalizeText,
  isRuText,
  isKkText 
} from "./text-utils.js";
import { isPlaceholderTitle } from "./hierarchy-normalization.js";
import { 
  placeholderLike, 
  looksCorruptedNarrative, 
  looksTechnicalNoise 
} from "./quality-check.js";

export function normalizeScreens(modules, audience, courseTitle) {
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

          const blocks = (Array.isArray(screen?.blocks) ? [...screen.blocks] : [])
            .filter((block) => block?.type !== "note" && block?.type !== "image");
          
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

const MIN_SCREEN_TEXT_LENGTH = 180;
const MIN_SCREEN_TEXT_WORDS = 28;
const MIN_SCREEN_SENTENCES = 2;

export function buildBullets(seedText, fallbackTitle) {
  const fromText = sentencePool(seedText)
    .slice(0, 3)
    .map((item) => truncateAtBoundary(item, 140))
    .filter((item) => !placeholderLike(item))
    .filter((item) => !looksCorruptedNarrative(item))
    .filter((item) => !looksTechnicalNoise(item));
  const kk = isKkText(`${seedText || ""} ${fallbackTitle || ""}`);
  const ru = !kk && /[\u0400-\u04FF]/.test(`${seedText || ""} ${fallbackTitle || ""}`);

  const fallback = kk
    ? [
        `${fallbackTitle} тақырыбының негізгі идеясы`,
        `${fallbackTitle} тақырыбын практикалық қолдану`,
        `${fallbackTitle} бойынша нәтижені тексеру`
      ]
    : ru
    ? [
        `Ключевая идея по теме ${fallbackTitle}`,
        `Как применить ${fallbackTitle} в рабочей задаче`,
        `Какой результат проверить после изучения ${fallbackTitle}`
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
    const pointIndex = merged.length + 1;
    merged.push(kk
      ? `${pointIndex}-негізгі тезис: ${fallbackTitle}`
      : ru
      ? `Key takeaway ${pointIndex}: ${fallbackTitle}`
      : `Key point ${pointIndex} for ${fallbackTitle}`);
  }

  return merged;
}

export function buildScreenNarrative({ text, bullets, title, audience, phase, courseTitle }) {
  const kk = isKkText(`${text || ""} ${title || ""} ${audience || ""} ${courseTitle || ""}`);
  const ru = !kk && /[\u0400-\u04FF]/.test(`${text || ""} ${title || ""} ${audience || ""} ${courseTitle || ""}`);
  const safeTitle = cleanNarrativeText(title || (kk ? "Тақырып" : ru ? "Тема" : "Topic"), 96) || (kk ? "Тақырып" : ru ? "Тема" : "Topic");
  const safeAudience = cleanNarrativeText(audience || (kk ? "тыңдаушылар" : ru ? "слушатели" : "learners"), 96) || (kk ? "тыңдаушылар" : ru ? "слушатели" : "learners");
  const safeCourseTitle = cleanNarrativeText(courseTitle || "", 120);
  
  const isPlaceholderTitle = (val) => /^(screen|topic|module|section|sco)\b/i.test(val)
    || /^\u044d\u043a\u0440\u0430\u043d\b/i.test(val)
    || /\b\d+(?:\.\d+){0,5}\b/.test(val);

  const genericTitle = /^(?:current|generic)\s+topic$/i.test(safeTitle)
    || /^(?:\u0442\u0435\u043a\u0443\u0449\u0430\u044f|\u043e\u0431\u0449\u0430\u044f)\s+\u0442\u0435\u043c\u0430$/i.test(safeTitle);
  const titleForNarrative = isPlaceholderTitle(safeTitle) || genericTitle
    ? (safeCourseTitle || (kk ? "курс тақырыбы" : ru ? "тема курса" : "course topic"))
    : safeTitle;

  const seedSentences = sentencePool(text)
    .filter((item) => !placeholderLike(item))
    .slice(0, 3);
  const sourceLine = seedSentences[0] || "";
  const variantSeed = `${titleForNarrative}|${phase}|${safeAudience}`;
  const variant = [...variantSeed].reduce((acc, char) => (acc * 33 + char.charCodeAt(0)) % 1024, 7) % 3;
  
  const contextTemplatesKk = [
    `"${titleForNarrative}" тақырыбын "${safeAudience}" аудиториясының міндеттеріне сәйкес қарастырамыз.`,
    `Бұл қадамның мақсаты — "${titleForNarrative}" тақырыбының "${safeAudience}" күнделікті жұмысында қалай қолданылатынын түсіну.`,
    `Экранның фокусы: "${titleForNarrative}". Төменде — "${safeAudience}" үшін негізгі шешімдер мен мысалдар.`
  ];
  const contextTemplatesRu = [
    `Разбираем тему "${titleForNarrative}" в привязке к задачам аудитории "${safeAudience}".`,
    `Цель этого шага — понять, как "${titleForNarrative}" применяется в ежедневной работе "${safeAudience}".`,
    `Фокус экрана: "${titleForNarrative}". Ниже — ключевые решения и примеры для "${safeAudience}".`
  ];
  const contextTemplatesEn = [
    `This part explains "${titleForNarrative}" for ${safeAudience} with practical context.`,
    `The goal here is to apply "${titleForNarrative}" to a real ${safeAudience} workflow.`,
    `This step explains "${titleForNarrative}" with practical decisions and examples for ${safeAudience}.`
  ];
  const contextLine = kk ? contextTemplatesKk[variant] : ru ? contextTemplatesRu[variant] : contextTemplatesEn[variant];

  const detailItems = (Array.isArray(bullets) ? bullets : [])
    .map((item) => cleanNarrativeText(item, 120))
    .filter(Boolean)
    .filter((item) => !placeholderLike(item))
    .slice(0, 3);
  while (detailItems.length < 3) {
    detailItems.push(
      kk
        ? `${titleForNarrative} тақырыбы бойынша негізгі идея`
        : ru
        ? `Ключевая идея по теме ${titleForNarrative}`
        : `Key point for ${titleForNarrative}`
    );
  }

  const bodySource = sourceLine
    ? (kk ? `Контекст: ${sourceLine}.` : ru ? `Контекст: ${sourceLine}.` : `Context: ${sourceLine}.`)
    : (kk ? `Негізгі ой: ${detailItems[0]}.` : ru ? `Опорная мысль: ${detailItems[0]}.` : `Anchor idea: ${detailItems[0]}.`);
  const detailLine = kk
    ? `Негізгі тезистер: 1) ${detailItems[0]}; 2) ${detailItems[1]}; 3) ${detailItems[2]}.`
    : ru
    ? `Ключевые тезисы: 1) ${detailItems[0]}; 2) ${detailItems[1]}; 3) ${detailItems[2]}.`
    : `Main takeaways: 1) ${detailItems[0]}; 2) ${detailItems[1]}; 3) ${detailItems[2]}.`;

  const actionLine = phase === "outro"
    ? (kk
      ? `Қорытындылау: "${titleForNarrative}" тақырыбы бойынша "${safeAudience}" үшін қысқа білім тексеру парағын жасаңыз.`
      : ru
      ? `В итоге составьте короткий чек-лист проверки знаний по теме "${titleForNarrative}" для "${safeAudience}" и зафиксируйте критерий успеха.`
      : `Finish by creating a short knowledge-check for "${titleForNarrative}" for ${safeAudience} with one clear success criterion.`)
    : (kk
      ? `Тәжірибе: "${titleForNarrative}" тақырыбын бірден қолдану қажет болатын бір жұмыс жағдайын таңдаңыз және орындау қадамдарын сипаттаңыз.`
      : ru
      ? `Практика: выберите одну рабочую ситуацию, где "${titleForNarrative}" нужно применить сразу, и опишите шаги выполнения.`
      : `Practice: pick one real task where "${titleForNarrative}" must be applied immediately and outline the execution steps.`);

  return cleanNarrativeText([contextLine, bodySource, detailLine, actionLine].join("\n\n"), 980);
}

export function isLowQualityScreenText(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return true;
  }
  if (placeholderLike(normalized) || looksCorruptedNarrative(normalized)) {
    return true;
  }

  const sentences = sentencePool(normalized);
  const words = normalized.split(/\s+/).filter(Boolean).length;
  return normalized.length < MIN_SCREEN_TEXT_LENGTH
    || words < MIN_SCREEN_TEXT_WORDS
    || sentences.length < MIN_SCREEN_SENTENCES;
}

export function ensureScreenTextDepth({ text, bullets, title, audience, phase, courseTitle }) {
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

  const ru = isRuText(`${title || ""} ${courseTitle || ""} ${audience || ""}`);
  const extraLine = ru
    ? `Проверка усвоения: отметьте, какие два действия из экрана вы внедрите в ближайшей рабочей задаче.`
    : "Adoption check: list two actions from this screen that you will apply in your next work task.";
  return cleanNarrativeText(`${rebuilt}\n\n${extraLine}`, 980);
}

export function getBlockIndex(blocks, type) {
  return blocks.findIndex((block) => block?.type === type);
}

export function ensureTextBlock(blocks, text) {
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

export function ensureListBlock(blocks, items) {
  const index = getBlockIndex(blocks, "list");
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => cleanNarrativeText(item, 140))
    .filter(Boolean)
    .filter((item, itemIndex, list) => list.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === itemIndex)
    .slice(0, 3);

  if (!normalizedItems.length) {
    if (index >= 0) {
      blocks.splice(index, 1);
    }
    return;
  }

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

export function buildInlineScreenIllustration(title, courseTitle) {
  const safeTitle = cleanNarrativeText(title || "Screen", 64) || "Screen";
  const safeCourse = cleanNarrativeText(courseTitle || "Course", 64) || "Course";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700" role="img" aria-label="${safeTitle}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f4f7a"/>
      <stop offset="100%" stop-color="#36a57e"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="700" fill="url(#bg)"/>
  <rect x="56" y="56" width="1088" height="588" rx="28" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.28)"/>
  <text x="96" y="170" fill="#ffffff" font-family="Arial, sans-serif" font-size="52" font-weight="700">${safeTitle}</text>
  <text x="96" y="236" fill="#eaf6ff" font-family="Arial, sans-serif" font-size="32">${safeCourse}</text>
  <circle cx="1000" cy="170" r="76" fill="rgba(255,255,255,0.18)"/>
  <circle cx="1060" cy="300" r="44" fill="rgba(255,255,255,0.15)"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function ensureImageBlock(blocks, title, courseTitle) {
  const imageIndex = getBlockIndex(blocks, "image");
  if (imageIndex >= 0 && blocks[imageIndex]?.src) {
    return;
  }

  blocks.push({
    type: "image",
    src: buildInlineScreenIllustration(title, courseTitle),
    alt: cleanNarrativeText(title || "Screen illustration", 96) || "Screen illustration"
  });
}
