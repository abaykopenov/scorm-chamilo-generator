import { CourseCreator } from "@/components/course-creator";

export default function HomePage() {
  return (
    <main className="page-shell stack">
      <section className="hero">
        <span className="eyebrow">Chamilo-ready</span>
        <h1>SCORM 1.2 генератор с управляемой структурой курса</h1>
        <p>
          Сервис собирает курс по заданной учебной архитектуре: модули, разделы, SCO, экраны и итоговый тест с
          <code>passing score</code>, ограничением попыток и таймером.
        </p>
        <div className="tag-list">
          <span className="tag">AI draft</span>
          <span className="tag">SCORM 1.2</span>
          <span className="tag">Chamilo upload</span>
          <span className="tag">Attempts + timer</span>
        </div>
      </section>

      <section className="grid two">
        <div className="panel stack">
          <h2>Новый курс</h2>
          <p>Задайте тему, цели и точные численные параметры курса. После генерации можно редактировать каждый экран и вопрос теста.</p>
          <CourseCreator />
        </div>

        <aside className="stack">
          <section className="panel stack">
            <h3>Что экспортируется</h3>
            <div className="summary-list">
              <div className="summary-item">
                <span>Manifest</span>
                <strong><code>imsmanifest.xml</code></strong>
              </div>
              <div className="summary-item">
                <span>Контент</span>
                <strong>HTML per SCO</strong>
              </div>
              <div className="summary-item">
                <span>Runtime</span>
                <strong>SCORM JS bridge</strong>
              </div>
              <div className="summary-item">
                <span>Итоговый тест</span>
                <strong>Final SCO</strong>
              </div>
              <div className="summary-item">
                <span>Публикация</span>
                <strong>Chamilo upload</strong>
              </div>
            </div>
          </section>

          <section className="panel stack">
            <h3>Параметры MVP</h3>
            <p className="note">
              Сервис валидирует ограничения и удерживает структуру в пределах MVP: до 20 модулей, 20 разделов,
              20 SCO, 20 экранов, 100 вопросов, 20 попыток и 300 минут таймера.
            </p>
            <p className="note">Генерация может идти через локальную LLM, например Ollama, без внешнего API.</p>
          </section>
        </aside>
      </section>
    </main>
  );
}
