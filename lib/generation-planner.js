function plannerLog(event, payload = {}) {
  const raw = `${process.env.COURSE_PLANNER_VERBOSE_LOGS ?? "1"}`.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) {
    return;
  }
  console.log(`[planner] ${event}`, payload);
}

function normalizeText(value) {
  return `${value || ""}`.replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoFacts(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => sentence.replace(/^[-*]\s+/, "").trim())
    .filter((sentence) => sentence.length >= 45)
    .map((sentence) => sentence.slice(0, 220));
}

function screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex) {
  return `m${moduleIndex + 1}:s${sectionIndex + 1}:c${scoIndex + 1}:p${screenIndex + 1}`;
}

function buildSlots(input) {
  const moduleCount = Math.max(1, Math.trunc(Number(input?.structure?.moduleCount) || 1));
  const sectionsPerModule = Math.max(1, Math.trunc(Number(input?.structure?.sectionsPerModule) || 1));
  const scosPerSection = Math.max(1, Math.trunc(Number(input?.structure?.scosPerSection) || 1));
  const screensPerSco = Math.max(1, Math.trunc(Number(input?.structure?.screensPerSco) || 1));
  const goals = Array.isArray(input?.learningGoals) ? input.learningGoals.filter(Boolean) : [];

  const slots = [];
  for (let moduleIndex = 0; moduleIndex < moduleCount; moduleIndex += 1) {
    for (let sectionIndex = 0; sectionIndex < sectionsPerModule; sectionIndex += 1) {
      for (let scoIndex = 0; scoIndex < scosPerSection; scoIndex += 1) {
        for (let screenIndex = 0; screenIndex < screensPerSco; screenIndex += 1) {
          slots.push({
            id: screenSlotId(moduleIndex, sectionIndex, scoIndex, screenIndex),
            moduleIndex,
            sectionIndex,
            scoIndex,
            screenIndex,
            goal: goals.length > 0 ? goals[(moduleIndex + sectionIndex + scoIndex + screenIndex) % goals.length] : "",
            label: `${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}.${screenIndex + 1}`
          });
        }
      }
    }
  }
  return slots;
}

function buildFacts(ragContext) {
  const chunks = Array.isArray(ragContext?.chunks) ? ragContext.chunks : [];
  const seen = new Set();
  const facts = [];

  for (const chunk of chunks) {
    const chunkText = `${chunk?.text || ""}`;
    const chunkFacts = splitIntoFacts(chunkText);

    if (chunkFacts.length === 0) {
      const fallback = normalizeText(chunkText).slice(0, 220);
      if (fallback.length >= 45) {
        chunkFacts.push(fallback);
      }
    }

    for (const factText of chunkFacts) {
      const key = normalizeKey(factText);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      facts.push({
        id: `fact_${facts.length + 1}`,
        text: factText,
        key,
        materialId: `${chunk?.materialId || ""}`,
        chunkId: `${chunk?.chunkId || ""}`,
        chunkOrder: Number(chunk?.chunkOrder) || 0,
        source: chunk?.fileName || chunk?.materialId || "source",
        score: Number(chunk?.score) || 0
      });
    }
  }

  return facts;
}

