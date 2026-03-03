import { createDefaultChamiloSettings } from "./course-defaults.js";
import { createId } from "./ids.js";
import { buildCourseFromOutline, createOutlineFromLocalLlm } from "./local-llm.js";
import { normalizeGenerateInput } from "./validation.js";

function pickGoal(goals, index) {
  if (goals.length === 0) {
    return "Освоить ключевые идеи курса";
  }
  return goals[index % goals.length];
}

function buildBlocks({ moduleIndex, sectionIndex, scoIndex, screenIndex, goal, audience }) {
  const label = `${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
  return [
    {
      type: "text",
      text: `Экран ${label} раскрывает цель "${goal}" для аудитории "${audience}".`
    },
    {
      type: "note",
      text: `Сфокусируйтесь на том, как тема применяется в реальной рабочей ситуации.`
    },
    {
      type: "list",
      items: [
        `Ключевая идея ${label}`,
        `Практический сценарий ${label}`,
        `Мини-вывод для закрепления ${label}`
      ]
    }
  ];
}

function buildQuestion(courseTitle, goal, index) {
  const questionId = createId("question");
  const options = [
    `Фокусируется на цели "${goal}" и применении в работе`,
    `Игнорирует цель и оставляет тему без сценариев`,
    `Переносит решение на внешнюю систему без обучения`,
    `Не требует никакой оценки результата`
  ].map((text) => ({ id: createId("option"), text }));

  return {
    id: questionId,
    prompt: `Что лучше всего отражает изучение темы "${courseTitle}" в вопросе ${index + 1}?`,
    options,
    correctOptionId: options[0].id,
    explanation: `Правильный ответ связан с практическим достижением цели "${goal}".`
  };
}

function buildTemplateDraft(payload) {
  const input = normalizeGenerateInput(payload);

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => ({
    id: createId("module"),
    title: `Модуль ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
    order: moduleIndex + 1,
    sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
      id: createId("section"),
      title: `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`,
      order: sectionIndex + 1,
      scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
        id: createId("sco"),
        title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
        order: scoIndex + 1,
        screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => ({
          id: createId("screen"),
          title: `Экран ${screenIndex + 1}`,
          order: screenIndex + 1,
          blocks: buildBlocks({
            moduleIndex,
            sectionIndex,
            scoIndex,
            screenIndex,
            goal: pickGoal(input.learningGoals, moduleIndex + sectionIndex + scoIndex + screenIndex),
            audience: input.audience
          })
        }))
      }))
    }))
  }));

  const finalTest = {
    id: createId("final_test"),
    enabled: input.finalTest.enabled,
    title: "Итоговый тест",
    questionCount: input.finalTest.questionCount,
    passingScore: input.finalTest.passingScore,
    attemptsLimit: input.finalTest.attemptsLimit,
    maxTimeMinutes: input.finalTest.maxTimeMinutes,
    questions: Array.from({ length: input.finalTest.questionCount }, (_, index) =>
      buildQuestion(input.titleHint, pickGoal(input.learningGoals, index), index)
    )
  };

  return {
    id: createId("course"),
    title: input.titleHint,
    description: `Автоматически созданный курс для аудитории "${input.audience}". Длительность: около ${input.durationMinutes} минут.`,
    language: input.language,
    generation: input.generation,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest
  };
}

export async function generateCourseDraft(payload) {
  const input = normalizeGenerateInput(payload);
  const fileChunks = payload._fileChunks || payload.fileChunks || [];
  console.log(`[Generate] Provider: ${input.generation.provider}, Model: ${input.generation.model}, URL: ${input.generation.baseUrl}`);
  if (fileChunks.length > 0) {
    console.log(`[Generate] 📁 File chunks: ${fileChunks.length}`);
  }

  const outline = await createOutlineFromLocalLlm(input, fileChunks);

  if (outline) {
    console.log(`[Generate] ✅ LLM outline received: ${outline.modules?.length || 0} modules, ${outline.finalTest?.questions?.length || 0} questions`);
    const course = buildCourseFromOutline(input, outline);
    // Save generation config in course for regeneration
    course._generationConfig = {
      provider: input.generation.provider,
      baseUrl: input.generation.baseUrl,
      model: input.generation.model,
      temperature: input.generation.temperature,
      maxTokens: input.generation.maxTokens
    };
    return course;
  }

  console.log("[Generate] ⚠️ LLM returned null, using template draft");
  return buildTemplateDraft(payload);
}
