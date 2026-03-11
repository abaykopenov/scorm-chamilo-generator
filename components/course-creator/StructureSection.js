export function StructureSection({ form, updateField }) {
  return (
    <div className="panel">
      <div className="tree-header">
        <h3>Структура курса</h3>
        <span className="meta">
          Параметры иерархии <code>Course -&gt; Module -&gt; Section -&gt; SCO -&gt; Screen</code>
        </span>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="moduleCount">Модулей</label>
          <input id="moduleCount" type="number" min="1" max="20" value={form.moduleCount} onChange={(event) => updateField("moduleCount", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sectionsPerModule">Разделов на модуль</label>
          <input id="sectionsPerModule" type="number" min="1" max="20" value={form.sectionsPerModule} onChange={(event) => updateField("sectionsPerModule", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="scosPerSection">SCO на раздел</label>
          <input id="scosPerSection" type="number" min="1" max="20" value={form.scosPerSection} onChange={(event) => updateField("scosPerSection", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="screensPerSco">Экранов в SCO</label>
          <input id="screensPerSco" type="number" min="1" max="20" value={form.screensPerSco} onChange={(event) => updateField("screensPerSco", event.target.value)} />
        </div>
      </div>
    </div>
  );
}
