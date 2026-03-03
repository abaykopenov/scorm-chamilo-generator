"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createDefaultGenerateInput } from "@/lib/course-defaults";
import { FileUploader, ServerManager, ProgressTracker } from "./course-editor";

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

export function CourseCreator() {
  const router = useRouter();
  const defaults = createDefaultGenerateInput();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [llmModels, setLlmModels] = useState([]);
  const [llmStatus, setLlmStatus] = useState(null);
  const [fileChunks, setFileChunks] = useState([]);
  const [servers, setServers] = useState([]);
  const [useParallel, setUseParallel] = useState(false);
  const [concurrency, setConcurrency] = useState(4);
  const [jobId, setJobId] = useState(null);
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
    generationMaxTokens: defaults.generation.maxTokens || 64000
  });

  // Load servers from settings
  useEffect(() => {
    fetch("/api/servers").then((r) => r.json()).then((d) => {
      if (d.servers) setServers(d.servers);
    }).catch(() => { });
  }, []);

  // Save servers when changed
  const handleServersChange = async (newServers) => {
    setServers(newServers);
    try {
      await fetch("/api/servers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ servers: newServers })
      });
    } catch { }
  };

  function updateField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function checkLlm() {
    setLlmStatus(null);
    setLlmModels([]);
    startTransition(async () => {
      try {
        const provider = form.generationProvider === "template" ? "ollama" : form.generationProvider;
        const resp = await fetch("/api/llm/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            baseUrl: form.generationBaseUrl,
            model: form.generationModel
          })
        });
        const data = await resp.json();
        setLlmStatus(data);
        if (data.ok && data.models && data.models.length > 0) {
          setLlmModels(data.models);
          // Auto-switch provider from template to ollama
          if (form.generationProvider === "template") {
            updateField("generationProvider", "ollama");
          }
          if (!form.generationModel) {
            updateField("generationModel", data.models[0]);
          }
        }
      } catch {
        setLlmStatus({ ok: false, error: "Ошибка сети." });
      }
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setJobId(null);

    const payload = {
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
        temperature: toSafeNumber(form.generationTemperature, defaults.generation.temperature, 0, 1),
        maxTokens: toSafeNumber(form.generationMaxTokens, 64000, 1000, 200000)
      },
      fileChunks: fileChunks.length > 0 ? fileChunks : undefined,
      async: useParallel && servers.filter((s) => s.enabled).length > 0,
      concurrency
    };

    startTransition(async () => {
      const response = await fetch("/api/courses/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        setError("Не удалось сгенерировать курс.");
        return;
      }

      const result = await response.json();
      if (result.jobId) {
        // Async mode — show progress
        setJobId(result.jobId);
      } else {
        // Sync mode — redirect
        router.push(`/courses/${result.id}`);
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

      <div className="panel">
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
            {llmModels.length > 0 ? (
              <select
                id="generationModel"
                value={form.generationModel}
                onChange={(event) => updateField("generationModel", event.target.value)}
              >
                <option value="">— Выберите модель —</option>
                {llmModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input id="generationModel" value={form.generationModel} onChange={(event) => updateField("generationModel", event.target.value)} />
            )}
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
          <div className="field">
            <label htmlFor="generationMaxTokens">Max Tokens</label>
            <input
              id="generationMaxTokens"
              type="number"
              min="1000"
              max="200000"
              step="1000"
              value={form.generationMaxTokens}
              onChange={(event) => updateField("generationMaxTokens", event.target.value)}
            />
          </div>
        </div>
        <div className="actions" style={{ marginTop: "10px" }}>
          <button className="ghost-button" type="button" onClick={checkLlm} disabled={isPending}>
            🔌 Проверить LLM
          </button>
        </div>
        {llmStatus ? (
          <div className={llmStatus.ok ? "status success" : "status warning"} style={{ marginTop: "8px" }}>
            {llmStatus.ok ? "✓ " : "✗ "}
            {llmStatus.message || llmStatus.error}
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="tree-header">
          <h3>📁 Загрузка материалов</h3>
          <span className="meta">Загрузите файлы (PDF, DOCX, TXT) — ИИ использует их как основу для контента курса.</span>
        </div>
        <FileUploader onChunksReady={(chunks) => setFileChunks(chunks)} />
      </div>

      <div className="panel">
        <div className="tree-header">
          <h3>🖥️ Параллельная генерация</h3>
          <span className="meta">Добавьте несколько LLM-серверов для ускорения генерации больших курсов.</span>
        </div>
        <div className="field" style={{ marginBottom: "12px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input type="checkbox" checked={useParallel} onChange={(e) => setUseParallel(e.target.checked)} />
            Включить параллельную генерацию
          </label>
        </div>
        {useParallel && (
          <>
            <div className="field" style={{ marginBottom: "12px" }}>
              <label htmlFor="concurrency">Макс. параллельных задач: {concurrency}</label>
              <input
                id="concurrency" type="range" min="1" max="8" value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </div>
            <ServerManager servers={servers} onChange={handleServersChange} />
          </>
        )}
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

      {jobId && (
        <ProgressTracker
          jobId={jobId}
          onComplete={(courseId) => router.push(`/courses/${courseId}`)}
        />
      )}

      <div className="actions">
        <button className="button" type="submit" disabled={isPending || jobId}>
          {isPending ? "Генерация..." : jobId ? "Генерация идёт..." : useParallel ? "⚡ Параллельная генерация" : "Сгенерировать курс"}
        </button>
      </div>
    </form>
  );
}
