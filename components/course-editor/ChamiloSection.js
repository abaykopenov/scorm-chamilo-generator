import { formatDateTime } from "./utils";

export function ChamiloSection({
  chamilo,
  connectChamilo,
  publishToChamilo,
  publishTestToChamilo,
  exportAsXapi,
  setExportAsXapi,
  publishResult,
  testPublishResult,
  canPublishTest,
  isPending
}) {
  return (
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
        <button className="ghost-button" type="button" onClick={publishTestToChamilo} disabled={isPending || !canPublishTest}>
          Upload test only
        </button>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "12px", fontSize: "14px" }}>
          <input type="checkbox" checked={exportAsXapi} onChange={(e) => setExportAsXapi(e.target.checked)} />
          xAPI (Tin Can)
        </label>
      </div>
      {publishResult ? (
        <div className={publishResult.ok ? "status success" : "status warning"}>
          HTTP {publishResult.status}. Upload URL: {publishResult.uploadUrl}
          {publishResult.responseUrl ? ` -> ${publishResult.responseUrl}` : ""}
          {Number.isFinite(publishResult.attemptCount) ? ` | Attempts: ${publishResult.attemptCount}` : ""}
          {publishResult.message ? ` | ${publishResult.message}` : ""}
        </div>
      ) : null}
      {testPublishResult?.exercise ? (
        <div className={testPublishResult.exercise.ok ? "status success" : "status warning"}>
          Test upload: {testPublishResult.exercise.ok ? "ok" : "failed"}
          {testPublishResult.exercise.exerciseId ? ` | exerciseId=${testPublishResult.exercise.exerciseId}` : ""}
          {Number.isFinite(testPublishResult.exercise.questionCount) ? ` | questions=${testPublishResult.exercise.questionCount}` : ""}
          {testPublishResult.lpLinked
            ? (testPublishResult.lpLinked.ok
                ? ` | LP linked${testPublishResult.lpId ? ` (lpId=${testPublishResult.lpId})` : ""}`
                : ` | LP link failed: ${testPublishResult.lpLinked.error || "unknown reason"}`)
            : ""}
        </div>
      ) : null}
    </article>
  );
}
