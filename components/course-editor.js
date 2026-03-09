"use client";

import { useMemo, useState, useTransition } from "react";

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

function parseChamiloBaseUrl(baseUrl) {
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

function buildChamiloBaseUrl(protocol, host) {
  const cleanHost = `${host || ""}`.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!cleanHost) {
    return "";
  }
  return `${protocol || "http"}://${cleanHost}`;
}

function formatDateTime(value) {
  if (!value) {
    return "еще не проверялось";
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
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

export function CourseEditor({ initialCourse }) {
  const [course, setCourse] = useState(initialCourse);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  const [isPending, startTransition] = useTransition();
  const [regenerationTarget, setRegenerationTarget] = useState("");
  const [structure, setStructure] = useState({
    moduleCount: course.modules.length,
    sectionsPerModule: course.modules[0]?.sections.length || 1,
    scosPerSection: course.modules[0]?.sections[0]?.scos.length || 1,
    screensPerSco: course.modules[0]?.sections[0]?.scos[0]?.screens.length || 1
  });
  const [chamilo, setChamilo] = useState(createChamiloState(initialCourse));
  const summary = useMemo(() => summarize(course), [course]);

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
    const nextState = (() => {
      if (key === "host" || key === "protocol") {
        return {
          ...chamilo,
          [key]: value,
          baseUrl: buildChamiloBaseUrl(key === "protocol" ? value : chamilo.protocol, key === "host" ? value : chamilo.host)
        };
      }
      return {
        ...chamilo,
        [key]: value
      };
    })();

    setChamilo(nextState);
    if (key === "password") {
      return;
    }

    updateCourse((draft) => {
      draft.integrations ||= {};
      draft.integrations.chamilo ||= {};
      if (key === "host" || key === "protocol") {
        draft.integrations.chamilo.baseUrl = nextState.baseUrl;
        return;
      }
      if (key === "courses") {
        return;
      }
      draft.integrations.chamilo[key] = value;
    });
  }

  function syncChamiloStateFromProfile(profile, availableCourses = null) {
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

  async function regenerateModule(moduleIndex) {
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
  }

  async function regenerateScreen(moduleIndex, sectionIndex, scoIndex, screenIndex) {
    setError("");
    setMessage("");
    const target = ["screen", moduleIndex, sectionIndex, scoIndex, screenIndex].join(":");
    setRegenerationTarget(target);

    try {
      const response = await fetch(`/api/courses/${course.id}/regenerate-screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleIndex,
          sectionIndex,
          scoIndex,
          screenIndex
        })
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
      setMessage("SCORM-пакет собран локально. Он не отправлен в Chamilo, пока вы не нажмете публикацию.");
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
        if (payload.published) {
          setPublishResult(payload.published);
        }
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
    });
  }

  function connectChamilo() {
    setError("");
    setMessage("");
    setPublishResult(null);

    startTransition(async () => {
      const response = await fetch(`/api/courses/${course.id}/connect-chamilo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: chamilo
        })
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
    });
  }

  return (
    <div className="editor-shell stack">
      <section className="panel stack">
        <div className="course-header">
          <div className="stack">
            <span className="eyebrow">Editor</span>
            <input
              className="course-title"
              value={course.title}
              onChange={(event) => updateCourse((draft) => {
                draft.title = event.target.value;
              })}
            />
            <textarea
              value={course.description}
              onChange={(event) => updateCourse((draft) => {
                draft.description = event.target.value;
              })}
            />
          </div>
          <div className="actions">
            <button className="button" type="button" onClick={saveCourse} disabled={isPending}>
              {isPending ? "Обработка..." : "Сохранить"}
            </button>
            <button className="ghost-button" type="button" onClick={rebuildStructure} disabled={isPending}>
              Обновить структуру
            </button>
            <button className="link-button" type="button" onClick={exportScorm} disabled={isPending}>
              Экспорт SCORM
            </button>
          </div>
        </div>
        {message ? <div className="status success">{message}</div> : null}
        {error ? <div className="status warning">{error}</div> : null}
      </section>

      <section className="dashboard-grid">
        <article className="panel stack compact-panel">
          <div className="tree-header">
            <h3>Сводка</h3>
            <span className="meta">Ключевые параметры курса</span>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span>Модулей</span>
              <strong>{course.modules.length}</strong>
            </div>
            <div className="metric-card">
              <span>Разделов</span>
              <strong>{summary.sections}</strong>
            </div>
            <div className="metric-card">
              <span>SCO</span>
              <strong>{summary.scos}</strong>
            </div>
            <div className="metric-card">
              <span>Экранов</span>
              <strong>{summary.screens}</strong>
            </div>
            <div className="metric-card">
              <span>Passing score</span>
              <strong>{course.finalTest.passingScore}%</strong>
            </div>
            <div className="metric-card">
              <span>Attempts</span>
              <strong>{course.finalTest.attemptsLimit}</strong>
            </div>
            <div className="metric-card">
              <span>RAG источники</span>
              <strong>{Array.isArray(course.sourceDocuments) ? course.sourceDocuments.length : 0}</strong>
            </div>
          </div>
        </article>

        <article className="panel stack compact-panel">
          <div className="tree-header">
            <h3>Экспорт</h3>
            <span className="meta">ZIP создается локально</span>
          </div>
          <div className="status">
            {chamilo.baseUrl
              ? `Адрес публикации Chamilo: ${chamilo.baseUrl}`
              : "Адрес Chamilo еще не указан."}
          </div>
          {exportResult ? (
            <>
              <div className="status success">
                ZIP собран локально. SCO: {exportResult.scoCount}. Manifest valid: {String(exportResult.manifestValid)}.
              </div>
              <div className="actions">
                <a className="button" href={exportResult.downloadUrl}>
                  Скачать ZIP
                </a>
              </div>
            </>
          ) : (
            <div className="status">Сначала нажмите “Экспорт SCORM”, если хотите скачать архив вручную.</div>
          )}
        </article>

        <article className="panel stack compact-panel">
          <div className="tree-header">
            <h3>Chamilo</h3>
            <span className="meta">{chamilo.baseUrl || "не подключено"}</span>
          </div>
          <div className={`status ${chamilo.lastConnectionStatus === "connected" ? "success" : chamilo.lastConnectionStatus === "failed" ? "warning" : ""}`}>
            {chamilo.lastConnectionStatus === "connected"
              ? `Подключено: ${chamilo.lastConnectionMessage}`
              : chamilo.lastConnectionStatus === "failed"
                ? `Ошибка: ${chamilo.lastConnectionMessage}`
                : "Подключение еще не проверялось."}
          </div>
          <div className="meta">Последняя проверка: {formatDateTime(chamilo.lastConnectedAt)}</div>
          <div className="actions">
            <button className="ghost-button" type="button" onClick={connectChamilo} disabled={isPending}>
              Проверить Chamilo
            </button>
            <button className="button" type="button" onClick={publishToChamilo} disabled={isPending || !chamilo.baseUrl}>
              Отправить в Chamilo
            </button>
          </div>
          {publishResult ? (
            <div className={publishResult.ok ? "status success" : "status warning"}>
              HTTP {publishResult.status}. Upload URL: {publishResult.uploadUrl}
              {publishResult.responseUrl ? ` -> ${publishResult.responseUrl}` : ""}
              {Number.isFinite(publishResult.attemptCount) ? ` | Attempts: ${publishResult.attemptCount}` : ""}
              {publishResult.message ? ` | ${publishResult.message}` : ""}
            </div>
          ) : null}
        </article>
      </section>

      <details className="accordion-panel" open>
        <summary>
          <span>Параметры структуры</span>
          <small>Модули, разделы, SCO и экраны</small>
        </summary>
        <div className="accordion-body">
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
        </div>
      </details>

      <details className="accordion-panel">
        <summary>
          <span>Итоговый тест</span>
          <small>Проходной балл, попытки, таймер и вопросы</small>
        </summary>
        <div className="accordion-body stack">
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
                type="number"
                min="0"
                max="100"
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
                type="number"
                min="0"
                max="100"
                value={course.finalTest.passingScore}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.passingScore = toSafeInt(event.target.value, draft.finalTest.passingScore, 0, 100);
                })}
              />
            </div>
            <div className="field">
              <label>Attempts</label>
              <input
                type="number"
                min="1"
                max="20"
                value={course.finalTest.attemptsLimit}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.attemptsLimit = toSafeInt(event.target.value, draft.finalTest.attemptsLimit, 1, 20);
                })}
              />
            </div>
            <div className="field">
              <label>Max time, мин</label>
              <input
                type="number"
                min="1"
                max="300"
                value={course.finalTest.maxTimeMinutes}
                onChange={(event) => updateCourse((draft) => {
                  draft.finalTest.maxTimeMinutes = toSafeInt(event.target.value, draft.finalTest.maxTimeMinutes, 1, 300);
                })}
              />
            </div>
          </div>

          {course.finalTest.questions.map((question, questionIndex) => (
            <details className="nested-accordion" key={question.id} open={questionIndex === 0}>
              <summary>
                <span>Вопрос {questionIndex + 1}</span>
                <small>Правильный ответ: {question.correctOptionId}</small>
              </summary>
              <div className="accordion-body">
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
                        onClick={() => updateCourse((draft) => {
                          draft.finalTest.questions[questionIndex].correctOptionId = option.id;
                        })}
                      >
                        {question.correctOptionId === option.id ? "Correct" : "Сделать правильным"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ))}
        </div>
      </details>

      <details className="accordion-panel">
        <summary>
          <span>Подключение Chamilo</span>
          <small>IP, логин, пароль и выбор курса</small>
        </summary>
        <div className="accordion-body stack">
          <div className="field-grid">
            <div className="field">
              <label>Protocol</label>
              <select value={chamilo.protocol} onChange={(event) => updateChamiloField("protocol", event.target.value)}>
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>
            <div className="field">
              <label>Chamilo IP / Host</label>
              <input placeholder="192.168.1.50/chamilo" value={chamilo.host} onChange={(event) => updateChamiloField("host", event.target.value)} />
            </div>
            <div className="field">
              <label>Resolved base URL</label>
              <input value={chamilo.baseUrl} readOnly />
            </div>
            <div className="field">
              <label>Username</label>
              <input value={chamilo.username} onChange={(event) => updateChamiloField("username", event.target.value)} />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={chamilo.password} onChange={(event) => updateChamiloField("password", event.target.value)} />
            </div>
            <div className="field">
              <label>Курс в Chamilo</label>
              <select value={chamilo.courseCode} onChange={(event) => updateChamiloField("courseCode", event.target.value)}>
                <option value="">Сначала проверьте подключение</option>
                {chamilo.courses.map((courseOption) => (
                  <option key={courseOption.code} value={courseOption.code}>
                    {courseOption.title} ({courseOption.code})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Course code (manual)</label>
              <input
                placeholder="COURSE_CODE"
                value={chamilo.courseCode}
                onChange={(event) => updateChamiloField("courseCode", event.target.value)}
              />
            </div>
          </div>
          <div className="actions">
            <button className="ghost-button" type="button" onClick={connectChamilo} disabled={isPending}>
              Проверить Chamilo
            </button>
            <button className="button" type="button" onClick={publishToChamilo} disabled={isPending || !chamilo.baseUrl || !chamilo.courseCode}>
              Экспортировать и отправить в Chamilo
            </button>
          </div>
          <div className="status">
            После проверки загрузится список доступных курсов. Пароль не сохраняется в JSON курса.
          </div>
        </div>
      </details>

      <details className="accordion-panel" open>
        <summary>
          <span>Содержимое курса</span>
          <small>Модули открываются по клику</small>
        </summary>
        <div className="accordion-body">
          <div className="tree compact-tree">
            {course.modules.map((moduleItem, moduleIndex) => (
              <details className="nested-accordion module-accordion" key={moduleItem.id} open={moduleIndex === 0}>
                <summary>
                  <span>{moduleItem.title || `Модуль ${moduleIndex + 1}`}</span>
                  <small>{moduleItem.sections.length} разделов</small>
                </summary>
                <div className="accordion-body stack">
                  <div className="field">
                    <label>Название модуля</label>
                    <input
                      value={moduleItem.title}
                      onChange={(event) => updateCourse((draft) => {
                        draft.modules[moduleIndex].title = event.target.value;
                      })}
                    />
                  </div>
                  <div className="actions">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => regenerateModule(moduleIndex)}
                      disabled={isPending || Boolean(regenerationTarget)}
                    >
                      {regenerationTarget === "module:" + moduleIndex ? "Regenerating module..." : "Regenerate this module"}
                    </button>
                  </div>
                  {moduleItem.sections.map((sectionItem, sectionIndex) => (
                    <details className="nested-accordion" key={sectionItem.id}>
                      <summary>
                        <span>{sectionItem.title || `Раздел ${moduleIndex + 1}.${sectionIndex + 1}`}</span>
                        <small>{sectionItem.scos.length} SCO</small>
                      </summary>
                      <div className="accordion-body stack">
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
                          <details className="nested-accordion" key={sco.id}>
                            <summary>
                              <span>{sco.title || `SCO ${moduleIndex + 1}.${sectionIndex + 1}.${scoIndex + 1}`}</span>
                              <small>{sco.screens.length} экранов</small>
                            </summary>
                            <div className="accordion-body stack">
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
                                <details className="nested-accordion" key={screen.id}>
                                  <summary>
                                    <span>{screen.title || `Экран ${screenIndex + 1}`}</span>
                                    <small>редактирование контента</small>
                                  </summary>
                                  <div className="accordion-body">
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
                                    <div className="actions">
                                      <button
                                        className="ghost-button"
                                        type="button"
                                        onClick={() => regenerateScreen(moduleIndex, sectionIndex, scoIndex, screenIndex)}
                                        disabled={isPending || Boolean(regenerationTarget)}
                                      >
                                        {regenerationTarget === ["screen", moduleIndex, sectionIndex, scoIndex, screenIndex].join(":")
                                          ? "Regenerating screen..."
                                          : "Regenerate this screen"}
                                      </button>
                                    </div>
                                  </div>
                                </details>
                              ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

