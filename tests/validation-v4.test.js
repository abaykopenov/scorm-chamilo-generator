import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCoursePayload, normalizeGenerateInput } from "../lib/validation.js";

test("normalizeGenerateInput applies deep v4 defaults and moduleCount=2 when structure not provided", () => {
  const input = normalizeGenerateInput({
    titleHint: "Test"
  });

  assert.equal(input.contentDepthMode, "deep");
  assert.equal(input.agentTopology, "v4");
  assert.equal(input.evidenceMode, "per-screen");
  assert.equal(input.generationDefaults.moduleCountDefault, 2);
  assert.equal(input.structure.moduleCount, 2);
});

test("normalizeCoursePayload keeps deep screen evidence fields and question screenRefs", () => {
  const course = normalizeCoursePayload({
    id: "course_1",
    title: "Course",
    contentDepthMode: "deep",
    agentTopology: "v4",
    evidenceMode: "per-screen",
    generationDefaults: { moduleCountDefault: 2 },
    modules: [
      {
        title: "M1",
        sections: [
          {
            title: "S1",
            scos: [
              {
                title: "C1",
                screens: [
                  {
                    title: "Screen 1",
                    bodyLong: "Long text",
                    keyTakeaways: ["A", "B"],
                    practicalStep: "Do step",
                    evidence: [
                      {
                        factId: "fact_1",
                        source: "doc.pdf",
                        materialId: "m1",
                        chunkId: "c1",
                        excerpt: "Evidence excerpt"
                      }
                    ],
                    blocks: [{ type: "text", text: "Long text" }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    finalTest: {
      enabled: true,
      questionCount: 1,
      questions: [
        {
          prompt: "Q1",
          options: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }],
          correctOptionId: "o1",
          explanation: "E",
          screenRefs: ["screen_1"]
        }
      ]
    }
  });

  const screen = course.modules[0].sections[0].scos[0].screens[0];
  const question = course.finalTest.questions[0];

  assert.equal(course.contentDepthMode, "deep");
  assert.equal(course.agentTopology, "v4");
  assert.equal(course.evidenceMode, "per-screen");
  assert.equal(screen.bodyLong, "Long text");
  assert.equal(screen.evidence.length, 1);
  assert.deepEqual(question.screenRefs, ["screen_1"]);
});