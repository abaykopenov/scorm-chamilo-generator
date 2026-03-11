"use client";

import { useMemo, useTransition } from "react";
import { useEditorState } from "./course-editor/hooks/use-editor-state";
import { useEditorActions } from "./course-editor/hooks/use-editor-actions";
import { formatDateTime } from "./course-editor/utils";

import { DashboardSummary } from "./course-editor/DashboardSummary";
import { ExportSection } from "./course-editor/ExportSection";
import { ChamiloSection } from "./course-editor/ChamiloSection";
import { StructureAccordion } from "./course-editor/StructureAccordion";
import { FinalTestAccordion } from "./course-editor/FinalTestAccordion";
import { ChamiloAccordion } from "./course-editor/ChamiloAccordion";
import { CourseContentAccordion } from "./course-editor/CourseContentAccordion";

export function CourseEditor({ initialCourse }) {
  const [isPending, startTransition] = useTransition();
  
  const {
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
    chamilo,
    summary,
    updateCourse,
    updateStructureField,
    updateChamiloField,
    syncChamiloStateFromProfile
  } = useEditorState(initialCourse);

  const {
    saveCourse,
    rebuildStructure,
    regenerateModule,
    regenerateScreen,
    exportScorm,
    publishToChamilo,
    publishTestToChamilo,
    connectChamilo
  } = useEditorActions({
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
    structure,
    syncChamiloStateFromProfile,
    startTransition
  });

  const canPublishTest = useMemo(() => Boolean(
    chamilo.baseUrl &&
    chamilo.courseCode &&
    course.finalTest?.enabled &&
    Array.isArray(course.finalTest?.questions) &&
    course.finalTest.questions.length > 0
  ), [chamilo.baseUrl, chamilo.courseCode, course.finalTest]);

  return (
    <div className="editor-shell stack">
      <section className="panel stack">
        <div className="course-header">
          <div className="stack">
            <span className="eyebrow">Editor</span>
            <input
              id="course-title-input"
              className="course-title"
              value={course.title}
              onChange={(event) => updateCourse((draft) => {
                draft.title = event.target.value;
              })}
            />
            <textarea
              id="course-description-input"
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
              {exportAsXapi ? "Экспорт xAPI" : "Экспорт SCORM"}
            </button>
          </div>
        </div>
        {message ? <div className="status success">{message}</div> : null}
        {error ? <div className="status warning">{error}</div> : null}
      </section>

      <section className="dashboard-grid">
        <DashboardSummary course={course} summary={summary} />
        <ExportSection chamilo={chamilo} exportResult={exportResult} />
        <ChamiloSection
          chamilo={chamilo}
          connectChamilo={connectChamilo}
          publishToChamilo={publishToChamilo}
          publishTestToChamilo={publishTestToChamilo}
          exportAsXapi={exportAsXapi}
          setExportAsXapi={setExportAsXapi}
          publishResult={publishResult}
          testPublishResult={testPublishResult}
          canPublishTest={canPublishTest}
          isPending={isPending}
        />
      </section>

      <StructureAccordion structure={structure} updateStructureField={updateStructureField} />
      
      <FinalTestAccordion course={course} setCourse={setCourse} updateCourse={updateCourse} />

      <ChamiloAccordion
        chamilo={chamilo}
        updateChamiloField={updateChamiloField}
        connectChamilo={connectChamilo}
        publishToChamilo={publishToChamilo}
        publishTestToChamilo={publishTestToChamilo}
        exportAsXapi={exportAsXapi}
        setExportAsXapi={setExportAsXapi}
        canPublishTest={canPublishTest}
        isPending={isPending}
      />

      <CourseContentAccordion
        course={course}
        updateCourse={updateCourse}
        regenerateModule={regenerateModule}
        regenerateScreen={regenerateScreen}
        regenerationTarget={regenerationTarget}
        isPending={isPending}
      />
    </div>
  );
}
滋滋
