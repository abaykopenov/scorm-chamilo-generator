import test from "node:test";
import assert from "node:assert/strict";
import { generateCourseDraft } from "../lib/course-generator.js";

test("generateCourseDraft deep v4 creates long grounded screens and test with screenRefs", async () => {
  const course = await generateCourseDraft({
    titleHint: "Operational onboarding",
    audience: "New employees",
    learningGoals: ["Understand controls"],
    durationMinutes: 30,
    contentDepthMode: "deep",
    agentTopology: "v4",
    evidenceMode: "per-screen",
    structure: {
      moduleCount: 1,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 1
    },
    finalTest: {
      enabled: true,
      questionCount: 1,
      passingScore: 80,
      attemptsLimit: 1,
      maxTimeMinutes: 20
    },
    generation: {
      provider: "template"
    },
    rag: {
      enabled: false,
      documentIds: [],
      topK: 4
    }
  });

  const screen = course.modules[0].sections[0].scos[0].screens[0];
  const question = course.finalTest.questions[0];

  assert.equal(course.contentDepthMode, "deep");
  assert.equal(course.agentTopology, "v4");
  assert.equal(course.evidenceMode, "per-screen");

  assert.ok(typeof screen.bodyLong === "string" && screen.bodyLong.length >= 900);
  assert.ok(Array.isArray(screen.evidence) && screen.evidence.length >= 1);
  assert.ok(Array.isArray(screen.keyTakeaways) && screen.keyTakeaways.length >= 1);
  assert.ok(typeof screen.practicalStep === "string" && screen.practicalStep.length > 20);
  assert.ok(Array.isArray(screen.blocks) && screen.blocks.some((block) => block.type === "note"));

  assert.ok(question);
  assert.ok(Array.isArray(question.screenRefs));
  assert.ok(question.screenRefs.length >= 1);
});