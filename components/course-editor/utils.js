export function deepClone(value) {
  return structuredClone(value);
}

export function toSafeInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function parseChamiloBaseUrl(baseUrl) {
  if (!baseUrl) {
    return {
      protocol: "http",
      host: ""
    };
  }

  try {
    const parsed = new URL(baseUrl);
    return {
      protocol: parsed.protocol.replace(":", "") || "http",
      host: `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "")
    };
  } catch {
    return {
      protocol: "http",
      host: baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    };
  }
}

export function buildChamiloBaseUrl(protocol, host) {
  const cleanHost = `${host || ""}`.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!cleanHost) {
    return "";
  }
  return `${protocol || "http"}://${cleanHost}`;
}

export function formatDateTime(value) {
  if (!value) {
    return "еще не проверялось";
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function summarize(course) {
  const sections = course.modules.reduce((total, moduleItem) => total + moduleItem.sections.length, 0);
  const scos = course.modules.reduce(
    (total, moduleItem) => total + moduleItem.sections.reduce((sectionTotal, sectionItem) => sectionTotal + sectionItem.scos.length, 0),
    0
  );
  const screens = course.modules.reduce(
    (total, moduleItem) =>
      total +
      moduleItem.sections.reduce(
        (sectionTotal, sectionItem) => sectionTotal + sectionItem.scos.reduce((scoTotal, sco) => scoTotal + sco.screens.length, 0),
        0
      ),
    0
  );

  return { sections, scos: scos + (course.finalTest?.enabled ? 1 : 0), screens };
}

export function ensureQuestionCount(course, desiredCount) {
  const draft = deepClone(course);
  const safeCount = toSafeInt(desiredCount, draft.finalTest.questionCount, 0, 100);
  draft.finalTest.questionCount = safeCount;

  while (draft.finalTest.questions.length < safeCount) {
    const nextIndex = draft.finalTest.questions.length + 1;
    draft.finalTest.questions.push({
      id: `question_client_${nextIndex}`,
      prompt: `Контрольный вопрос ${nextIndex}`,
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        id: `option_client_${nextIndex}_${optionIndex + 1}`,
        text: `Вариант ${optionIndex + 1}`
      })),
      correctOptionId: `option_client_${nextIndex}_1`,
      explanation: ""
    });
  }

  draft.finalTest.questions.length = safeCount;
  return draft;
}

export function createChamiloState(course) {
  const parsedBaseUrl = parseChamiloBaseUrl(course.integrations?.chamilo?.baseUrl || "");
  return {
    baseUrl: course.integrations?.chamilo?.baseUrl || "",
    protocol: parsedBaseUrl.protocol,
    host: parsedBaseUrl.host,
    username: course.integrations?.chamilo?.username || "",
    password: "",
    courseCode: course.integrations?.chamilo?.courseCode || "",
    lastConnectionStatus: course.integrations?.chamilo?.lastConnectionStatus || "unknown",
    lastConnectionMessage: course.integrations?.chamilo?.lastConnectionMessage || "",
    lastConnectedAt: course.integrations?.chamilo?.lastConnectedAt || "",
    courses: []
  };
}