function assignFactsToSlots(facts, slots, options = {}) {
  const factsPerSlot = Math.max(2, Math.min(4, Math.trunc(Number(options?.factsPerSlot) || 3)));
  const usage = new Map();
  const assignments = [];
  const recentWindow = [];
  const recentWindowSize = 2;

  for (const slot of slots) {
    const scored = facts
      .map((fact, index) => {
        const used = usage.get(fact.id) || 0;
        const inRecent = recentWindow.some((set) => set.has(fact.id));
        const scopeBoost = (fact.chunkOrder % 7) / 10;
        const score = (fact.score || 0) + scopeBoost - (used * 0.9) - (inRecent ? 1.7 : 0);
        return { fact, score, index };
      })
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.index - b.index;
      });

    const selected = [];
    for (const candidate of scored) {
      if (selected.length >= factsPerSlot) {
        break;
      }
      const already = selected.some((item) => item.id === candidate.fact.id);
      if (already) {
        continue;
      }
      selected.push(candidate.fact);
    }

    while (selected.length < factsPerSlot && facts.length > 0) {
      selected.push(facts[selected.length % facts.length]);
    }

    const set = new Set();
    for (const fact of selected) {
      set.add(fact.id);
      usage.set(fact.id, (usage.get(fact.id) || 0) + 1);
    }
    recentWindow.push(set);
    while (recentWindow.length > recentWindowSize) {
      recentWindow.shift();
    }

    assignments.push({
      slotId: slot.id,
      factIds: selected.map((fact) => fact.id)
    });
  }

  return { assignments, factsPerSlot };
}

function buildFactMap(facts) {
  return new Map(facts.map((fact) => [fact.id, fact]));
}

function buildAssignmentMap(assignments) {
  return new Map(assignments.map((item) => [item.slotId, item.factIds]));
}

function toContextChunksFromFacts(facts, prefix, targetChunks = 8) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return [];
  }

  const chunkCount = Math.max(1, Math.min(targetChunks, Math.ceil(facts.length / 3)));
  const perChunk = Math.max(2, Math.ceil(facts.length / chunkCount));
  const chunks = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * perChunk;
    const selected = facts.slice(start, start + perChunk);
    if (selected.length === 0) {
      continue;
    }
    chunks.push({
      materialId: `${prefix}_material`,
      fileName: `${prefix}.planner`,
      score: 1 - (index * 0.01),
      chunkId: `${prefix}_chunk_${index + 1}`,
      chunkOrder: index + 1,
      text: selected.map((fact) => fact.text).join(" ")
    });
  }

  return chunks;
}

function buildScreenPlanHints(slots, assignmentMap, factMap) {
  return slots.map((slot) => {
    const factIds = assignmentMap.get(slot.id) || [];
    const factTexts = factIds
      .map((id) => factMap.get(id)?.text || "")
      .filter(Boolean)
      .slice(0, 3);

    return {
      slotId: slot.id,
      label: slot.label,
      module: slot.moduleIndex + 1,
      section: slot.sectionIndex + 1,
      sco: slot.scoIndex + 1,
      screen: slot.screenIndex + 1,
      objective: slot.goal || `????? ?????? ${slot.label}`,
      keyFacts: factTexts
    };
  });
}

function uniqueById(items) {
  const map = new Map();
  for (const item of items) {
    if (!item || !item.id) {
      continue;
    }
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  }
  return [...map.values()];
}

export function createGenerationPlan(input, ragContext, options = {}) {
  const slots = buildSlots(input);
  const facts = buildFacts(ragContext);
  const { assignments, factsPerSlot } = assignFactsToSlots(facts, slots, options);
  const assignmentMap = buildAssignmentMap(assignments);
  const factMap = buildFactMap(facts);

  const assignedFactIds = assignments.flatMap((item) => item.factIds);
  const uniqueAssigned = new Set(assignedFactIds);
  const coverageRatio = assignedFactIds.length > 0
    ? Number((uniqueAssigned.size / assignedFactIds.length).toFixed(4))
    : 0;

  const screenPlanHints = buildScreenPlanHints(slots, assignmentMap, factMap);

  const plan = {
    createdAt: new Date().toISOString(),
    slots,
    facts,
    assignments,
    factsPerSlot,
    screenPlanHints,
    diagnostics: {
      slotCount: slots.length,
      factCount: facts.length,
      assignedFactCount: assignedFactIds.length,
      uniqueAssignedFactCount: uniqueAssigned.size,
      coverageRatio
    }
  };

  plannerLog("start", {
    slotCount: slots.length,
    chunkCount: Array.isArray(ragContext?.chunks) ? ragContext.chunks.length : 0
  });
  plannerLog("fact_pool", {
    factCount: facts.length,
    factsPerSlot,
    minRecommendedFacts: slots.length * 2
  });
  plannerLog("slot_assign", {
    assignedFactCount: assignedFactIds.length,
    uniqueAssignedFactCount: uniqueAssigned.size
  });
  plannerLog("coverage", plan.diagnostics);

  return plan;
}

