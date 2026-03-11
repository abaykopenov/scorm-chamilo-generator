export function TestSection({ form, updateField }) {
  return (
    <div className="panel">
      <div className="tree-header">
        <h3>Итоговый тест</h3>
        <span className="meta">Попытки и время будут контролироваться внутри SCORM-пакета.</span>
      </div>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="finalTestEnabled">Тест</label>
          <select
            id="finalTestEnabled"
            value={form.finalTestEnabled ? "yes" : "no"}
            onChange={(event) => updateField("finalTestEnabled", event.target.value === "yes")}
          >
            <option value="yes">Включен</option>
            <option value="no">Отключен</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="questionCount">Вопросов</label>
          <input id="questionCount" type="number" min="0" max="100" value={form.questionCount} onChange={(event) => updateField("questionCount", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="passingScore">Passing score</label>
          <input id="passingScore" type="number" min="0" max="100" value={form.passingScore} onChange={(event) => updateField("passingScore", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="attemptsLimit">Attempts</label>
          <input id="attemptsLimit" type="number" min="1" max="20" value={form.attemptsLimit} onChange={(event) => updateField("attemptsLimit", event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="maxTimeMinutes">Max time, мин</label>
          <input id="maxTimeMinutes" type="number" min="1" max="300" value={form.maxTimeMinutes} onChange={(event) => updateField("maxTimeMinutes", event.target.value)} />
        </div>
      </div>
    </div>
  );
}
