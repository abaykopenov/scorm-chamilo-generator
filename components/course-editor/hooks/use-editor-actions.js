import { useCallback } from "react";
import { syncChamiloStateFromProfile } from "../utils";

export function useEditorActions({
  course,
  setCourse,
  setMessage,
  setError,
  setExportResult,
  exportAsXapi,
  setPublishResult,
  setTestPublishResult,
  setRegenerationTarget,
  chamilo,
  setChamilo,
  structure,
  syncChamiloStateFromProfile,
  startTransition
}) {
  const saveCourse = useCallback(() => {
    setError("");
    setMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(`/api/courses/${course.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(course)
        });

        if (!response.ok) {
          setError("Не удалось сохранить курс.");
          return;
        }

        const saved = await response.json();
        setCourse(saved);
        setMessage("Курс сохранен.");
      } catch (err) {
        setError("Ошибка сети при сохранении.");
      }
    });
  }, [course, startTransition, setCourse, setMessage, setError]);

  const rebuildStructure = useCallback(() => {
    setError("");
    setMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(`/api/courses/${course.id}/rebuild-structure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ structure })
        });

        if (!response.ok) {
          setError("Не удалось перестроить структуру.");
          return;
        }

        const rebuilt = await response.json();
        setCourse(rebuilt);
        setMessage("Структура обновлена.");
      } catch (err) {
        setError("Ошибка сети при обновлении структуры.");
      }
    });
  }, [course.id, structure, startTransition, setCourse, setMessage, setError]);

  const regenerateModule = useCallback(async (moduleIndex) => {
    setError("");
    setMessage("");
    setRegenerationTarget("module:" + moduleIndex);

    try {
      const response = await fetch(`/api/courses/${course.id}/regenerate-module`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleIndex })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to regenerate module.");
      }

      setCourse(payload);
      setMessage("Module " + (moduleIndex + 1) + " regenerated.");
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : "Failed to regenerate module.");
    } finally {
      setRegenerationTarget("");
    }
  }, [course.id, setCourse, setMessage, setError, setRegenerationTarget]);

  const regenerateScreen = useCallback(async (moduleIndex, sectionIndex, scoIndex, screenIndex) => {
    setError("");
    setMessage("");
    const target = ["screen", moduleIndex, sectionIndex, scoIndex, screenIndex].join(":");
    setRegenerationTarget(target);

    try {
      const response = await fetch(`/api/courses/${course.id}/regenerate-screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleIndex, sectionIndex, scoIndex, screenIndex })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error || "Failed to regenerate screen.");
      }

      setCourse(payload);
      setMessage("Screen " + (screenIndex + 1) + " regenerated.");
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : "Failed to regenerate screen.");
    } finally {
      setRegenerationTarget("");
    }
  }, [course.id, setCourse, setMessage, setError, setRegenerationTarget]);

  const exportScorm = useCallback(() => {
    setError("");
    setMessage("");
    setExportResult(null);

    startTransition(async () => {
      try {
        const endpoint = exportAsXapi 
          ? `/api/courses/${course.id}/export-xapi` 
          : `/api/courses/${course.id}/export-scorm`;

        const response = await fetch(endpoint, { method: "POST" });

        if (!response.ok) {
          setError(exportAsXapi ? "Не удалось собрать xAPI-пакет." : "Не удалось собрать SCORM-пакет.");
          return;
        }

        const exported = await response.json();
        setExportResult(exported);
        setMessage((exportAsXapi ? "xAPI" : "SCORM") + "-пакет собран локально. Он не отправлен в LMS, пока вы не нажмете публикацию.");
      } catch (err) {
        setError("Ошибка сети при экспорте.");
      }
    });
  }, [course.id, exportAsXapi, startTransition, setMessage, setError, setExportResult]);

  const publishToChamilo = useCallback(() => {
    setError("");
    setMessage("");
    setPublishResult(null);
    setTestPublishResult(null);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/courses/${course.id}/publish-chamilo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: chamilo })
        });

        const payload = await response.json();
        if (!response.ok) {
          if (payload.published) setPublishResult(payload.published);
          setError(payload.error || "Failed to publish package to Chamilo.");
          return;
        }

        setExportResult({
          exportId: payload.exportId,
          downloadUrl: payload.downloadUrl,
          manifestValid: payload.manifestValid,
          scoCount: payload.scoCount
        });
        setPublishResult(payload.published);
        
        const exerciseMessage = payload.exercise
          ? (payload.exercise.ok
              ? ` Native test created (exerciseId=${payload.exercise.exerciseId}, questions=${payload.exercise.questionCount}).`
              : ` Native test was not created: ${payload.exercise.message || "unknown reason"}.`)
          : "";
        
        setMessage(payload.published.ok
          ? `${payload.published.message ? `SCORM package uploaded to Chamilo. ${payload.published.message}` : "SCORM package uploaded to Chamilo."}${exerciseMessage}`
          : (payload.published.message || "Chamilo did not confirm successful import."));
      } catch (err) {
        setError("Ошибка сети при публикации.");
      }
    });
  }, [course.id, chamilo, startTransition, setMessage, setError, setPublishResult, setTestPublishResult, setExportResult]);

  const publishTestToChamilo = useCallback(() => {
    setError("");
    setMessage("");
    setTestPublishResult(null);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/courses/${course.id}/publish-chamilo-test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: chamilo })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setTestPublishResult(payload);
          setError(payload.error || "Failed to upload test to Chamilo.");
          return;
        }

        setTestPublishResult(payload);
        const exerciseId = payload?.exercise?.exerciseId;
        const questionCount = payload?.exercise?.questionCount;
        const lpStatus = payload?.lpLinked?.ok
          ? "Exercise linked to learning path."
          : (payload?.lpLinked?.error ? `Learning path link failed: ${payload.lpLinked.error}` : "Learning path link was skipped.");
        
        setMessage(`Native test uploaded to Chamilo (exerciseId=${exerciseId || "n/a"}${Number.isFinite(questionCount) ? `, questions=${questionCount}` : ""}). ${lpStatus}`);
      } catch (err) {
        setError("Ошибка сети при загрузке теста.");
      }
    });
  }, [course.id, chamilo, startTransition, setMessage, setError, setTestPublishResult]);

  const connectChamilo = useCallback(() => {
    setError("");
    setMessage("");
    setPublishResult(null);
    setTestPublishResult(null);

    startTransition(async () => {
      try {
        const response = await fetch(`/api/courses/${course.id}/connect-chamilo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: chamilo })
        });

        const payload = await response.json();
        if (!response.ok) {
          if (payload.profile) {
            syncChamiloStateFromProfile(payload.profile, []);
          }
          setError(payload.error || "Не удалось подключиться к Chamilo.");
          return;
        }

        syncChamiloStateFromProfile(payload.profile, payload.courses || []);
        setMessage(payload.courses?.length
          ? `Подключение к Chamilo подтверждено. Найдено курсов: ${payload.courses.length}.`
          : "Подключение к Chamilo подтверждено, но список курсов не найден.");
      } catch (err) {
        setError("Ошибка сети при подключении.");
      }
    });
  }, [course.id, chamilo, startTransition, setMessage, setError, setPublishResult, setTestPublishResult, syncChamiloStateFromProfile]);

  return {
    saveCourse,
    rebuildStructure,
    regenerateModule,
    regenerateScreen,
    exportScorm,
    publishToChamilo,
    publishTestToChamilo,
    connectChamilo
  };
}
