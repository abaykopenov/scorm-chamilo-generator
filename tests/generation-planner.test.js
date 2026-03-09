import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationPlan, createPlannerScopedRagContext, screenSlotId } from "../lib/generation-planner.js";

test("createGenerationPlan assigns facts to every screen slot", () => {
  const input = {
    learningGoals: ["Goal A", "Goal B"],
    structure: {
      moduleCount: 2,
      sectionsPerModule: 1,
      scosPerSection: 1,
      screensPerSco: 2
    }
  };

  const ragContext = {
    chunks: [
      {
        materialId: "m1",
        chunkId: "c1",
        chunkOrder: 1,
        score: 0.9,
        text: "Fact one explains a concrete onboarding control process in enough detail for assignment. Fact two gives practical compliance steps and expected observable outcomes."
      },
      {
        materialId: "m1",
        chunkId: "c2",
        chunkOrder: 2,
        score: 0.8,
        text: "Fact three describes role responsibilities and escalation rules with clear boundaries. Fact four captures operational checkpoints and reporting cadence for daily work."
      }
    ]
  };

  const plan = createGenerationPlan(input, ragContext, { factsPerSlot: 2 });
  assert.equal(plan.slots.length, 4);
  assert.equal(plan.assignments.length, 4);
  for (const assignment of plan.assignments) {
    assert.ok(Array.isArray(assignment.factIds));
    assert.ok(assignment.factIds.length >= 1);
  }
});

test("createPlannerScopedRagContext returns scoped hints for section", () => {
  const input = {
    learningGoals: ["Goal A", "Goal B"],
    structure: {
      moduleCount: 1,
      sectionsPerModule: 2,
      scosPerSection: 1,
      screensPerSco: 1
    }
  };

  const ragContext = {
    topK: 6,
    chunks: [
      { materialId: "m1", chunkId: "c1", chunkOrder: 1, score: 0.9, fileName: "doc", text: "First section fact. Another fact for section one." },
      { materialId: "m1", chunkId: "c2", chunkOrder: 2, score: 0.8, fileName: "doc", text: "Second section fact. Additional detail for section two." }
    ]
  };

  const plan = createGenerationPlan(input, ragContext, { factsPerSlot: 2 });
  const scoped = createPlannerScopedRagContext(plan, ragContext, { moduleIndex: 0, sectionIndex: 1 });

  assert.ok(Array.isArray(scoped.chunks));
  assert.ok(scoped.chunks.length >= 1);
  assert.ok(Array.isArray(scoped.screenPlanHints));
  assert.ok(scoped.screenPlanHints.length >= 1);
  const expectedSlot = screenSlotId(0, 1, 0, 0);
  assert.ok(scoped.screenPlanHints.some((hint) => hint.slotId === expectedSlot));
});
