import { useState, useCallback } from "react";
import { resolveErrorMessage } from "../utils";

export function useGeneration(initialHistory = []) {
  const [generationHistory, setGenerationHistory] = useState(
    Array.isArray(initialHistory) ? initialHistory : []
  );
  const [generationProgress, setGenerationProgress] = useState({
    active: false,
    percent: 0,
    stage: "",
    message: ""
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(true);
  const [hideCompletedHistory, setHideCompletedHistory] = useState(false);
  const [moduleStreamState, setModuleStreamState] = useState({
    courseId: "",
    completedModules: 0,
    totalModules: 0,
    lastModuleTitle: ""
  });
  const [outlineEditorVisible, setOutlineEditorVisible] = useState(false);
  const [generatedOutlineContent, setGeneratedOutlineContent] = useState(null);
  const [generationPayloadCache, setGenerationPayloadCache] = useState(null);

  const upsertHistoryEntry = useCallback((entry) => {
    if (!entry?.id) return;
    setGenerationHistory((current) => {
      const next = [entry, ...current.filter((item) => item?.id !== entry.id)];
      next.sort((left, right) => {
        const leftTs = new Date(left?.updatedAt || 0).getTime() || 0;
        const rightTs = new Date(right?.updatedAt || 0).getTime() || 0;
        return rightTs - leftTs;
      });
      return next.slice(0, 30);
    });
  }, []);

  const refreshGenerationHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/courses?limit=30");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Failed to load generation history.");
      setGenerationHistory(Array.isArray(payload?.courses) ? payload.courses : []);
    } catch (historyError) {
      // Return error for handling in component
      throw historyError;
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  return {
    generationHistory,
    setGenerationHistory,
    generationProgress,
    setGenerationProgress,
    historyLoading,
    setHistoryLoading,
    historyVisible,
    setHistoryVisible,
    hideCompletedHistory,
    setHideCompletedHistory,
    moduleStreamState,
    setModuleStreamState,
    outlineEditorVisible,
    setOutlineEditorVisible,
    generatedOutlineContent,
    setGeneratedOutlineContent,
    generationPayloadCache,
    setGenerationPayloadCache,
    upsertHistoryEntry,
    refreshGenerationHistory
  };
}
