export function ChamiloAccordion({
  chamilo,
  updateChamiloField,
  connectChamilo,
  publishToChamilo,
  publishTestToChamilo,
  exportAsXapi,
  setExportAsXapi,
  canPublishTest,
  isPending
}) {
  return (
    <details className="accordion-panel">
      <summary>
        <span>Подключение Chamilo</span>
        <small>IP, логин, пароль и выбор курса</small>
      </summary>
      <div className="accordion-body stack">
        <div className="field-grid">
          <div className="field">
            <label htmlFor="chamilo-protocol">Protocol</label>
            <select id="chamilo-protocol" value={chamilo.protocol} onChange={(event) => updateChamiloField("protocol", event.target.value)}>
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="chamilo-host">Chamilo IP / Host</label>
            <input id="chamilo-host" placeholder="192.168.1.50/chamilo" value={chamilo.host} onChange={(event) => updateChamiloField("host", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="chamilo-base-url">Resolved base URL</label>
            <input id="chamilo-base-url" value={chamilo.baseUrl} readOnly />
          </div>
          <div className="field">
            <label htmlFor="chamilo-username">Username</label>
            <input id="chamilo-username" value={chamilo.username} onChange={(event) => updateChamiloField("username", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="chamilo-password">Password</label>
            <input id="chamilo-password" type="password" value={chamilo.password} onChange={(event) => updateChamiloField("password", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="chamilo-course-code-select">Курс в Chamilo</label>
            <select id="chamilo-course-code-select" value={chamilo.courseCode} onChange={(event) => updateChamiloField("courseCode", event.target.value)}>
              <option value="">Сначала проверьте подключение</option>
              {chamilo.courses.map((courseOption) => (
                <option key={courseOption.code} value={courseOption.code}>
                  {courseOption.title} ({courseOption.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="chamilo-course-code-manual">Course code (manual)</label>
            <input
              id="chamilo-course-code-manual"
              placeholder="COURSE_CODE"
              value={chamilo.courseCode}
              onChange={(event) => updateChamiloField("courseCode", event.target.value)}
            />
          </div>
        </div>
        <div className="actions">
          <button className="ghost-button" type="button" onClick={connectChamilo} disabled={isPending}>
            Проверить Chamilo
          </button>
          <button className="button" type="button" onClick={publishToChamilo} disabled={isPending || !chamilo.baseUrl || !chamilo.courseCode}>
            Экспортировать и отправить в Chamilo
          </button>
          <button className="ghost-button" type="button" onClick={publishTestToChamilo} disabled={isPending || !canPublishTest}>
            Upload test only
          </button>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "12px", fontSize: "14px" }}>
            <input type="checkbox" checked={exportAsXapi} onChange={(e) => setExportAsXapi(e.target.checked)} />
            xAPI (Tin Can)
          </label>
        </div>
        <div className="status">
          После проверки загрузится список доступных курсов. Пароль не сохраняется в JSON курса.
        </div>
      </div>
    </details>
  );
}
