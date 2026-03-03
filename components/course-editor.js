"use client";

import { useState, useCallback } from "react";

export function CourseEditor({ course, onCourseUpdate }) {
  const [editingModule, setEditingModule] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(null); // moduleIndex or "add"
  const [expandedModule, setExpandedModule] = useState(null);

  const apiEdit = useCallback(async (action, body = {}) => {
    const resp = await fetch(`/api/courses/${course.id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body })
    });
    return resp.json();
  }, [course?.id]);

  const handleRegenerate = async (moduleIndex) => {
    setLoading(moduleIndex);
    try {
      const result = await apiEdit("regenerate-module", {
        moduleIndex,
        instruction: instruction || undefined
      });
      if (result.ok && onCourseUpdate) onCourseUpdate();
    } catch (err) {
      console.error("Regenerate failed:", err);
    } finally {
      setLoading(null);
      setInstruction("");
    }
  };

  const handleAddModule = async () => {
    setLoading("add");
    try {
      const result = await apiEdit("add-module", {
        instruction: instruction || "Дополнительная тема курса"
      });
      if (result.ok && onCourseUpdate) onCourseUpdate();
    } catch (err) {
      console.error("Add module failed:", err);
    } finally {
      setLoading(null);
      setInstruction("");
    }
  };

  const handleDeleteModule = async (moduleIndex) => {
    if (!confirm(`Удалить модуль "${course.modules[moduleIndex]?.title}"?`)) return;
    setLoading(moduleIndex);
    try {
      const result = await apiEdit("delete-module", { moduleIndex });
      if (result.ok && onCourseUpdate) onCourseUpdate();
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setLoading(null);
    }
  };

  const handleUpdateTitle = async (moduleIndex, newTitle) => {
    await apiEdit("update-module", {
      moduleIndex,
      module: { title: newTitle }
    });
    if (onCourseUpdate) onCourseUpdate();
  };

  if (!course?.modules) return null;

  const genConfig = course._generationConfig || course.generation;
  const modelLabel = genConfig?.model ? `${genConfig.model}` : "шаблон";

  return (
    <div className="course-editor">
      <div className="editor-header">
        <h3>📝 Редактор курса</h3>
        <p className="editor-hint">
          Нажмите на модуль для просмотра и редактирования.
          {genConfig?.model && (
            <span style={{ marginLeft: "8px", padding: "2px 8px", background: "var(--accent-soft)", borderRadius: "4px", color: "var(--accent-strong)", fontSize: "12px" }}>
              🤖 {modelLabel} @ {genConfig.baseUrl ? new URL(genConfig.baseUrl).hostname : "local"}
            </span>
          )}
        </p>
      </div>

      <div className="modules-list">
        {course.modules.map((mod, idx) => (
          <div key={mod.id || idx} className={`module-card ${expandedModule === idx ? "expanded" : ""}`}>
            <div className="module-header" onClick={() => setExpandedModule(expandedModule === idx ? null : idx)}>
              <div className="module-number">{idx + 1}</div>
              <div className="module-info">
                <input
                  className="module-title-input"
                  value={mod.title}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    mod.title = e.target.value;
                    // Debounce save
                    clearTimeout(mod._saveTimer);
                    mod._saveTimer = setTimeout(() => handleUpdateTitle(idx, e.target.value), 1000);
                  }}
                />
                <span className="module-meta">
                  {mod.sections?.length || 0} разд. · {
                    mod.sections?.reduce((acc, s) => acc + (s.scos?.reduce((a2, sco) => a2 + (sco.screens?.length || 0), 0) || 0), 0) || 0
                  } экр.
                </span>
              </div>
              <div className="module-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn-icon btn-regenerate"
                  disabled={loading !== null}
                  onClick={() => handleRegenerate(idx)}
                  title="Перегенерировать"
                >
                  {loading === idx ? "⏳" : "🔄"}
                </button>
                <button
                  className="btn-icon btn-delete"
                  disabled={loading !== null}
                  onClick={() => handleDeleteModule(idx)}
                  title="Удалить модуль"
                >
                  🗑️
                </button>
              </div>
            </div>

            {expandedModule === idx && (
              <div className="module-content">
                {mod.sections?.map((section, si) =>
                  section.scos?.map((sco, sci) =>
                    sco.screens?.map((screen, scri) => (
                      <div key={screen.id || `${si}-${sci}-${scri}`} className="screen-card">
                        <div className="screen-title">{screen.title}</div>
                        <div className="screen-blocks">
                          {screen.blocks?.map((block, bi) => (
                            <div key={bi} className={`block block-${block.type}`}>
                              {block.type === "text" && <p>{block.text}</p>}
                              {block.type === "note" && <div className="block-note">💡 {block.text}</div>}
                              {block.type === "list" && (
                                <ul>{block.items?.map((item, li) => <li key={li}>{item}</li>)}</ul>
                              )}
                              {block.type === "heading" && <h4>{block.text}</h4>}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )
                )}

                <div className="regenerate-bar">
                  <input
                    type="text"
                    placeholder="Инструкция для перегенерации (опционально)..."
                    value={editingModule === idx ? instruction : ""}
                    onChange={(e) => {
                      setEditingModule(idx);
                      setInstruction(e.target.value);
                    }}
                    className="regen-instruction"
                  />
                  <button
                    className="btn btn-regen"
                    disabled={loading !== null}
                    onClick={() => handleRegenerate(idx)}
                  >
                    {loading === idx ? "Генерация..." : "🔄 Перегенерировать модуль"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="add-module-bar">
        <input
          type="text"
          placeholder="Тема нового модуля..."
          value={loading === "add" ? "" : instruction}
          onChange={(e) => setInstruction(e.target.value)}
          className="add-module-input"
        />
        <button
          className="btn btn-add-module"
          disabled={loading !== null}
          onClick={handleAddModule}
        >
          {loading === "add" ? "⏳ Генерация..." : "➕ Добавить модуль"}
        </button>
      </div>
    </div>
  );
}

export function ProgressTracker({ jobId, onComplete }) {
  const [status, setStatus] = useState(null);

  useState(() => {
    if (!jobId) return;

    const evtSource = new EventSource(`/api/jobs/${jobId}`);
    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setStatus(data);
        if (data.status === "completed" || data.status === "failed") {
          evtSource.close();
          if (data.status === "completed" && onComplete) {
            setTimeout(() => onComplete(data.courseId), 500);
          }
        }
      } catch { }
    };
    evtSource.onerror = () => {
      evtSource.close();
      // Fallback: poll
      const poll = setInterval(async () => {
        try {
          const resp = await fetch(`/api/jobs/${jobId}`);
          const data = await resp.json();
          setStatus(data);
          if (data.status === "completed" || data.status === "failed") {
            clearInterval(poll);
            if (data.status === "completed" && onComplete) {
              onComplete(data.courseId);
            }
          }
        } catch { }
      }, 2000);
    };

    return () => evtSource.close();
  });

  if (!status) return <div className="progress-idle">Подключение...</div>;

  return (
    <div className={`progress-tracker status-${status.status}`}>
      <div className="progress-header">
        <span className="progress-label">{status.currentStep}</span>
        <span className="progress-percent">{status.progress}%</span>
      </div>
      <div className="progress-bar-container">
        <div className="progress-bar-fill" style={{ width: `${status.progress}%` }} />
      </div>
      {status.status === "failed" && (
        <div className="progress-error">❌ {status.error}</div>
      )}
    </div>
  );
}

export function FileUploader({ onChunksReady }) {
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const handleFiles = async (fileList) => {
    const newFiles = Array.from(fileList);
    setFiles((prev) => [...prev, ...newFiles]);
    setProcessing(true);

    try {
      const formData = new FormData();
      for (const f of newFiles) formData.append("files", f);

      const resp = await fetch("/api/files/upload", { method: "POST", body: formData });
      const data = await resp.json();
      setResult(data);
      if (data.chunks && onChunksReady) onChunksReady(data.chunks);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="file-uploader">
      <div
        className={`drop-zone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.accept = ".pdf,.docx,.txt,.md";
          input.onchange = () => handleFiles(input.files);
          input.click();
        }}
      >
        <div className="drop-icon">📁</div>
        <div className="drop-text">
          {processing ? "Обработка файлов..." :
            files.length > 0 ? `Загружено: ${files.map((f) => f.name).join(", ")}` :
              "Перетащите файлы или нажмите для загрузки"}
        </div>
        <div className="drop-hint">PDF, DOCX, TXT</div>
      </div>
      {result && !result.error && (
        <div className="upload-result">
          ✅ {result.filesProcessed?.join(", ")} — {result.totalChars} символов, {result.chunksCount} чанков
        </div>
      )}
      {result?.error && <div className="upload-error">❌ {result.error}</div>}
    </div>
  );
}

