import { toSafeInt, ensureQuestionCount } from "./utils";

export function FinalTestAccordion({ course, setCourse, updateCourse }) {
  return (
    <details className="accordion-panel">
      <summary>
        <span>Итоговый тест</span>
        <small>Проходной балл, попытки, таймер и вопросы</small>
      </summary>
      <div className="accordion-body stack">
        <div className="field-grid">
          <div className="field">
            <label htmlFor="test-enabled">Тест</label>
            <select
              id="test-enabled"
              value={course.finalTest.enabled ? "yes" : "no"}
              onChange={(event) => updateCourse((draft) => {
                draft.finalTest.enabled = event.target.value === "yes";
              })}
            >
              <option value="yes">Включен</option>
              <option value="no">Отключен</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="test-question-count">Вопросов</label>
            <input
              id="test-question-count"
              type="number"
              min="0"
              max="100"
              value={course.finalTest.questionCount}
              onChange={(event) => {
                const count = Number(event.target.value);
                setCourse((current) => ensureQuestionCount(current, count));
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="test-passing-score">Passing score</label>
            <input
              id="test-passing-score"
              type="number"
              min="0"
              max="100"
              value={course.finalTest.passingScore}
              onChange={(event) => updateCourse((draft) => {
                draft.finalTest.passingScore = toSafeInt(event.target.value, draft.finalTest.passingScore, 0, 100);
              })}
            />
          </div>
          <div className="field">
            <label htmlFor="test-attempts">Attempts</label>
            <input
              id="test-attempts"
              type="number"
              min="1"
              max="20"
              value={course.finalTest.attemptsLimit}
              onChange={(event) => updateCourse((draft) => {
                draft.finalTest.attemptsLimit = toSafeInt(event.target.value, draft.finalTest.attemptsLimit, 1, 20);
              })}
            />
          </div>
          <div className="field">
            <label htmlFor="test-max-time">Max time, мин</label>
            <input
              id="test-max-time"
              type="number"
              min="1"
              max="300"
              value={course.finalTest.maxTimeMinutes}
              onChange={(event) => updateCourse((draft) => {
                draft.finalTest.maxTimeMinutes = toSafeInt(event.target.value, draft.finalTest.maxTimeMinutes, 1, 300);
              })}
            />
          </div>
        </div>

        {course.finalTest.questions.map((question, questionIndex) => (
          <details className="nested-accordion" key={question.id} open={questionIndex === 0}>
            <summary>
              <span>Вопрос {questionIndex + 1}</span>
              <small>Правильный ответ: {question.correctOptionId}</small>
            </summary>
            <div className="accordion-body">
              <div className="field">
                <label htmlFor={`question-text-${questionIndex}`}>Текст вопроса</label>
                <textarea
                  id={`question-text-${questionIndex}`}
                  value={question.prompt}
                  onChange={(event) => updateCourse((draft) => {
                    draft.finalTest.questions[questionIndex].prompt = event.target.value;
                  })}
                />
              </div>
              <div className="inline-grid">
                {question.options.map((option, optionIndex) => (
                  <div className="field" key={option.id}>
                    <label htmlFor={`option-text-${questionIndex}-${optionIndex}`}>Вариант {optionIndex + 1}</label>
                    <input
                      id={`option-text-${questionIndex}-${optionIndex}`}
                      value={option.text}
                      onChange={(event) => updateCourse((draft) => {
                        draft.finalTest.questions[questionIndex].options[optionIndex].text = event.target.value;
                      })}
                    />
                    <button
                      className={question.correctOptionId === option.id ? "button" : "ghost-button"}
                      type="button"
                      onClick={() => updateCourse((draft) => {
                        draft.finalTest.questions[questionIndex].correctOptionId = option.id;
                      })}
                    >
                      {question.correctOptionId === option.id ? "Correct" : "Сделать правильным"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
