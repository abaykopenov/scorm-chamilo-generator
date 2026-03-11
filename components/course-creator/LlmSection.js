export function LlmSection({
  form,
  updateField,
  checkLocalLlm,
  llmStatus,
  isPending
}) {
  return (
    <div className="panel stack">
      <div className="tree-header">
        <h3>Локальная LLM</h3>
        <span className="meta">Можно генерировать курс через локальную модель, например Ollama на `127.0.0.1:11434`.</span>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="generationProvider">Провайдер</label>
          <select
            id="generationProvider"
            value={form.generationProvider}
            onChange={(event) => updateField("generationProvider", event.target.value)}
          >
            <option value="template">Шаблонный draft</option>
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="generationBaseUrl">Base URL</label>
          <input id="generationBaseUrl" value={form.generationBaseUrl} onChange={(event) => updateField("generationBaseUrl", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="generationModel">Model</label>
          <input id="generationModel" value={form.generationModel} onChange={(event) => updateField("generationModel", event.target.value)} />
          <span className="meta">Используйте текстовую модель (например `qwen2.5`, `llama`, `mistral`), не embedding.</span>
        </div>
        <div className="field">
          <label htmlFor="generationTemperature">Temperature</label>
          <input
            id="generationTemperature"
            type="number"
            min="0"
            max="1"
            step="0.1"
            value={form.generationTemperature}
            onChange={(event) => updateField("generationTemperature", event.target.value)}
          />
        </div>
      </div>
      <div className="actions">
        <button className="ghost-button" type="button" onClick={checkLocalLlm} disabled={isPending}>
          Проверить локальную LLM
        </button>
      </div>
      {llmStatus ? (
        <div className={llmStatus.ok ? "status success" : "status warning"}>
          {llmStatus.message}
        </div>
      ) : null}
    </div>
  );
}
