import { formatFileSize } from "./utils";

export function MaterialsSection({
  materials,
  selectedMaterialIds,
  toggleMaterialSelection,
  onFilesPicked,
  uploadSelectedFiles,
  indexSelectedMaterials,
  refreshMaterials,
  checkQdrantStatus,
  isPending,
  selectedFiles,
  materialsMessage,
  qdrantStatus,
  expandedMaterialId,
  toggleMaterialChunks,
  deleteMaterialById,
  materialChunksState,
  loadMaterialChunks,
  setExpandedMaterialId,
  fileInputRef,
  form,
  updateField
}) {
  return (
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
        <label htmlFor="rag-files" className="label-with-help">
          <span>Upload files</span>
          <button
            type="button"
            className="help-icon"
            aria-label="Upload limits"
            title="Upload limits"
          >
            ?
          </button>
          <span className="help-tooltip">
            Up to 10 files per upload, 50 MB maximum per file.
          </span>
        </label>
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
          onClick={refreshMaterials}
          disabled={isPending}
        >
          Обновить список
        </button>
        <button className="link-button" type="button" onClick={checkQdrantStatus} disabled={isPending || qdrantStatus.loading}>
          Check Qdrant
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

      <div className={qdrantStatus.ok ? "status success" : "status warning"}>
        <strong>Vector DB (Qdrant): </strong>
        {qdrantStatus.loading ? "checking..." : qdrantStatus.mode}
        {". "}
        {qdrantStatus.message}
        {qdrantStatus.target?.baseUrl ? ` (${qdrantStatus.target.baseUrl})` : ""}
      </div>

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
                  {formatFileSize(material.size)} - {material.status} - chunks: {material.chunksCount || 0}
                </span>
                {material.errorMessage ? <span className="status warning">{material.errorMessage}</span> : null}
                <div className="material-item-actions">
                  <button
                    type="button"
                    className="ghost-button compact-button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleMaterialChunks(material.id);
                    }}
                    disabled={isPending || material.status !== "indexed"}
                    title={material.status === "indexed" ? "" : "Index material first"}
                  >
                    {expandedMaterialId === material.id ? "Hide chunks" : "Show chunks"}
                  </button>
                  <button
                    type="button"
                    className="delete-button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      deleteMaterialById(material.id);
                    }}
                    disabled={isPending}
                  >
                    Delete file
                  </button>
                </div>

                {expandedMaterialId === material.id ? (
                  <div
                    className="chunks-viewer"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {materialChunksState[material.id]?.loading && !(materialChunksState[material.id]?.items?.length > 0) ? (
                      <div className="status">Loading chunks...</div>
                    ) : null}

                    {materialChunksState[material.id]?.error ? (
                      <div className="status warning">{materialChunksState[material.id].error}</div>
                    ) : null}

                    {materialChunksState[material.id]?.items?.length > 0 ? (
                      <div className="chunk-preview-list">
                        {materialChunksState[material.id].items.map((chunk) => (
                          <article key={chunk.id || ("chunk-" + chunk.order)} className="chunk-preview-item">
                            <div className="chunk-preview-head">
                              <strong>Chunk #{chunk.order || "?"}</strong>
                              <span className="meta">{chunk.length || 0} chars</span>
                            </div>
                            <p>
                              {chunk.preview}
                              {chunk.truncated ? "..." : ""}
                            </p>
                          </article>
                        ))}
                      </div>
                    ) : null}

                    {!materialChunksState[material.id]?.loading &&
                    !materialChunksState[material.id]?.error &&
                    !(materialChunksState[material.id]?.items?.length > 0) ? (
                      <p className="note">Chunks not found. Run indexing first.</p>
                    ) : null}

                    <div className="material-item-actions">
                      {materialChunksState[material.id]?.hasMore ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            loadMaterialChunks(material.id, { append: true });
                          }}
                          disabled={isPending || materialChunksState[material.id]?.loading}
                        >
                          Show more
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="link-button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setExpandedMaterialId("");
                        }}
                      >
                        Collapse
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
