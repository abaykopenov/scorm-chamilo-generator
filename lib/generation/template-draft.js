import { createDefaultChamiloSettings } from "../course-defaults.js";
import { createId } from "../ids.js";
import { normalizeGenerateInput } from "../validation.js";

export function pickGoal(goals, index) {
  if (goals.length === 0) {
    return "Master key course ideas";
  }
  return goals[index % goals.length];
}

export function buildBlocks({ moduleIndex, sectionIndex, scoIndex, screenIndex, goal, audience }) {
  const label = `Topic ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`;
  return [
    {
      type: "text",
      text: `Screen ${label} explains the goal "${goal}" for audience "${audience}".`
    },
    {
      type: "list",
      items: [
        `Core idea ${label}`,
        `Practical scenario ${label}`,
        `Actionable takeaway ${label}`
      ]
    }
  ];
}

export function buildQuestion(courseTitle, goal, index) {
  const questionId = createId("question");
  const options = [
    `Focuses on the goal "${goal}" and practical execution`,
    "Ignores the goal and skips practical context",
    "Moves the decision outside the workflow without training",
    "Does not require any measurable outcome"
  ].map((text) => ({ id: createId("option"), text }));

  return {
    id: questionId,
    prompt: `Which statement matches course materials for question ${index + 1}?`,
    options,
    correctOptionId: options[0].id,
    explanation: `The correct option aligns with the goal "${goal}" and expected work outcome.`
  };
}

export function buildTemplateDraft(payload) {
  const input = normalizeGenerateInput(payload);

  const modules = Array.from({ length: input.structure.moduleCount }, (_, moduleIndex) => ({
    id: createId("module"),
    title: `Module ${moduleIndex + 1}: ${pickGoal(input.learningGoals, moduleIndex)}`,
    order: moduleIndex + 1,
    sections: Array.from({ length: input.structure.sectionsPerModule }, (_, sectionIndex) => ({
      id: createId("section"),
      title: `Section ${moduleIndex + 1}.${sectionIndex + 1}`,
      order: sectionIndex + 1,
      scos: Array.from({ length: input.structure.scosPerSection }, (_, scoIndex) => ({
        id: createId("sco"),
        title: `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`,
        order: scoIndex + 1,
        screens: Array.from({ length: input.structure.screensPerSco }, (_, screenIndex) => ({
          id: createId("screen"),
          title: `Screen ${screenIndex + 1}`,
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
    title: "Final test",
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
    description: `Auto-generated course for audience "${input.audience}". Estimated duration: ${input.durationMinutes} minutes.`,
    language: input.language,
    generation: input.generation,
    rag: input.rag,
    integrations: {
      chamilo: createDefaultChamiloSettings()
    },
    modules,
    finalTest
  };
}
