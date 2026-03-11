import { createId } from "./ids.js";
import { rebuildCourseStructure } from "./structure-engine.js";
import { cleanNarrativeText, isRuText } from "./postprocess/text-utils.js";
import { normalizeHierarchyTitles } from "./postprocess/hierarchy-normalization.js";
import { normalizeScreens } from "./postprocess/screen-generation.js";
import { 
  collectQuestionKnowledge, 
  normalizeQuestion 
} from "./postprocess/question-generation.js";

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
