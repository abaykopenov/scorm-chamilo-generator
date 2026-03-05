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

export function CourseCreator() {
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
      return items;
    } catch (error) {
      throw new Error(resolveErrorMessage(error, "Ошибка загрузки списка материалов."));
    }
  }

  useEffect(() => {
    refreshMaterials().catch(() => {
      setMaterialsMessage("Не удалось загрузить список материалов.");
    });
  }, []);

  function toggleMaterialSelection(materialId) {
    setSelectedMaterialIds((current) => {
      if (current.includes(materialId)) {
        return current.filter((id) => id !== materialId);
      }
      return [...current, materialId];
    });
  }

  function onFilesPicked(event) {
    setSelectedFiles(Array.from(event.target.files || []));
    setMaterialsMessage("");
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
        await refreshMaterials();
        setMaterialsMessage(`Материал "${label}" удален.`);
      } catch (error) {
        setMaterialsMessage(resolveErrorMessage(error, "Ошибка сети при удалении материала."));
      }
    });
  }

  function uploadSelectedFiles() {
    if (selectedFiles.length === 0) {
      setMaterialsMessage("Выберите хотя бы один файл.");
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
        setMaterialsMessage(
          `Индексация завершена. Успешно: ${payload.indexed ?? 0}, ошибок: ${payload.failed ?? 0}.`
        );
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

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    const strictRagEnabled = Boolean(form.ragEnabled) && selectedMaterialIds.length > 0;
    if (strictRagEnabled) {
      const selected = materials.filter((item) => selectedMaterialIds.includes(item.id));
      const notIndexed = selected.filter((item) => item.status !== "indexed");
      if (notIndexed.length > 0) {
        setError(
          `Сначала проиндексируйте выбранные книги. Не готовы: ${notIndexed
            .slice(0, 3)
            .map((item) => item.fileName)
            .join(", ")}${notIndexed.length > 3 ? "..." : ""}`
        );
        return;
      }
    }

    startTransition(async () => {
      try {
        const response = await fetch("/api/courses/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
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
          })
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          setError(payload?.message || "Не удалось сгенерировать курс.");
          return;
        }

        const course = await response.json();
        router.push(`/courses/${course.id}`);
      } catch (error) {
        setError(resolveErrorMessage(error, "Ошибка сети при генерации курса."));
      }
    });
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
          <label htmlFor="rag-files">Загрузить файлы</label>
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
        </div>

        {selectedFiles.length > 0 ? (
          <div className="status">
            Выбрано файлов: {selectedFiles.length}
          </div>
        ) : null}

        {materialsMessage ? (
          <div className="status success">{materialsMessage}</div>
        ) : null}

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
                    {formatFileSize(material.size)} · {material.status} · chunks: {material.chunksCount || 0}
                  </span>
                  {material.errorMessage ? <span className="status warning">{material.errorMessage}</span> : null}
                  <div className="material-item-actions">
                    <button
                      type="button"
                      className="delete-button"
                      onClick={() => deleteMaterialById(material.id)}
                      disabled={isPending}
                    >
                      Удалить файл
                    </button>
                  </div>
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

      <div className="actions">
        <button className="button" type="submit" disabled={isPending}>
          {isPending ? "Генерация..." : "Сгенерировать курс"}
        </button>
      </div>
    </form>
  );
}
