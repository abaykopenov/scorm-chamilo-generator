import { formatDateTime } from "./utils";

export function HistorySection({
  historyVisible,
  setHistoryVisible,
  hideCompletedHistory,
  setHideCompletedHistory,
  historyLoading,
  refreshGenerationHistory,
  generationHistory,
  generationProgress,
}) {
  const visibleGenerationHistory = hideCompletedHistory
    ? generationHistory.filter((item) => item?.generationStatus !== "completed")
    : generationHistory;

  return (
    <div className="panel stack">
      <div className="tree-header">
        <h3>Generation history</h3>
        <div className="actions">
          <button
            className="link-button"
            type="button"
            onClick={() => setHistoryVisible((current) => !current)}
            disabled={generationProgress.active}
          >
            {historyVisible ? "Hide history" : "Show history"}
          </button>
          <button
            className="link-button"
            type="button"
            onClick={() => setHideCompletedHistory((current) => !current)}
            disabled={generationProgress.active || !historyVisible}
          >
            {hideCompletedHistory ? "Show completed" : "Hide completed"}
          </button>
          <button
            className="link-button"
            type="button"
            onClick={refreshGenerationHistory}
            disabled={historyLoading || generationProgress.active}
          >
            {historyLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {!historyVisible ? (
        <p className="note">Generation history is hidden.</p>
      ) : visibleGenerationHistory.length === 0 ? (
        <p className="note">
          {generationHistory.length === 0
            ? "No generated courses yet."
            : "All completed generations are hidden."}
        </p>
      ) : (
        <div className="generation-history-list">
          {visibleGenerationHistory.map((historyItem) => (
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
  );
}
