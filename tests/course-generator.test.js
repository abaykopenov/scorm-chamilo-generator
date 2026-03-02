import test from "node:test";
import assert from "node:assert/strict";
import { generateCourseDraft } from "../lib/course-generator.js";
import { rebuildCourseStructure } from "../lib/structure-engine.js";

test("generateCourseDraft respects requested structure and test settings", async () => {
  const course = await generateCourseDraft({
    titleHint: "Охрана труда",
    audience: "Производственный персонал",
    learningGoals: ["Знать регламент", "Снижать риски"],
    durationMinutes: 60,
    structure: {
      moduleCount: 3,
      sectionsPerModule: 2,
      scosPerSection: 2,
      screensPerSco: 4
    },
    finalTest: {
      enabled: true,
      questionCount: 9,
      passingScore: 85,
      attemptsLimit: 2,
      maxTimeMinutes: 20
    }
  });

  assert.equal(course.modules.length, 3);
  assert.equal(course.modules[0].sections.length, 2);
  assert.equal(course.modules[0].sections[0].scos.length, 2);
  assert.equal(course.modules[0].sections[0].scos[0].screens.length, 4);
  assert.equal(course.finalTest.questionCount, 9);
  assert.equal(course.finalTest.passingScore, 85);
  assert.equal(course.finalTest.attemptsLimit, 2);
  assert.equal(course.finalTest.maxTimeMinutes, 20);
});

test("rebuildCourseStructure keeps overlapping content while resizing tree", async () => {
  const course = await generateCourseDraft({
    titleHint: "Техника безопасности",
    audience: "Новые сотрудники",
    learningGoals: ["Соблюдать порядок"],
    durationMinutes: 30,
    structure: {
      moduleCount: 1,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      enabled: true,
      questionCount: 3,
      passingScore: 70,
      attemptsLimit: 1,
      maxTimeMinutes: 15
    }
  });

  course.modules[0].sections[0].scos[0].screens[0].blocks[0].text = "Сохраненный текст";

  const rebuilt = rebuildCourseStructure(course, {
    moduleCount: 2,
    sectionsPerModule: 2,
    scosPerSection: 2,
    screensPerSco: 2
  });

  assert.equal(rebuilt.modules.length, 2);
  assert.equal(rebuilt.modules[0].sections[0].scos[0].screens[0].blocks[0].text, "Сохраненный текст");
  assert.equal(rebuilt.modules[1].sections.length, 2);
  assert.equal(rebuilt.modules[1].sections[1].scos[1].screens.length, 2);
});
