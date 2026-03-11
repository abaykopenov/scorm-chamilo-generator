import { useState, useMemo, useCallback } from "react";
import { 
  deepClone, 
  toSafeInt, 
  summarize, 
  ensureQuestionCount, 
  createChamiloState, 
  buildChamiloBaseUrl,
  parseChamiloBaseUrl
} from "../utils";

export function useEditorState(initialCourse) {
  const [course, setCourse] = useState(initialCourse);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState(null);
  const [exportAsXapi, setExportAsXapi] = useState(false);
  const [publishResult, setPublishResult] = useState(null);
  const [testPublishResult, setTestPublishResult] = useState(null);
  const [regenerationTarget, setRegenerationTarget] = useState("");
  const [structure, setStructure] = useState({
    moduleCount: initialCourse.modules.length,
    sectionsPerModule: initialCourse.modules[0]?.sections.length || 1,
    scosPerSection: initialCourse.modules[0]?.sections[0]?.scos.length || 1,
    screensPerSco: initialCourse.modules[0]?.sections[0]?.scos[0]?.screens.length || 1
  });
  const [chamilo, setChamilo] = useState(createChamiloState(initialCourse));
  const summary = useMemo(() => summarize(course), [course]);

  const updateCourse = useCallback((mutator) => {
    setCourse((current) => {
      const draft = deepClone(current);
      mutator(draft);
      return draft;
    });
  }, []);

  const updateStructureField = useCallback((key, value) => {
    setStructure((current) => ({ ...current, [key]: toSafeInt(value, current[key], 1, 20) }));
  }, []);

  const updateChamiloField = useCallback((key, value) => {
    const nextState = (() => {
      if (key === "host" || key === "protocol") {
        return {
          ...chamilo,
          [key]: value,
          baseUrl: buildChamiloBaseUrl(key === "protocol" ? value : chamilo.protocol, key === "host" ? value : chamilo.host)
        };
      }
      return { ...chamilo, [key]: value };
    })();

    setChamilo(nextState);
    if (key === "password") return;

    updateCourse((draft) => {
      draft.integrations ||= {};
      draft.integrations.chamilo ||= {};
      if (key === "host" || key === "protocol") {
        draft.integrations.chamilo.baseUrl = nextState.baseUrl;
        return;
      }
      if (key === "courses") return;
      draft.integrations.chamilo[key] = value;
    });
  }, [chamilo, updateCourse]);

  const syncChamiloStateFromProfile = useCallback((profile, availableCourses = null) => {
    const parsedBaseUrl = parseChamiloBaseUrl(profile.baseUrl || "");
    setChamilo((current) => {
      const baseCourses = Array.isArray(availableCourses) ? availableCourses : current.courses;
      const selectedCode = `${profile?.courseCode || current.courseCode || ""}`.trim();
      const hasSelected = selectedCode
        ? baseCourses.some((courseOption) => `${courseOption?.code || ""}`.trim() === selectedCode)
        : true;
      const nextCourses = hasSelected
        ? baseCourses
        : [{ code: selectedCode, title: `Manual course code (${selectedCode})`, url: profile.baseUrl || current.baseUrl || "" }, ...baseCourses];

      return {
        ...current,
        ...profile,
        protocol: parsedBaseUrl.protocol,
        host: parsedBaseUrl.host,
        courses: nextCourses,
        password: current.password
      };
    });

    updateCourse((draft) => {
      draft.integrations ||= {};
      draft.integrations.chamilo = {
        ...(draft.integrations.chamilo || {}),
        ...profile
      };
    });
  }, [updateCourse]);

  return {
    course,
    setCourse,
    message,
    setMessage,
    error,
    setError,
    exportResult,
    setExportResult,
    exportAsXapi,
    setExportAsXapi,
    publishResult,
    setPublishResult,
    testPublishResult,
    setTestPublishResult,
    regenerationTarget,
    setRegenerationTarget,
    structure,
    setStructure,
    chamilo,
    setChamilo,
    summary,
    updateCourse,
    updateStructureField,
    updateChamiloField,
    syncChamiloStateFromProfile
  };
}
