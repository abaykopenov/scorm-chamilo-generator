export function DashboardSummary({ course, summary }) {
  return (
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
  );
}