export function ServerManager({ servers = [], onChange }) {
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState({}); // id → { ok, models, error }

  const addServer = () => {
    onChange([...servers, {
      id: "srv_" + Math.random().toString(36).slice(2, 8),
      name: `Сервер ${servers.length + 1}`,
      url: "http://",
      provider: "ollama",
      model: "",
      maxConcurrent: 2,
      enabled: true
    }]);
  };

  const updateServer = (idx, field, value) => {
    const updated = [...servers];
    updated[idx] = { ...updated[idx], [field]: value };
    onChange(updated);
  };

  const removeServer = (idx) => {
    onChange(servers.filter((_, i) => i !== idx));
  };

  const checkAll = async () => {
    setChecking(true);
    try {
      const resp = await fetch("/api/servers", { method: "POST" });
      const data = await resp.json();
      const map = {};
      for (const r of data.results || []) {
        map[r.id] = { ok: r.ok, models: r.models || [], error: r.error };
      }
      setHealth(map);
    } catch { }
    setChecking(false);
  };

  const checkOne = async (srv) => {
    try {
      const resp = await fetch("/api/llm/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: srv.provider,
          baseUrl: srv.url,
          model: srv.model
        })
      });
      const data = await resp.json();
      setHealth(prev => ({
        ...prev,
        [srv.id]: { ok: data.ok, models: data.models || [], error: data.error }
      }));
    } catch (err) {
      setHealth(prev => ({
        ...prev,
        [srv.id]: { ok: false, models: [], error: err.message }
      }));
    }
  };

  return (
    <div className="server-manager">
      <div className="servers-header">
        <h4>🖥️ LLM Серверы</h4>
        <div className="servers-actions">
          <button type="button" className="btn btn-sm" onClick={checkAll} disabled={checking}>
            {checking ? "Проверка..." : "🔍 Проверить все"}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={addServer}>+ Сервер</button>
        </div>
      </div>

      {servers.map((srv, idx) => {
        const h = health[srv.id];
        return (
          <div key={srv.id} className={`server-row ${srv.enabled ? "" : "disabled"}`}>
            <input
              type="checkbox"
              checked={srv.enabled}
              onChange={(e) => updateServer(idx, "enabled", e.target.checked)}
            />
            <input
              className="srv-name"
              value={srv.name}
              onChange={(e) => updateServer(idx, "name", e.target.value)}
              placeholder="Имя"
            />
            <input
              className="srv-url"
              value={srv.url}
              onChange={(e) => updateServer(idx, "url", e.target.value)}
              placeholder="http://192.168.8.9:11434"
            />
            <select
              value={srv.provider}
              onChange={(e) => updateServer(idx, "provider", e.target.value)}
            >
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI</option>
            </select>

            {/* Model: dropdown if models available, text input otherwise */}
            {h?.models?.length > 0 ? (
              <select
                className="srv-model"
                value={srv.model}
                onChange={(e) => updateServer(idx, "model", e.target.value)}
              >
                <option value="">-- Выберите модель --</option>
                {h.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                className="srv-model"
                value={srv.model}
                onChange={(e) => updateServer(idx, "model", e.target.value)}
                placeholder="Модель (нажмите 🔍)"
              />
            )}

            <input
              className="srv-concurrent"
              type="number"
              min="1"
              max="8"
              value={srv.maxConcurrent || 2}
              onChange={(e) => updateServer(idx, "maxConcurrent", parseInt(e.target.value) || 2)}
              title="Макс. параллельных"
            />

            <button type="button" className="btn btn-sm" onClick={() => checkOne(srv)} title="Проверить сервер">
              🔍
            </button>

            <span className="srv-health">
              {h ? (h.ok ? `✅ ${h.models?.length || 0} моделей` : `❌ ${h.error || "Ошибка"}`) : ""}
            </span>

            <button type="button" className="btn-icon" onClick={() => removeServer(idx)}>✕</button>
          </div>
        );
      })}

      {servers.length === 0 && (
        <p style={{ color: "var(--text-muted)", padding: "12px", textAlign: "center" }}>
          Добавьте серверы для параллельной генерации
        </p>
      )}
    </div>
  );
}
