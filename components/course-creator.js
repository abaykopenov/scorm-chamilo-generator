"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDefaultGenerateInput } from "@/lib/course-defaults";
import { OutlineEditor } from "@/components/outline-editor";

import { useCourseForm } from "./course-creator/hooks/use-course-form";
import { useMaterials } from "./course-creator/hooks/use-materials";
import { useGeneration } from "./course-creator/hooks/use-generation";
import { 
  toSafeNumber, 
  parseStreamEvent, 
  resolveErrorMessage 
} from "./course-creator/utils";
import { 
  MAX_UPLOAD_FILES, 
  MAX_UPLOAD_FILE_SIZE, 
  MAX_UPLOAD_FILE_SIZE_MB,
  GENERATION_STAGE_LABELS
} from "./course-creator/constants";

import { MaterialsSection } from "./course-creator/MaterialsSection";
import { LlmSection } from "./course-creator/LlmSection";
import { StructureSection } from "./course-creator/StructureSection";
import { TestSection } from "./course-creator/TestSection";
import { HistorySection } from "./course-creator/HistorySection";
import { ProgressSection } from "./course-creator/ProgressSection";
import { ModuleStatus } from "./course-creator/ModuleStatus";

export function CourseCreator({ initialHistory = [] }) {
  const router = useRouter();
  const defaults = createDefaultGenerateInput();
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef(null);
  const [error, setError] = useState("");
  const [llmStatus, setLlmStatus] = useState(null);

  const {
    form,
    updateField,
    getGenerationPayload
  } = useCourseForm(defaults);

  const {
    materials,
    selectedMaterialIds,
    setSelectedMaterialIds,
    selectedFiles,
    setSelectedFiles,
    expandedMaterialId,
    setExpandedMaterialId,
    materialChunksState,
    setMaterialChunksState,
    materialsMessage,
    setMaterialsMessage,
    qdrantStatus,
    refreshMaterials,
    checkQdrantStatus,
    loadMaterialChunks,
    toggleMaterialChunks,
    toggleMaterialSelection
  } = useMaterials(defaults.rag.documentIds);

  const {
    generationHistory,
    generationProgress,
    setGenerationProgress,
    historyLoading,
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
  } = useGeneration(initialHistory);

  useEffect(() => {
    refreshMaterials().catch(() => setMaterialsMessage("Failed to load materials list."));
    checkQdrantStatus();
    refreshGenerationHistory().catch((historyError) => {
      setError(current => current || resolveErrorMessage(historyError, "Failed to load generation history."));
    });
  }, [refreshMaterials, checkQdrantStatus, refreshGenerationHistory, setMaterialsMessage]);

  function onFilesPicked(event) {
    const pickedFiles = Array.from(event.target.files || []);
    let nextFiles = pickedFiles;
    const notices = [];

    if (nextFiles.length > MAX_UPLOAD_FILES) {
      nextFiles = nextFiles.slice(0, MAX_UPLOAD_FILES);
      notices.push(`You can select up to ${MAX_UPLOAD_FILES} files at once.`);
    }

    const oversized = nextFiles.filter((file) => file.size > MAX_UPLOAD_FILE_SIZE);
    if (oversized.length > 0) {
      const skippedNames = oversized.slice(0, 3).map((file) => file.name).join(", ");
      const extra = oversized.length > 3 ? " and more" : "";
      notices.push(`Skipped files larger than ${MAX_UPLOAD_FILE_SIZE_MB} MB: ${skippedNames}${extra}.`);
      nextFiles = nextFiles.filter((file) => file.size <= MAX_UPLOAD_FILE_SIZE);
    }

    setSelectedFiles(nextFiles);
    setMaterialsMessage(notices.join(" "));
  }

  function deleteMaterialById(materialId) {
    const material = materials.find((item) => item.id === materialId);
    const label = material?.fileName || materialId;
    if (!window.confirm(`Удалить материал "${label}"?`)) return;

    setMaterialsMessage("");
    startTransition(async () => {
      try {
        const response = await fetch(`/api/materials/${materialId}`, { method: "DELETE" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMaterialsMessage(payload?.message || "Не удалось удалить материал.");
          return;
        }

        setSelectedMaterialIds((current) => current.filter((id) => id !== materialId));
        setMaterialChunksState((current) => {
          const next = { ...current };
          delete next[materialId];
          return next;
        });
        setExpandedMaterialId((current) => (current === materialId ? "" : current));
        await refreshMaterials();
        setMaterialsMessage(`Материал "${label}" удален.`);
      } catch (error) {
        setMaterialsMessage(resolveErrorMessage(error, "Ошибка сети при удалении материала."));
      }
    });
  }

  function uploadSelectedFiles() {
    if (selectedFiles.length === 0) {
      setMaterialsMessage("Select at least one file.");
      return;
    }
    setError("");
    setMaterialsMessage("");

    startTransition(async () => {
      try {
        const uploadedIds = [];
        for (const file of selectedFiles) {
          const formData = new FormData();
          formData.set("file", file);
          const response = await fetch("/api/materials/upload", { method: "POST", body: formData });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            setMaterialsMessage(payload?.message || `Ошибка загрузки: ${file.name}`);
            return;
          }
          uploadedIds.push(payload?.material?.id);
        }

        await refreshMaterials();
        setSelectedMaterialIds((current) => [
          ...current,
          ...uploadedIds.filter(Boolean).filter((id) => !current.includes(id))
        ]);
        setSelectedFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setMaterialsMessage(`Загружено файлов: ${uploadedIds.length}.`);
      } catch (error) {
        setMaterialsMessage(resolveErrorMessage(error, "Ошибка сети при загрузке файлов."));
      }
    });
  }

  function indexSelectedMaterials() {
    if (selectedMaterialIds.length === 0) {
      setMaterialsMessage("Выберите материалы для индексации.");
      return;
    }
    setError("");
    setMaterialsMessage("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/materials/index", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentIds: selectedMaterialIds,
            generation: {
              provider: form.generationProvider,
              baseUrl: form.generationBaseUrl,
              model: form.generationModel,
              temperature: toSafeNumber(form.generationTemperature, defaults.generation.temperature, 0, 1)
            },
            embedding: {
              provider: form.embeddingProvider,
              baseUrl: form.embeddingBaseUrl,
              model: form.embeddingModel
            }
          })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMaterialsMessage(payload?.message || "Индексация не удалась.");
          return;
        }

        await refreshMaterials();
        const qdrantMode = payload?.qdrant?.connected ? "connected" : "fallback";
        setMaterialsMessage(`Indexing completed. Success: ${payload.indexed ?? 0}, failed: ${payload.failed ?? 0}. Qdrant: ${qdrantMode}.`);
        await checkQdrantStatus();
      } catch (error) {
        setMaterialsMessage(resolveErrorMessage(error, "Ошибка сети при индексации."));
      }
    });
  }

  function checkLocalLlm() {
    setError("");
    setLlmStatus(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/local-llm/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            generation: {
              provider: form.generationProvider,
              baseUrl: form.generationBaseUrl,
              model: form.generationModel,
              temperature: toSafeNumber(form.generationTemperature, defaults.generation.temperature, 0, 1)
            }
          })
        });
        const payload = await response.json();
        setLlmStatus(payload);
        if (!response.ok) setError(payload.message || "Не удалось проверить локальную LLM.");
      } catch (error) {
        setError(resolveErrorMessage(error, "Ошибка сети при проверке LLM."));
      }
    });
  }

  function validatePreGeneration() {
    const strictRagEnabled = Boolean(form.ragEnabled) && selectedMaterialIds.length > 0;
    if (strictRagEnabled) {
      const selected = materials.filter((item) => selectedMaterialIds.includes(item.id));
      const notIndexed = selected.filter((item) => item.status !== "indexed");
      if (notIndexed.length > 0) {
        setError("Please index selected materials first. Not ready: " + notIndexed.slice(0, 3).map((item) => item.fileName).join(", ") + (notIndexed.length > 3 ? "..." : ""));
        return false;
      }
    }
    return true;
  }

  async function handleGenerateOutlineOnly(event) {
    event.preventDefault();
    setError("");
    if (!validatePreGeneration()) return;

    setGenerationProgress({ active: true, percent: 10, stage: "llm-outline", message: "Generating interactive course structure..." });
    try {
      const payload = getGenerationPayload(selectedMaterialIds);
      const response = await fetch("/api/courses/generate-outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || "Failed to generate outline.");
      setGeneratedOutlineContent(data);
      setGenerationPayloadCache(payload);
      setOutlineEditorVisible(true);
      setGenerationProgress({ active: false, percent: 0, stage: "", message: "" });
    } catch (error) {
      setError(resolveErrorMessage(error, "Network error during outline generation."));
      setGenerationProgress({ active: false, percent: 0, stage: "", message: "" });
    }
  }

  async function handleGenerateContentFromOutline(editedOutline) {
    setOutlineEditorVisible(false);
    setError("");
    setGenerationProgress({ active: true, percent: 25, stage: "request", message: "Starting content generation pipeline..." });

    try {
      const response = await fetch("/api/courses/generate-content?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: generationPayloadCache,
          outline: editedOutline,
          ragContext: generatedOutlineContent.ragContext,
          plannerPlan: generatedOutlineContent.plannerPlan
        })
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.message || "Failed to generate content.");
      if (!response.body) throw new Error("Generation stream is unavailable.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let generatedCourse = null;

      const applyEvent = (streamEvent) => {
        if (!streamEvent || typeof streamEvent !== "object") return;
        if (streamEvent.type === "progress") {
          setGenerationProgress({ active: true, percent: Math.trunc(toSafeNumber(streamEvent.percent, 0, 0, 100)), stage: String(streamEvent.stage || ""), message: String(streamEvent.message || "").trim() || "Generating content..." });
        } else if (streamEvent.type === "error") {
          throw new Error(streamEvent.message || "Failed to generate course content.");
        } else if (streamEvent.type === "completion") {
          generatedCourse = { id: streamEvent.courseId };
          setGenerationProgress({ active: true, percent: 100, stage: "done", message: GENERATION_STAGE_LABELS.done });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) applyEvent(parseStreamEvent(trimmed));
        }
      }
      const tail = (buffer + decoder.decode()).trim();
      if (tail) applyEvent(parseStreamEvent(tail));
      if (!generatedCourse?.id) throw new Error("Content generation finished without a course result.");
      router.push("/courses/" + generatedCourse.id);
    } catch (error) {
      setError(resolveErrorMessage(error, "Network error during content generation."));
      setGenerationProgress({ active: false, percent: 0, stage: "", message: "" });
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    if (!validatePreGeneration()) return;

    setGenerationProgress({ active: true, percent: 0, stage: "request", message: GENERATION_STAGE_LABELS.request });
    setModuleStreamState({ courseId: "", completedModules: 0, totalModules: 0, lastModuleTitle: "" });

    try {
      const response = await fetch("/api/courses/generate?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getGenerationPayload(selectedMaterialIds))
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.message || "Failed to generate course.");
      if (!response.body) throw new Error("Generation stream is unavailable.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let generatedCourse = null;

      const applyEvent = (streamEvent) => {
        if (!streamEvent || typeof streamEvent !== "object") return;
        if (streamEvent.type === "progress") {
          const stage = String(streamEvent.stage || "");
          setGenerationProgress({ active: true, percent: Math.trunc(toSafeNumber(streamEvent.percent, 0, 0, 100)), stage, message: String(streamEvent.message || "").trim() || GENERATION_STAGE_LABELS[stage] || "Course generation" });
        } else if (streamEvent.type === "error") {
          throw new Error(streamEvent.message || "Failed to generate course.");
        } else if (streamEvent.type === "module_ready") {
          const courseId = `${streamEvent.courseId || ""}`.trim();
          const totalModules = toSafeNumber(streamEvent.totalModules, 0, 0, 1000);
          const completedModules = toSafeNumber(streamEvent.completedModules, toSafeNumber(streamEvent.moduleIndex, 0, 0, 1000) + 1, 0, 1000);
          const moduleTitle = `${streamEvent.moduleTitle || ""}`.trim();

          setGenerationProgress((current) => ({
            ...current,
            percent: Math.max(current.percent, totalModules > 0 ? Math.min(95, Math.max(8, Math.round((completedModules / totalModules) * 90))) : current.percent),
            stage: "module_ready",
            message: "Module " + completedModules + "/" + (totalModules || "?") + " is ready" + (moduleTitle ? ": " + moduleTitle : "")
          }));

          setModuleStreamState({ courseId, completedModules, totalModules, lastModuleTitle: moduleTitle });
          if (courseId) {
            upsertHistoryEntry({
              id: courseId,
              title: form.titleHint || "Untitled course",
              description: "",
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              generationStatus: "in_progress",
              completedModules,
              moduleCount: totalModules
            });
          }
        } else if (streamEvent.type === "done") {
          generatedCourse = streamEvent.course || null;
          setGenerationProgress({ active: true, percent: 100, stage: "done", message: GENERATION_STAGE_LABELS.done });
          if (generatedCourse?.id) {
            upsertHistoryEntry({
              id: generatedCourse.id,
              title: generatedCourse.title || form.titleHint || "Untitled course",
              description: generatedCourse.description || "",
              updatedAt: generatedCourse.updatedAt || new Date().toISOString(),
              createdAt: generatedCourse.createdAt || new Date().toISOString(),
              generationStatus: generatedCourse.generationStatus || "completed",
              completedModules: Number(generatedCourse.completedModules || generatedCourse.modules?.length || 0),
              moduleCount: Array.isArray(generatedCourse.modules) ? generatedCourse.modules.length : 0
            });
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) applyEvent(parseStreamEvent(trimmed));
        }
      }
      const tail = (buffer + decoder.decode()).trim();
      if (tail) applyEvent(parseStreamEvent(tail));
      if (!generatedCourse?.id) throw new Error("Generation finished without a course result.");
      router.push("/courses/" + generatedCourse.id);
    } catch (error) {
      setError(resolveErrorMessage(error, "Network error during course generation."));
      setGenerationProgress((current) => ({ ...current, active: false }));
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="titleHint">Тема курса</label>
          <input id="titleHint" value={form.titleHint} onChange={(event) => updateField("titleHint", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="audience">Аудитория</label>
          <input id="audience" value={form.audience} onChange={(event) => updateField("audience", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="language">Язык</label>
          <select id="language" value={form.language} onChange={(event) => updateField("language", event.target.value)}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
            <option value="kk">Қазақша</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="durationMinutes">Длительность, мин</label>
          <input id="durationMinutes" type="number" min="5" value={form.durationMinutes} onChange={(event) => updateField("durationMinutes", event.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="learningGoals">Цели обучения</label>
        <textarea
          id="learningGoals"
          value={form.learningGoals}
          onChange={(event) => updateField("learningGoals", event.target.value)}
        />
      </div>

      <MaterialsSection
        materials={materials}
        selectedMaterialIds={selectedMaterialIds}
        toggleMaterialSelection={toggleMaterialSelection}
        onFilesPicked={onFilesPicked}
        uploadSelectedFiles={uploadSelectedFiles}
        indexSelectedMaterials={indexSelectedMaterials}
        refreshMaterials={refreshMaterials}
        checkQdrantStatus={checkQdrantStatus}
        isPending={isPending}
        selectedFiles={selectedFiles}
        materialsMessage={materialsMessage}
        qdrantStatus={qdrantStatus}
        expandedMaterialId={expandedMaterialId}
        toggleMaterialChunks={toggleMaterialChunks}
        deleteMaterialById={deleteMaterialById}
        materialChunksState={materialChunksState}
        loadMaterialChunks={loadMaterialChunks}
        setExpandedMaterialId={setExpandedMaterialId}
        fileInputRef={fileInputRef}
        form={form}
        updateField={updateField}
      />

      <LlmSection 
        form={form} 
        updateField={updateField} 
        checkLocalLlm={checkLocalLlm} 
        llmStatus={llmStatus} 
        isPending={isPending} 
      />

      <StructureSection form={form} updateField={updateField} />
      
      <TestSection form={form} updateField={updateField} />

      {error ? <div className="status warning">{error}</div> : null}

      <div className="actions">
        <button className="primary-button outline-button" type="button" onClick={handleGenerateOutlineOnly} disabled={isPending || generationProgress.active}>
          Генерировать структуру (outline)
        </button>
        <button className="primary-button" type="submit" disabled={isPending || generationProgress.active}>
          Сгенерировать курс полностью
        </button>
      </div>

      <ModuleStatus moduleStreamState={moduleStreamState} />

      <HistorySection 
        historyVisible={historyVisible}
        setHistoryVisible={setHistoryVisible}
        hideCompletedHistory={hideCompletedHistory}
        setHideCompletedHistory={setHideCompletedHistory}
        historyLoading={historyLoading}
        refreshGenerationHistory={refreshGenerationHistory}
        generationHistory={generationHistory}
        generationProgress={generationProgress}
      />

      <ProgressSection generationProgress={generationProgress} />

      {outlineEditorVisible && generatedOutlineContent ? (
        <OutlineEditor 
          outline={generatedOutlineContent.outline}
          onChange={(newOutline) => {
            setGeneratedOutlineContent((current) => ({ ...current, outline: newOutline }));
          }}
          onCancel={() => setOutlineEditorVisible(false)}
          onConfirm={handleGenerateContentFromOutline}
        />
      ) : null}
    </form>
  );
}
