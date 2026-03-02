"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

function deepClone(value) {
  return structuredClone(value);
}

function toSafeInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function summarize(course) {
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

function ensureQuestionCount(course, desiredCount) {
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

function createChamiloState(course) {
  return {
    baseUrl: course.integrations?.chamilo?.baseUrl || "",
    username: course.integrations?.chamilo?.username || "",
    password: "",
    courseCode: course.integrations?.chamilo?.courseCode || "",
    uploadPagePath: course.integrations?.chamilo?.uploadPagePath || "main/upload/index.php",
    loginPath: course.integrations?.chamilo?.loginPath || "/index.php"
  };
}

/* ─── Collapsible section component ─── */
function Section({ title, icon, badge, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="accordion-section">
      <button
        type="button"
        className="accordion-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="accordion-trigger-left">
          <span className="accordion-icon">{icon}</span>
          <span className="accordion-title">{title}</span>
          {badge ? <span className="accordion-badge">{badge}</span> : null}
        </span>
        <span className={`accordion-chevron ${open ? "open" : ""}`}>▾</span>
      </button>
      {open ? <div className="accordion-body">{children}</div> : null}
    </section>
  );
}

export function CourseEditor({ initialCourse }) {
  const [course, setCourse] = useState(initialCourse);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  const [chamiloCheck, setChamiloCheck] = useState(null);
  const [chamiloCourses, setChamiloCourses] = useState([]);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [courseList, setCourseList] = useState([]);
  const [structure, setStructure] = useState({
    moduleCount: course.modules.length,
    sectionsPerModule: course.modules[0]?.sections.length || 1,
    scosPerSection: course.modules[0]?.sections[0]?.scos.length || 1,
    screensPerSco: course.modules[0]?.sections[0]?.scos[0]?.screens.length || 1
  });
  const [chamilo, setChamilo] = useState(createChamiloState(initialCourse));
  const [selectedModule, setSelectedModule] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const summary = useMemo(() => summarize(course), [course]);

  // Load saved global settings on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((settings) => {
        if (settings.chamilo) {
          setChamilo((prev) => ({
            ...prev,
            baseUrl: prev.baseUrl || settings.chamilo.baseUrl || "",
            username: prev.username || settings.chamilo.username || "",
            password: settings.chamilo.password || "",
            courseCode: prev.courseCode || settings.chamilo.courseCode || ""
          }));
        }
        setSettingsLoaded(true);
      })
      .catch(() => setSettingsLoaded(true));
  }, []);

  // Auto-save chamilo settings when changed (after initial load)
  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = setTimeout(() => {
      fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chamilo })
      }).catch(() => { });
    }, 500);
    return () => clearTimeout(timer);
  }, [chamilo, settingsLoaded]);

  function updateCourse(mutator) {
    setCourse((current) => {
      const draft = deepClone(current);
      mutator(draft);
      return draft;
    });
  }

  function updateStructureField(key, value) {
    setStructure((current) => ({ ...current, [key]: toSafeInt(value, current[key], 1, 20) }));
  }

  function updateChamiloField(key, value) {
    setChamilo((current) => ({ ...current, [key]: value }));
    if (key === "password") {
      return;
    }

    updateCourse((draft) => {
      draft.integrations ||= {};
      draft.integrations.chamilo ||= {};
      draft.integrations.chamilo[key] = value;
    });
  }

  function saveCourse() {
    setError("");
    setMessage("");

    startTransition(async () => {
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
    });
  }

  function rebuildStructure() {
    setError("");
    setMessage("");

    startTransition(async () => {
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
    });
  }

  function exportScorm() {
    setError("");
    setMessage("");
    setExportResult(null);

    startTransition(async () => {
      const response = await fetch(`/api/courses/${course.id}/export-scorm`, {
        method: "POST"
      });

      if (!response.ok) {
        setError("Не удалось собрать SCORM-пакет.");
        return;
      }

      const exported = await response.json();
      setExportResult(exported);
      setMessage("SCORM-пакет собран.");
    });
  }

  function publishToChamilo() {
    setError("");
    setMessage("");
    setPublishResult(null);

    startTransition(async () => {
      const response = await fetch(`/api/courses/${course.id}/publish-chamilo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: chamilo
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || "Не удалось опубликовать пакет в Chamilo.");
        return;
      }

      setExportResult({
        exportId: payload.exportId,
        downloadUrl: payload.downloadUrl,
        manifestValid: payload.manifestValid,
        scoCount: payload.scoCount
      });
      setPublishResult(payload.published);
      setMessage(payload.published.ok ? "SCORM-пакет загружен в Chamilo." : "Chamilo ответил без подтверждения успеха.");
    });
  }

  function fetchChamiloCourses() {
    setChamiloCourses([]);
    setError("");
    setMessage("");

    startTransition(async () => {
      try {
        const response = await fetch("/api/chamilo/courses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: chamilo })
        });

        const payload = await response.json();
        if (payload.ok && payload.courses.length > 0) {
          setChamiloCourses(payload.courses);
          setMessage(`Найдено курсов: ${payload.courses.length}`);
        } else if (payload.ok) {
          setMessage("Подключение успешно, но курсы не найдены.");
        } else {
          setError(payload.error || "Не удалось получить список курсов.");
        }
      } catch {
        setError("Ошибка сети при загрузке списка курсов.");
      }
    });
  }

  function checkChamilo() {
    setChamiloCheck(null);
    setError("");
    setMessage("");

    startTransition(async () => {
      try {
        const response = await fetch(`/api/courses/${course.id}/check-chamilo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: chamilo })
        });

        const payload = await response.json();
        setChamiloCheck(payload);

        if (payload.ok) {
          setMessage(payload.message);
          // Also fetch courses list
          fetchChamiloCourses();
        } else {
          setError(payload.error || "Не удалось подключиться к Chamilo.");
        }
      } catch {
        setError("Ошибка сети при проверке подключения к Chamilo.");
      }
    });
  }

  function createExercise() {
    setMessage("");
    setError("");
    startTransition(async () => {
      try {
        const resp = await fetch(`/api/courses/${course.id}/create-exercise`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: chamilo })
        });
        const data = await resp.json();
        if (data.ok) {
          setMessage(`✓ Тест "${data.exerciseTitle}" создан в Chamilo! Вопросов: ${data.questionsCreated}/${data.totalQuestions}`);
        } else {
          setError(data.error || "Не удалось создать тест.");
        }
      } catch {
        setError("Ошибка сети при создании теста.");
      }
    });
  }

  return (
    <div className="editor-layout">
      {/* ─── Top Summary Bar ─── */}
      <header className="editor-topbar">
        <div className="topbar-left">
          <Link href="/" className="ghost-button" style={{ padding: "4px 10px", fontSize: "13px" }}>← Главная</Link>
          <select
            className="topbar-course-select"
            value={course.id}
            onChange={(event) => router.push(`/courses/${event.target.value}`)}
            onFocus={() => {
              if (courseList.length === 0) {
                fetch("/api/courses").then(r => r.json()).then(setCourseList).catch(() => { });
              }
            }}
          >
            <option value={course.id}>{course.title}</option>
            {courseList.filter(c => c.id !== course.id).map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>

        <div className="topbar-stats">
          <div className="stat-chip">
            <span className="stat-label">Модулей</span>
            <span className="stat-value">{course.modules.length}</span>
          </div>
          <div className="stat-chip">
            <span className="stat-label">Разделов</span>
            <span className="stat-value">{summary.sections}</span>
          </div>
          <div className="stat-chip">
            <span className="stat-label">SCO</span>
            <span className="stat-value">{summary.scos}</span>
          </div>
          <div className="stat-chip">
            <span className="stat-label">Экранов</span>
            <span className="stat-value">{summary.screens}</span>
          </div>
          <div className="stat-chip accent">
            <span className="stat-label">Pass</span>
            <span className="stat-value">{course.finalTest.passingScore}%</span>
          </div>
          <div className="stat-chip accent">
            <span className="stat-label">Попытки</span>
            <span className="stat-value">{course.finalTest.attemptsLimit}</span>
          </div>
          <div className="stat-chip accent">
            <span className="stat-label">Время</span>
            <span className="stat-value">{course.finalTest.maxTimeMinutes}м</span>
          </div>
        </div>

        <div className="topbar-actions">
          <button className="button" type="button" onClick={saveCourse} disabled={isPending}>
            {isPending ? "⏳" : "💾"} Сохранить
          </button>
          <button className="ghost-button" type="button" onClick={exportScorm} disabled={isPending}>
            📦 Экспорт SCORM
          </button>
        </div>
      </header>

      {/* ─── Status messages ─── */}
      {message ? <div className="status success">{message}</div> : null}
      {error ? <div className="status warning">{error}</div> : null}
      {exportResult ? (
        <div className="status success">
          Пакет собран. SCO: {exportResult.scoCount}. Manifest valid: {String(exportResult.manifestValid)}.
          {" "}
          <a className="link-button" href={exportResult.downloadUrl} style={{ display: "inline-flex", minHeight: "32px", padding: "0 12px", fontSize: "13px" }}>
            ⬇ Скачать ZIP
          </a>
        </div>
      ) : null}

      {/* ─── Collapsible sections ─── */}
      <div className="editor-sections">

        {/* ─── Description ─── */}
        <Section title="Описание курса" icon="📝" defaultOpen={true}>
          <div className="field">
            <label>Описание</label>
            <textarea
              value={course.description}
              onChange={(event) => updateCourse((draft) => {
                draft.description = event.target.value;
              })}
            />
          </div>
        </Section>

        {/* ─── Structure parameters ─── */}
        <Section title="Параметры структуры" icon="🏗️" badge={`${course.modules.length}×${structure.sectionsPerModule}×${structure.scosPerSection}×${structure.screensPerSco}`}>
          <p className="section-hint">Меняйте счетчики и применяйте перестройку без ручного редактирования JSON.</p>
          <div className="field-grid">
            <div className="field">
              <label>Модулей</label>
              <input type="number" min="1" max="20" value={structure.moduleCount} onChange={(event) => updateStructureField("moduleCount", event.target.value)} />
            </div>
            <div className="field">
              <label>Разделов на модуль</label>
              <input type="number" min="1" max="20" value={structure.sectionsPerModule} onChange={(event) => updateStructureField("sectionsPerModule", event.target.value)} />
            </div>
            <div className="field">
              <label>SCO на раздел</label>
              <input type="number" min="1" max="20" value={structure.scosPerSection} onChange={(event) => updateStructureField("scosPerSection", event.target.value)} />
            </div>
            <div className="field">
              <label>Экранов в SCO</label>
              <input type="number" min="1" max="20" value={structure.screensPerSco} onChange={(event) => updateStructureField("screensPerSco", event.target.value)} />
            </div>
          </div>
          <div className="actions" style={{ marginTop: "14px" }}>
            <button className="ghost-button" type="button" onClick={rebuildStructure} disabled={isPending}>
              🔄 Применить структуру
            </button>
          </div>
        </Section>

        {/* ─── Final Test ─── */}
        <Section title="Итоговый тест" icon="🎯" badge={course.finalTest.enabled ? `${course.finalTest.questions.length} вопросов` : "Откл"}>
          <p className="section-hint">Лимиты попыток и таймер сохраняются в runtime финального SCO.</p>
          <div className="field-grid">
            <div className="field">
              <label>Тест</label>
              <select
                value={course.finalTest.enabled ? "yes" : "no"}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.enabled = event.target.value === "yes";
                })}
              >
                <option value="yes">Включен</option>
                <option value="no">Отключен</option>
              </select>
            </div>
            <div className="field">
              <label>Вопросов</label>
              <input
                type="number" min="0" max="100"
                value={course.finalTest.questionCount}
                onChange={(event) => {
                  const count = Number(event.target.value);
                  setCourse((current) => ensureQuestionCount(current, count));
                }}
              />
            </div>
            <div className="field">
              <label>Passing score</label>
              <input
                type="number" min="0" max="100"
                value={course.finalTest.passingScore}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.passingScore = toSafeInt(event.target.value, draft.finalTest.passingScore, 0, 100);
                })}
              />
            </div>
            <div className="field">
              <label>Attempts</label>
              <input
                type="number" min="1" max="20"
                value={course.finalTest.attemptsLimit}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.attemptsLimit = toSafeInt(event.target.value, draft.finalTest.attemptsLimit, 1, 20);
                })}
              />
            </div>
            <div className="field">
              <label>Max time, мин</label>
              <input
                type="number" min="1" max="300"
                value={course.finalTest.maxTimeMinutes}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.maxTimeMinutes = toSafeInt(event.target.value, draft.finalTest.maxTimeMinutes, 1, 300);
                })}
              />
            </div>
          </div>

          {course.finalTest.questions.map((question, questionIndex) => (
            <div className="question-card" key={question.id}>
              <div className="question-card-header">
                <strong>Вопрос {questionIndex + 1}</strong>
                <span className="meta">correct: {question.correctOptionId}</span>
              </div>
              <div className="field">
                <label>Текст вопроса</label>
                <textarea
                  value={question.prompt}
                  onChange={(event) => updateCourse((draft) => {
                    draft.finalTest.questions[questionIndex].prompt = event.target.value;
                  })}
                />
              </div>
              <div className="inline-grid">
                {question.options.map((option, optionIndex) => (
                  <div className="field" key={option.id}>
                    <label>Вариант {optionIndex + 1}</label>
                    <input
                      value={option.text}
                      onChange={(event) => updateCourse((draft) => {
                        draft.finalTest.questions[questionIndex].options[optionIndex].text = event.target.value;
                      })}
                    />
                    <button
                      className={question.correctOptionId === option.id ? "button" : "ghost-button"}
                      type="button"
                      style={{ fontSize: "12px", minHeight: "32px", padding: "0 10px" }}
                      onClick={() => updateCourse((draft) => {
                        draft.finalTest.questions[questionIndex].correctOptionId = option.id;
                      })}
                    >
                      {question.correctOptionId === option.id ? "✓ Correct" : "Сделать правильным"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>

        {/* ─── Course Tree ─── */}
        <Section title="Дерево курса" icon="🌳" badge={`${course.modules.length} модулей`}>
          <div className="field">
            <label>Выберите модуль</label>
            <select
              value={selectedModule}
              onChange={(event) => setSelectedModule(Number(event.target.value))}
            >
              {course.modules.map((moduleItem, moduleIndex) => (
                <option key={moduleItem.id} value={moduleIndex}>
                  Модуль {moduleIndex + 1}: {moduleItem.title}
                </option>
              ))}
            </select>
          </div>

          {course.modules[selectedModule] ? (() => {
            const moduleItem = course.modules[selectedModule];
            const moduleIndex = selectedModule;
            return (
              <div className="tree">
                <div className="tree-card" data-level="module">
                  <div className="tree-header">
                    <strong>Module {moduleIndex + 1}</strong>
                  </div>
                  <div className="field">
                    <label>Название модуля</label>
                    <input
                      value={moduleItem.title}
                      onChange={(event) => updateCourse((draft) => {
                        draft.modules[moduleIndex].title = event.target.value;
                      })}
                    />
                  </div>
                  {moduleItem.sections.map((sectionItem, sectionIndex) => (
                    <div className="tree-card" data-level="section" key={sectionItem.id}>
                      <div className="tree-header">
                        <strong>Section {moduleIndex + 1}.{sectionIndex + 1}</strong>
                      </div>
                      <div className="field">
                        <label>Название раздела</label>
                        <input
                          value={sectionItem.title}
                          onChange={(event) => updateCourse((draft) => {
                            draft.modules[moduleIndex].sections[sectionIndex].title = event.target.value;
                          })}
                        />
                      </div>
                      {sectionItem.scos.map((sco, scoIndex) => (
                        <div className="tree-card" data-level="sco" key={sco.id}>
                          <div className="tree-header">
                            <strong>SCO {moduleIndex + 1}.{sectionIndex + 1}.{scoIndex + 1}</strong>
                          </div>
                          <div className="field">
                            <label>Название SCO</label>
                            <input
                              value={sco.title}
                              onChange={(event) => updateCourse((draft) => {
                                draft.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].title = event.target.value;
                              })}
                            />
                          </div>
                          {sco.screens.map((screen, screenIndex) => (
                            <div className="tree-card" data-level="screen" key={screen.id}>
                              <div className="tree-header">
                                <strong>Screen {screenIndex + 1}</strong>
                              </div>
                              <div className="field">
                                <label>Название экрана</label>
                                <input
                                  value={screen.title}
                                  onChange={(event) => updateCourse((draft) => {
                                    draft.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].screens[screenIndex].title = event.target.value;
                                  })}
                                />
                              </div>
                              <div className="field">
                                <label>Текст экрана</label>
                                <textarea
                                  value={screen.blocks[0]?.text ?? ""}
                                  onChange={(event) => updateCourse((draft) => {
                                    draft.modules[moduleIndex].sections[sectionIndex].scos[scoIndex].screens[screenIndex].blocks[0] = {
                                      type: "text",
                                      text: event.target.value
                                    };
                                  })}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          })() : null}
        </Section>

        {/* ─── Export ─── */}
        <Section title="Экспорт SCORM" icon="📦">
          <p className="section-hint">
            Каждый SCO будет добавлен в <code>imsmanifest.xml</code> как отдельный <code>resource/item</code>.
            Итоговый тест идет последним SCO.
          </p>
          <div className="actions">
            <button className="link-button" type="button" onClick={exportScorm} disabled={isPending}>
              📦 Экспортировать SCORM-пакет
            </button>
          </div>
          {exportResult ? (
            <>
              <div className="status success" style={{ marginTop: "12px" }}>
                Пакет собран. SCO: {exportResult.scoCount}. Manifest valid: {String(exportResult.manifestValid)}.
              </div>
              <a className="button" href={exportResult.downloadUrl} style={{ marginTop: "8px" }}>
                ⬇ Скачать ZIP
              </a>
            </>
          ) : (
            <div className="status" style={{ marginTop: "12px" }}>После экспорта здесь появится ссылка на готовый SCORM 1.2 ZIP.</div>
          )}
        </Section>

        {/* ─── Chamilo ─── */}
        <Section title="Публикация в Chamilo" icon="🚀">
          <div className="field-grid">
            <div className="field">
              <label>IP / URL</label>
              <input placeholder="http://192.168.8.179/chamilo" value={chamilo.baseUrl} onChange={(event) => updateChamiloField("baseUrl", event.target.value)} />
            </div>
            <div className="field">
              <label>Логин</label>
              <input placeholder="admin" value={chamilo.username} onChange={(event) => updateChamiloField("username", event.target.value)} />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input type="password" placeholder="••••" value={chamilo.password} onChange={(event) => updateChamiloField("password", event.target.value)} />
            </div>
            <div className="field">
              <label>Курс</label>
              {chamiloCourses.length > 0 ? (
                <select
                  value={chamilo.courseCode}
                  onChange={(event) => updateChamiloField("courseCode", event.target.value)}
                >
                  <option value="">— Выберите курс —</option>
                  {chamiloCourses.map((c) => (
                    <option key={c.code} value={c.code}>{c.title} ({c.code})</option>
                  ))}
                </select>
              ) : (
                <input placeholder="TEST" value={chamilo.courseCode} onChange={(event) => updateChamiloField("courseCode", event.target.value)} />
              )}
            </div>
          </div>

          <div className="actions" style={{ marginTop: "14px" }}>
            <button className="ghost-button" type="button" onClick={checkChamilo} disabled={isPending}>
              🔌 Проверить
            </button>
            <button className="ghost-button" type="button" onClick={fetchChamiloCourses} disabled={isPending}>
              📋 Курсы
            </button>
            <button className="button" type="button" onClick={publishToChamilo} disabled={isPending}>
              🚀 Опубликовать в Chamilo
            </button>
          </div>

          {chamiloCheck ? (
            <div className={chamiloCheck.ok ? "status success" : "status warning"} style={{ marginTop: "12px" }}>
              {chamiloCheck.ok ? "✓ " : "✗ "}
              {chamiloCheck.message || chamiloCheck.error}
            </div>
          ) : null}

          {publishResult ? (
            <>
              <div className={publishResult.ok ? "status success" : "status warning"} style={{ marginTop: "12px" }}>
                {publishResult.ok ? "✓ SCORM загружен" : "✗ Ошибка SCORM"} — HTTP {publishResult.status}
              </div>
              {publishResult.exercise ? (
                <div className={publishResult.exercise.ok ? "status success" : "status warning"} style={{ marginTop: "6px" }}>
                  {publishResult.exercise.ok
                    ? `✓ Тест "${publishResult.exercise.exerciseTitle}" создан (ID: ${publishResult.exercise.exerciseId}). Вопросов: ${publishResult.exercise.questionsCreated}/${publishResult.exercise.totalQuestions}`
                    : `✗ Тест: ${publishResult.exercise.error}`}
                </div>
              ) : null}
              {publishResult.lpLinked ? (
                <div className={publishResult.lpLinked.ok ? "status success" : "status warning"} style={{ marginTop: "6px" }}>
                  {publishResult.lpLinked.ok
                    ? "✓ Тест добавлен в learning path"
                    : `✗ LP: ${publishResult.lpLinked.error || "ошибка"}`}
                </div>
              ) : null}
            </>
          ) : null}
        </Section>

      </div>
    </div>
  );
}
