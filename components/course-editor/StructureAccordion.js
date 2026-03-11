export function StructureAccordion({ structure, updateStructureField }) {
  return (
    <details className="accordion-panel" open>
      <summary>
        <span>Параметры структуры</span>
        <small>Модули, разделы, SCO и экраны</small>
      </summary>
      <div className="accordion-body">
        <div className="field-grid">
          <div className="field">
            <label htmlFor="editor-module-count">Модулей</label>
            <input id="editor-module-count" type="number" min="1" max="20" value={structure.moduleCount} onChange={(event) => updateStructureField("moduleCount", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="editor-sections-per-module">Разделов на модуль</label>
            <input id="editor-sections-per-module" type="number" min="1" max="20" value={structure.sectionsPerModule} onChange={(event) => updateStructureField("sectionsPerModule", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="editor-scos-per-section">SCO на раздел</label>
            <input id="editor-scos-per-section" type="number" min="1" max="20" value={structure.scosPerSection} onChange={(event) => updateStructureField("scosPerSection", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="editor-screens-per-sco">Экранов в SCO</label>
            <input id="editor-screens-per-sco" type="number" min="1" max="20" value={structure.screensPerSco} onChange={(event) => updateStructureField("screensPerSco", event.target.value)} />
          </div>
        </div>
      </div>
    </details>
  );
}
