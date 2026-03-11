export function ExportSection({ chamilo, exportResult }) {
  return (
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
  );
}