export function getPlanSlotFacts(plan, slotId) {
  const facts = Array.isArray(plan?.facts) ? plan.facts : [];
  const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];
  const assignment = assignments.find((item) => item.slotId === slotId);
  if (!assignment) {
    return [];
  }
  const factMap = buildFactMap(facts);
  return assignment.factIds
    .map((id) => factMap.get(id))
    .filter(Boolean);
}

export function createPlannerScopedRagContext(plan, baseRagContext, scope) {
  const slots = Array.isArray(plan?.slots) ? plan.slots : [];
  const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];
  const facts = Array.isArray(plan?.facts) ? plan.facts : [];
  if (slots.length === 0 || assignments.length === 0 || facts.length === 0) {
    return baseRagContext;
  }

  const assignmentMap = buildAssignmentMap(assignments);
  const factMap = buildFactMap(facts);

  const scopedSlots = slots.filter((slot) => {
    if (scope?.moduleIndex != null && slot.moduleIndex !== scope.moduleIndex) {
      return false;
    }
    if (scope?.sectionIndex != null && slot.sectionIndex !== scope.sectionIndex) {
      return false;
    }
    if (scope?.scoIndex != null && slot.scoIndex !== scope.scoIndex) {
      return false;
    }
    return true;
  });

  const scopedFacts = [];
  for (const slot of scopedSlots) {
    const ids = assignmentMap.get(slot.id) || [];
    for (const id of ids) {
      const fact = factMap.get(id);
      if (fact) {
        scopedFacts.push(fact);
      }
    }
  }

  const uniqueFacts = uniqueById(scopedFacts);
  const hasModule = Number.isFinite(scope?.moduleIndex);
  const hasSection = Number.isFinite(scope?.sectionIndex);
  const hasSco = Number.isFinite(scope?.scoIndex);

  const prefix = hasSco
    ? `m${scope.moduleIndex + 1}s${scope.sectionIndex + 1}c${scope.scoIndex + 1}`
    : (hasSection
      ? `m${scope.moduleIndex + 1}s${scope.sectionIndex + 1}`
      : (hasModule ? `m${scope.moduleIndex + 1}` : "global"));

  const chunks = toContextChunksFromFacts(uniqueFacts, prefix, 10);
  const screenPlanHints = buildScreenPlanHints(scopedSlots, assignmentMap, factMap);

  return {
    ...baseRagContext,
    topK: Math.max(baseRagContext?.topK || 0, chunks.length),
    chunks: chunks.length > 0 ? chunks : (Array.isArray(baseRagContext?.chunks) ? baseRagContext.chunks : []),
    screenPlanHints,
    plannerScope: {
      ...scope,
      slotCount: scopedSlots.length,
      factCount: uniqueFacts.length
    }
  };
}

export function buildPlannerScopedCourseFacts(plan) {
  const slots = Array.isArray(plan?.slots) ? plan.slots : [];
  const assignmentMap = buildAssignmentMap(Array.isArray(plan?.assignments) ? plan.assignments : []);
  const factMap = buildFactMap(Array.isArray(plan?.facts) ? plan.facts : []);
  const result = new Map();

  for (const slot of slots) {
    const ids = assignmentMap.get(slot.id) || [];
    const facts = ids.map((id) => factMap.get(id)).filter(Boolean);
    if (facts.length > 0) {
      result.set(slot.id, facts);
    }
  }

  return result;
}

export { screenSlotId };

