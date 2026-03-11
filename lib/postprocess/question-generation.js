import { createId } from "../ids.js";
import { 
  cleanNarrativeText, 
  sentencePool, 
  truncateAtBoundary, 
  isRuText 
} from "./text-utils.js";
import { 
  looksCorruptedNarrative, 
  looksTechnicalNoise, 
  isTemplatePrompt, 
  isTemplateOption 
} from "./quality-check.js";
import { isPlaceholderTitle } from "./hierarchy-normalization.js";

export function collectQuestionKnowledge(modules, courseTitle) {
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
            const cleanedSentence = cleanNarrativeText(sentence, 170);
            if (!cleanedSentence || looksCorruptedNarrative(cleanedSentence) || looksTechnicalNoise(cleanedSentence)) {
              continue;
            }
            entries.push({
              topic: topic || fallbackTopic,
              statement: cleanedSentence
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
        ? `Тема курса "${fallbackTopic}" описывает ключевые рабочие действия и ожидаемый результат.`
        : `The course topic "${fallbackTopic}" describes key work actions and expected outcomes.`
    }
  ];
}

export function pickDistinctDistractors(pool, correct, index, ru) {
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
          "Выполнить действие без проверки документов и фиксации результата.",
          "Пропустить уведомление ответственного сотрудника при отклонении.",
          "Ограничиться устным согласованием без записи в системе."
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

export function deterministicShuffle(values, seed) {
  const items = Array.isArray(values) ? [...values] : [];
  let state = (seed + 1) * 1103515245;
  for (let index = items.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483647;
    const swapIndex = state % (index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

export function buildKnowledgeQuestion(index, question, context) {
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
        ? `Дополнительный вариант по теме "${correct.topic}".`
        : `Additional option for "${correct.topic}".`
    });
  }

  const promptTemplates = ru
    ? [
        `В рабочем кейсе по теме "${correct.topic}" нужно выбрать верное действие. Какой вариант корректен?`,
        `Какой вариант точно соответствует требованиям по теме "${correct.topic}"?`,
        `Какой практический вывод из темы "${correct.topic}" будет верным для сотрудника?`,
        `Вы проверяете выполнение процесса "${correct.topic}". Какое утверждение верно?`
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
        ? `Правильный вариант подтверждается содержанием темы "${correct.topic}": ${sourceSnippet}`
        : `The correct option is supported by "${correct.topic}": ${sourceSnippet}`),
      240
    )
  };
}

export function normalizeQuestion(question, index, context) {
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
      text: isRuText(context?.courseTitle) ? "Дополнительный вариант ответа." : "Additional answer option."
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
        ? "Правильный ответ соответствует содержанию курса."
        : "The correct answer matches the course content.")
  };
}
