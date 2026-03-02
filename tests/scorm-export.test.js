import test from "node:test";
import assert from "node:assert/strict";
import { generateCourseDraft } from "../lib/course-generator.js";
import { buildScormPackage } from "../lib/scorm/package-builder.js";

test("buildScormPackage emits manifest, assets and SCO html files", async () => {
  const course = await generateCourseDraft({
    titleHint: "Chamilo SCORM",
    audience: "Методисты",
    learningGoals: ["Понять упаковку"],
    durationMinutes: 20,
    structure: {
      moduleCount: 2,
      sectionsPerModule: 1,
      scosPerSection: 2,
      screensPerSco: 2
    },
    finalTest: {
      enabled: true,
      questionCount: 5,
      passingScore: 80,
      attemptsLimit: 1,
      maxTimeMinutes: 10
    }
  });

  const packageResult = buildScormPackage(course);
  const fileNames = packageResult.files.map((file) => file.name);

  assert.ok(packageResult.manifest.includes("<manifest"));
  assert.ok(packageResult.manifest.includes(course.finalTest.id));
  assert.ok(fileNames.includes("imsmanifest.xml"));
  assert.ok(fileNames.includes("assets/runtime.js"));
  assert.ok(fileNames.includes(`sco/${course.finalTest.id}.html`));
  assert.equal(packageResult.buffer.slice(0, 4).toString("binary"), "PK\u0003\u0004");
});
