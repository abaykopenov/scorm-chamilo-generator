"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDefaultGenerateInput } from "@/lib/course-defaults";

function toSafeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function serializeGoals(value) {
  return value.join("\n");
}

function parseGoals(value) {
  return value
    .split(/\r?\n/)
    .map((goal) => goal.trim())
    .filter(Boolean);
}

function parseStreamEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value) {
  if (!value) {
    return "n/a";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return `${value}`;
  }
}

const MAX_UPLOAD_FILE_SIZE_MB = 50;
const MAX_UPLOAD_FILE_SIZE = MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
const MATERIAL_CHUNKS_PAGE_SIZE = 12;
const MATERIAL_CHUNK_PREVIEW_CHARS = 420;
const GENERATION_STAGE_LABELS = {
  request: "Preparing request",
  input: "Validating input",
  rag: "Building context",
  "llm-outline": "Generating outline",
  "llm-line-plan": "Building line plan",
  finalize: "Finalizing course",
  saving: "Saving course",
  done: "Completed"
};

export function CourseCreator({ initialHistory = [] }) {
  const router = useRouter();
  const defaults = createDefaultGenerateInput();
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef(null);

  const [error, setError] = useState("");
  const [llmStatus, setLlmStatus] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState(defaults.rag.documentIds);
  const [materialsMessage, setMaterialsMessage] = useState("");
  const [expandedMaterialId, setExpandedMaterialId] = useState("");
  const [materialChunksState, setMaterialChunksState] = useState({});
  const [generationProgress, setGenerationProgress] = useState({
    active: false,
    percent: 0,
    stage: "",
    message: ""
  });
  const [qdrantStatus, setQdrantStatus] = useState({
    loading: true,
    ok: false,
    mode: "fallback",
    message: "Checking Qdrant...",
    checkedAt: "",
    target: null
  });

  const [historyLoading, setHistoryLoading] = useState(false);
  const [generationHistory, setGenerationHistory] = useState(
    Array.isArray(initialHistory) ? initialHistory : []
  );
  const [moduleStreamState, setModuleStreamState] = useState({
    courseId: "",
    completedModules: 0,
    totalModules: 0,
    lastModuleTitle: ""
  });

  const [form, setForm] = useState({
    titleHint: defaults.titleHint,
    audience: defaults.audience,
    learningGoals: serializeGoals(defaults.learningGoals),
    durationMinutes: defaults.durationMinutes,
    language: defaults.language,
    moduleCount: defaults.structure.moduleCount,
    sectionsPerModule: defaults.structure.sectionsPerModule,
    scosPerSection: defaults.structure.scosPerSection,
    screensPerSco: defaults.structure.screensPerSco,
    finalTestEnabled: defaults.finalTest.enabled,
    questionCount: defaults.finalTest.questionCount,
    passingScore: defaults.finalTest.passingScore,
    attemptsLimit: defaults.finalTest.attemptsLimit,
    maxTimeMinutes: defaults.finalTest.maxTimeMinutes,
    generationProvider: defaults.generation.provider,
    generationBaseUrl: defaults.generation.baseUrl,
    generationModel: defaults.generation.model,
    generationTemperature: defaults.generation.temperature,
    ragEnabled: defaults.rag.enabled,
    ragTopK: defaults.rag.topK,
    embeddingProvider: defaults.rag.embedding.provider,
    embeddingBaseUrl: defaults.rag.embedding.baseUrl,
    embeddingModel: defaults.rag.embedding.model
  });

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function resolveErrorMessage(error, fallback) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }

  async function checkQdrantStatus() {
    setQdrantStatus((current) => ({
      ...current,
      loading: true
    }));

    try {
      const response = await fetch("/api/diagnostics/qdrant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const payload = await response.json().catch(() => ({}));

      setQdrantStatus({
        loading: false,
        ok: Boolean(payload?.ok),
        mode: payload?.mode === "connected" ? "connected" : "fallback",
        message: payload?.message || (payload?.ok ? "Qdrant connected." : "Local vector fallback is active."),
        checkedAt: `${payload?.checkedAt || ""}`.trim(),
        target: payload?.target || null
      });
    } catch (error) {
      setQdrantStatus({
        loading: false,
        ok: false,
        mode: "fallback",
        message: resolveErrorMessage(error, "Qdrant check failed. Local vector fallback is active."),
        checkedAt: new Date().toISOString(),
        target: null
      });
    }
  }

  async function refreshMaterials() {
    try {
      const response = await fetch("/api/materials");
      if (!response.ok) {
        throw new Error("Не удалось получить список материалов.");
      }
      const payload = await response.json();
      const items = Array.isArray(payload?.materials) ? payload.materials : [];
      setMaterials(items);
      setSelectedMaterialIds((current) => current.filter((id) => items.some((item) => item.id === id)));
      setMaterialChunksState((current) => {
        const allowedIds = new Set(items.map((item) => item.id));
        const next = {};
        for (const [materialId, state] of Object.entries(current)) {
          if (allowedIds.has(materialId)) {
            next[materialId] = state;
          }
        }
        return next;
      });
      setExpandedMaterialId((current) => (items.some((item) => item.id === current) ? current : ""));
      return items;
    } catch (error) {
      throw new Error(resolveErrorMessage(error, "Ошибка загрузки списка материалов."));
    }
  }

  function upsertHistoryEntry(entry) {
    if (!entry?.id) {
      return;
    }

    setGenerationHistory((current) => {
      const next = [entry, ...current.filter((item) => item?.id !== entry.id)];
      next.sort((left, right) => {
        const leftTs = new Date(left?.updatedAt || 0).getTime() || 0;
        const rightTs = new Date(right?.updatedAt || 0).getTime() || 0;
        return rightTs - leftTs;
      });
      return next.slice(0, 30);
    });
  }

  async function refreshGenerationHistory() {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/courses?limit=30");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || "Failed to load generation history.");
      }
      const courses = Array.isArray(payload?.courses) ? payload.courses : [];
      setGenerationHistory(courses);
    } catch (historyError) {
      setError((current) => current || resolveErrorMessage(historyError, "Failed to load generation history."));
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    refreshMaterials().catch(() => {
      setMaterialsMessage("Failed to load materials list.");
    });
    checkQdrantStatus();
    refreshGenerationHistory().catch(() => {});
  }, []);

  async function loadMaterialChunks(materialId, options = {}) {
    const append = Boolean(options?.append);
    const current = materialChunksState[materialId];
    const offset = append ? (current?.items?.length || 0) : 0;

    setMaterialChunksState((state) => ({
      ...state,
      [materialId]: {
        ...(state[materialId] || { items: [], total: 0, hasMore: false }),
        loading: true,
        error: ""
      }
    }));

    try {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(MATERIAL_CHUNKS_PAGE_SIZE),
        previewChars: String(MATERIAL_CHUNK_PREVIEW_CHARS)
      });

      const response = await fetch("/api/materials/" + materialId + "/chunks?" + params.toString());
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || "Failed to load material chunks.");
      }

      const incoming = Array.isArray(payload?.chunks) ? payload.chunks : [];
      const total = Number(payload?.pagination?.total) || incoming.length;
      const hasMore = Boolean(payload?.pagination?.hasMore);

      setMaterialChunksState((state) => {
        const previous = state[materialId] || { items: [] };
        const items = append ? [...(previous.items || []), ...incoming] : incoming;

        return {
          ...state,
          [materialId]: {
            loading: false,
            error: "",
            items,
            total,
            hasMore
          }
        };
      });
    } catch (error) {
      setMaterialChunksState((state) => ({
        ...state,
        [materialId]: {
          ...(state[materialId] || { items: [], total: 0, hasMore: false }),
          loading: false,
          error: resolveErrorMessage(error, "Failed to load chunks.")
        }
      }));
    }
  }

  function toggleMaterialChunks(materialId) {
    if (expandedMaterialId === materialId) {
      setExpandedMaterialId("");
      return;
    }

    setExpandedMaterialId(materialId);

    const current = materialChunksState[materialId];
    if (!current || (current.items || []).length === 0) {
      loadMaterialChunks(materialId).catch(() => {});
    }
  }

  function toggleMaterialSelection(materialId) {
    setSelectedMaterialIds((current) => {
      if (current.includes(materialId)) {
        return current.filter((id) => id !== materialId);
      }
      return [...current, materialId];
    });
  }

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
    if (!window.confirm(`Удалить материал "${label}"?`)) {
      return;
    }

    setMaterialsMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(`/api/materials/${materialId}`, {
          method: "DELETE"
        });
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

    if (selectedFiles.length > MAX_UPLOAD_FILES) {
      setMaterialsMessage(`You can upload up to ${MAX_UPLOAD_FILES} files at once.`);
      return;
    }

    const tooLargeFile = selectedFiles.find((file) => file.size > MAX_UPLOAD_FILE_SIZE);
    if (tooLargeFile) {
      setMaterialsMessage(`File "${tooLargeFile.name}" is larger than ${MAX_UPLOAD_FILE_SIZE_MB} MB.`);
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

          const response = await fetch("/api/materials/upload", {
            method: "POST",
            body: formData
          });

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
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
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
        setMaterialsMessage(
          `Indexing completed. Success: ${payload.indexed ?? 0}, failed: ${payload.failed ?? 0}. Qdrant: ${qdrantMode}.`
        );
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
        if (!response.ok) {
          setError(payload.message || "Не удалось проверить локальную LLM.");
        }
      } catch (error) {
        setError(resolveErrorMessage(error, "Ошибка сети при проверке LLM."));
      }
    });
  }

  function getGenerationPayload() {
    return {
      titleHint: form.titleHint,
      audience: form.audience,
      learningGoals: parseGoals(form.learningGoals),
      durationMinutes: Number(form.durationMinutes),
      language: form.language,
      structure: {
        moduleCount: Number(form.moduleCount),
        sectionsPerModule: Number(form.sectionsPerModule),
        scosPerSection: Number(form.scosPerSection),
        screensPerSco: Number(form.screensPerSco)
      },
      finalTest: {
        enabled: Boolean(form.finalTestEnabled),
        questionCount: Number(form.questionCount),
        passingScore: Number(form.passingScore),
        attemptsLimit: Number(form.attemptsLimit),
        maxTimeMinutes: Number(form.maxTimeMinutes)
      },
      generation: {
        provider: form.generationProvider,
        baseUrl: form.generationBaseUrl,
        model: form.generationModel,
        temperature: toSafeNumber(form.generationTemperature, defaults.generation.temperature, 0, 1)
      },
      rag: {
        enabled: Boolean(form.ragEnabled),
        topK: toSafeNumber(form.ragTopK, defaults.rag.topK, 1, 30),
        documentIds: selectedMaterialIds,
        embedding: {
          provider: form.embeddingProvider,
          baseUrl: form.embeddingBaseUrl,
          model: form.embeddingModel
        }
      }
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    const strictRagEnabled = Boolean(form.ragEnabled) && selectedMaterialIds.length > 0;
    if (strictRagEnabled) {
      const selected = materials.filter((item) => selectedMaterialIds.includes(item.id));
      const notIndexed = selected.filter((item) => item.status !== "indexed");
      if (notIndexed.length > 0) {
        setError(
          "Please index selected materials first. Not ready: " +
            notIndexed.slice(0, 3).map((item) => item.fileName).join(", ") +
            (notIndexed.length > 3 ? "..." : "")
        );
        return;
      }
    }

    setGenerationProgress({
      active: true,
      percent: 0,
      stage: "request",
      message: GENERATION_STAGE_LABELS.request
    });
    setModuleStreamState({
      courseId: "",
      completedModules: 0,
      totalModules: 0,
      lastModuleTitle: ""
    });

    try {
      const response = await fetch("/api/courses/generate?stream=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getGenerationPayload())
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.message || "Failed to generate course.");
      }

      if (!response.body) {
        throw new Error("Generation stream is unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let generatedCourse = null;

      const applyEvent = (streamEvent) => {
        if (!streamEvent || typeof streamEvent !== "object") {
          return;
        }

        if (streamEvent.type === "progress") {
          const percent = toSafeNumber(streamEvent.percent, 0, 0, 100);
          const stage = String(streamEvent.stage || "");
          const message = String(streamEvent.message || "").trim() || GENERATION_STAGE_LABELS[stage] || "Course generation";
          setGenerationProgress({
            active: true,
            percent: Math.trunc(percent),
            stage,
            message
          });
          return;
        }

        if (streamEvent.type === "error") {
          throw new Error(streamEvent.message || "Failed to generate course.");
        }

        if (streamEvent.type === "module_ready") {
          const courseId = `${streamEvent.courseId || ""}`.trim();
          const moduleIndex = toSafeNumber(streamEvent.moduleIndex, 0, 0, 1000);
          const totalModules = toSafeNumber(streamEvent.totalModules, 0, 0, 1000);
          const completedModules = toSafeNumber(streamEvent.completedModules, moduleIndex + 1, 0, 1000);
          const moduleTitle = `${streamEvent.moduleTitle || ""}`.trim();

          setGenerationProgress((current) => {
            const progressFromModules = totalModules > 0
              ? Math.min(95, Math.max(8, Math.round((completedModules / totalModules) * 90)))
              : current.percent;

            return {
              ...current,
              percent: Math.max(current.percent, progressFromModules),
              stage: "module_ready",
              message: "Module " + completedModules + "/" + (totalModules || "?") + " is ready" + (moduleTitle ? ": " + moduleTitle : "")
            };
          });

          setModuleStreamState({
            courseId,
            completedModules,
            totalModules,
            lastModuleTitle: moduleTitle
          });

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
          return;
        }

        if (streamEvent.type === "done") {
          generatedCourse = streamEvent.course || null;
          setGenerationProgress({
            active: true,
            percent: 100,
            stage: "done",
            message: GENERATION_STAGE_LABELS.done
          });

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
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          applyEvent(parseStreamEvent(trimmed));
        }
      }

      const tail = (buffer + decoder.decode()).trim();
      if (tail) {
        applyEvent(parseStreamEvent(tail));
      }

      if (!generatedCourse?.id) {
        throw new Error("Generation finished without a course result.");
      }

      router.push("/courses/" + generatedCourse.id);
    } catch (error) {
      setError(resolveErrorMessage(error, "Network error during course generation."));
      setGenerationProgress((current) => ({
        ...current,
        active: false
      }));
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

      <div className="panel stack">
        <div className="tree-header">
          <h3>Материалы для RAG</h3>
          <span className="meta">Загрузите документы, проиндексируйте и выберите источники для генерации курса.</span>
        </div>

        <div className="field-grid">
          <div className="field">
            <label htmlFor="ragEnabled">RAG режим</label>
            <select
              id="ragEnabled"
              value={form.ragEnabled ? "yes" : "no"}
              onChange={(event) => updateField("ragEnabled", event.target.value === "yes")}
            >
              <option value="yes">Включен</option>
              <option value="no">Отключен</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ragTopK" className="label-with-help">
              <span>Top-K чанков</span>
              <button
                type="button"
                className="help-icon"
                aria-label="Что такое Top-K чанков"
                title="Что такое Top-K чанков"
              >
                ?
              </button>
              <span className="help-tooltip">
                Сколько самых релевантных фрагментов из материалов передается в модель для генерации курса.
                Больше значение = шире контекст, но может быть больше лишнего текста.
              </span>
            </label>
            <input
              id="ragTopK"
              type="number"
              min="1"
              max="30"
              value={form.ragTopK}
              onChange={(event) => updateField("ragTopK", event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="embeddingProvider">Embedding provider</label>
            <select
              id="embeddingProvider"
              value={form.embeddingProvider}
              onChange={(event) => updateField("embeddingProvider", event.target.value)}
            >
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="embeddingBaseUrl">Embedding base URL</label>
            <input
              id="embeddingBaseUrl"
              value={form.embeddingBaseUrl}
              onChange={(event) => updateField("embeddingBaseUrl", event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="embeddingModel">Embedding model</label>
            <input
              id="embeddingModel"
              value={form.embeddingModel}
              onChange={(event) => updateField("embeddingModel", event.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="rag-files" className="label-with-help">
            <span>Upload files</span>
            <button
              type="button"
              className="help-icon"
              aria-label="Upload limits"
              title="Upload limits"
            >
              ?
            </button>
            <span className="help-tooltip">
              Up to 10 files per upload, 50 MB maximum per file.
            </span>
          </label>
          <input
            ref={fileInputRef}
            id="rag-files"
            type="file"
            multiple
            onChange={onFilesPicked}
            accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.docx,.doc,.pdf,text/plain,text/markdown,application/json,text/csv,text/html,application/xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
          />
        </div>

        <div className="actions">
          <button className="ghost-button" type="button" onClick={uploadSelectedFiles} disabled={isPending}>
            Загрузить выбранные файлы
          </button>
          <button className="ghost-button" type="button" onClick={indexSelectedMaterials} disabled={isPending || selectedMaterialIds.length === 0}>
            Индексировать выбранные материалы
          </button>
          <button
            className="link-button"
            type="button"
            onClick={() => {
              refreshMaterials().catch((error) => {
                setMaterialsMessage(resolveErrorMessage(error, "Ошибка загрузки материалов."));
              });
            }}
            disabled={isPending}
          >
            Обновить список
          </button>
          <button className="link-button" type="button" onClick={checkQdrantStatus} disabled={isPending || qdrantStatus.loading}>
            Check Qdrant
          </button>
        </div>

        {selectedFiles.length > 0 ? (
          <div className="status">
            Выбрано файлов: {selectedFiles.length}
          </div>
        ) : null}

        {materialsMessage ? (
          <div className="status success">{materialsMessage}</div>
        ) : null}

        <div className={qdrantStatus.ok ? "status success" : "status warning"}>
          <strong>Vector DB (Qdrant): </strong>
          {qdrantStatus.loading ? "checking..." : qdrantStatus.mode}
          {". "}
          {qdrantStatus.message}
          {qdrantStatus.target?.baseUrl ? ` (${qdrantStatus.target.baseUrl})` : ""}
        </div>

        <div className="materials-list">
          {materials.length === 0 ? (
            <p className="note">Материалы пока не загружены.</p>
          ) : (
            materials.map((material) => (
              <label key={material.id} className="material-item">
                <input
                  type="checkbox"
                  checked={selectedMaterialIds.includes(material.id)}
                  onChange={() => toggleMaterialSelection(material.id)}
                />
                <div className="material-item-body">
                  <strong>{material.fileName}</strong>
                  <span className="meta">
                    {formatFileSize(material.size)} - {material.status} - chunks: {material.chunksCount || 0}
                  </span>
                  {material.errorMessage ? <span className="status warning">{material.errorMessage}</span> : null}
                  <div className="material-item-actions">
                    <button
                      type="button"
                      className="ghost-button compact-button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleMaterialChunks(material.id);
                      }}
                      disabled={isPending || material.status !== "indexed"}
                      title={material.status === "indexed" ? "" : "Index material first"}
                    >
                      {expandedMaterialId === material.id ? "Hide chunks" : "Show chunks"}
                    </button>
                    <button
                      type="button"
                      className="delete-button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteMaterialById(material.id);
                      }}
                      disabled={isPending}
                    >
                      Delete file
                    </button>
                  </div>

                  {expandedMaterialId === material.id ? (
                    <div
                      className="chunks-viewer"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      {materialChunksState[material.id]?.loading && !(materialChunksState[material.id]?.items?.length > 0) ? (
                        <div className="status">Loading chunks...</div>
                      ) : null}

                      {materialChunksState[material.id]?.error ? (
                        <div className="status warning">{materialChunksState[material.id].error}</div>
                      ) : null}

                      {materialChunksState[material.id]?.items?.length > 0 ? (
                        <div className="chunk-preview-list">
                          {materialChunksState[material.id].items.map((chunk) => (
                            <article key={chunk.id || ("chunk-" + chunk.order)} className="chunk-preview-item">
                              <div className="chunk-preview-head">
                                <strong>Chunk #{chunk.order || "?"}</strong>
                                <span className="meta">{chunk.length || 0} chars</span>
                              </div>
                              <p>
                                {chunk.preview}
                                {chunk.truncated ? "..." : ""}
                              </p>
                            </article>
                          ))}
                        </div>
                      ) : null}

                      {!materialChunksState[material.id]?.loading &&
                      !materialChunksState[material.id]?.error &&
                      !(materialChunksState[material.id]?.items?.length > 0) ? (
                        <p className="note">Chunks not found. Run indexing first.</p>
                      ) : null}

                      <div className="material-item-actions">
                        {materialChunksState[material.id]?.hasMore ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              loadMaterialChunks(material.id, { append: true });
                            }}
                            disabled={isPending || materialChunksState[material.id]?.loading}
                          >
                            Show more
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="link-button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setExpandedMaterialId("");
                          }}
                        >
                          Collapse
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </label>
            ))
)}
        </div>
      </div>

      <div className="panel stack">
        <div className="tree-header">
          <h3>Локальная LLM</h3>
          <span className="meta">Можно генерировать курс через локальную модель, например Ollama на `127.0.0.1:11434`.</span>
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="generationProvider">Провайдер</label>
            <select
              id="generationProvider"
              value={form.generationProvider}
              onChange={(event) => updateField("generationProvider", event.target.value)}
            >
              <option value="template">Шаблонный draft</option>
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="generationBaseUrl">Base URL</label>
            <input id="generationBaseUrl" value={form.generationBaseUrl} onChange={(event) => updateField("generationBaseUrl", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="generationModel">Model</label>
            <input id="generationModel" value={form.generationModel} onChange={(event) => updateField("generationModel", event.target.value)} />
            <span className="meta">Используйте текстовую модель (например `qwen2.5`, `llama`, `mistral`), не embedding.</span>
          </div>
          <div className="field">
            <label htmlFor="generationTemperature">Temperature</label>
            <input
              id="generationTemperature"
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={form.generationTemperature}
              onChange={(event) => updateField("generationTemperature", event.target.value)}
            />
          </div>
        </div>
        <div className="actions">
          <button className="ghost-button" type="button" onClick={checkLocalLlm} disabled={isPending}>
            Проверить локальную LLM
          </button>
        </div>
        {llmStatus ? (
          <div className={llmStatus.ok ? "status success" : "status warning"}>
            {llmStatus.message}
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="tree-header">
          <h3>Структура курса</h3>
          <span className="meta">
            Параметры иерархии <code>Course -&gt; Module -&gt; Section -&gt; SCO -&gt; Screen</code>
          </span>
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="moduleCount">Модулей</label>
            <input id="moduleCount" type="number" min="1" max="20" value={form.moduleCount} onChange={(event) => updateField("moduleCount", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="sectionsPerModule">Разделов на модуль</label>
            <input id="sectionsPerModule" type="number" min="1" max="20" value={form.sectionsPerModule} onChange={(event) => updateField("sectionsPerModule", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="scosPerSection">SCO на раздел</label>
            <input id="scosPerSection" type="number" min="1" max="20" value={form.scosPerSection} onChange={(event) => updateField("scosPerSection", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="screensPerSco">Экранов в SCO</label>
            <input id="screensPerSco" type="number" min="1" max="20" value={form.screensPerSco} onChange={(event) => updateField("screensPerSco", event.target.value)} />
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="tree-header">
          <h3>Итоговый тест</h3>
          <span className="meta">Попытки и время будут контролироваться внутри SCORM-пакета.</span>
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="finalTestEnabled">Тест</label>
            <select
              id="finalTestEnabled"
              value={form.finalTestEnabled ? "yes" : "no"}
              onChange={(event) => updateField("finalTestEnabled", event.target.value === "yes")}
            >
              <option value="yes">Включен</option>
              <option value="no">Отключен</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="questionCount">Вопросов</label>
            <input id="questionCount" type="number" min="0" max="100" value={form.questionCount} onChange={(event) => updateField("questionCount", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="passingScore">Passing score</label>
            <input id="passingScore" type="number" min="0" max="100" value={form.passingScore} onChange={(event) => updateField("passingScore", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="attemptsLimit">Attempts</label>
            <input id="attemptsLimit" type="number" min="1" max="20" value={form.attemptsLimit} onChange={(event) => updateField("attemptsLimit", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="maxTimeMinutes">Max time, мин</label>
            <input id="maxTimeMinutes" type="number" min="1" max="300" value={form.maxTimeMinutes} onChange={(event) => updateField("maxTimeMinutes", event.target.value)} />
          </div>
        </div>
      </div>

      {error ? <div className="status warning">{error}</div> : null}

      {moduleStreamState.courseId ? (
        <div className="status">
          <strong>Module ready: </strong>
          {moduleStreamState.completedModules}/{moduleStreamState.totalModules || "?"}
          {moduleStreamState.lastModuleTitle ? " - " + moduleStreamState.lastModuleTitle : ""}
          <div className="actions">
            <a
              className="link-button"
              href={"/courses/" + moduleStreamState.courseId}
              target="_blank"
              rel="noreferrer"
            >
              Open current draft
            </a>
          </div>
        </div>
      ) : null}

      <div className="panel stack">
        <div className="tree-header">
          <h3>Generation history</h3>
          <button
            className="link-button"
            type="button"
            onClick={refreshGenerationHistory}
            disabled={historyLoading || generationProgress.active}
          >
            {historyLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {generationHistory.length === 0 ? (
          <p className="note">No generated courses yet.</p>
        ) : (
          <div className="generation-history-list">
            {generationHistory.map((historyItem) => (
              <article key={historyItem.id} className="generation-history-item">
                <div className="generation-history-head">
                  <strong>{historyItem.title || "Untitled course"}</strong>
                  <span className={historyItem.generationStatus === "completed" ? "history-badge complete" : "history-badge progress"}>
                    {historyItem.generationStatus === "completed" ? "completed" : "in progress"}
                  </span>
                </div>
                <div className="meta">Updated: {formatDateTime(historyItem.updatedAt)}</div>
                <div className="meta">
                  Modules: {Number(historyItem.completedModules || 0)}/{Number(historyItem.moduleCount || 0)}
                </div>
                <div className="actions">
                  <a className="link-button" href={"/courses/" + historyItem.id}>
                    Open course
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {generationProgress.active ? (
        <div className="generation-progress" role="status" aria-live="polite">
          <div className="generation-progress-head">
            <strong>{generationProgress.message || "Course generation"}</strong>
            <span>{generationProgress.percent}%</span>
          </div>
          <div className="generation-progress-track">
            <div
              className="generation-progress-fill"
              style={{ width: String(generationProgress.percent) + "%" }}
            />
          </div>
        </div>
      ) : null}

      <div className="actions">
        <button className="button" type="submit" disabled={isPending || generationProgress.active}>
          {generationProgress.active ? "Generating... " + generationProgress.percent + "%" : "Generate course"}
        </button>
      </div>
    </form>
  );
}
