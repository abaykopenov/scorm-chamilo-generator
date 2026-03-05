import test from "node:test";
import assert from "node:assert/strict";
import { parseLinePlanText } from "../lib/local-llm.js";

function createInput(questionCount = 2) {
  return {
    titleHint: "Курс по книге",
    audience: "Новые сотрудники",
    finalTest: {
      questionCount
    }
  };
}

test("parseLinePlanText parses topics and questions from line format", () => {
  const raw = [
    "TITLE|Адаптация сотрудников",
    "DESCRIPTION|Курс основан на внутренних материалах компании.",
    "TOPIC|Основы адаптации|Адаптация начинается с понимания роли и ожиданий.|Роль сотрудника; KPI и ожидания; Первые 30 дней",
    "TOPIC|Коммуникация|Важно выстроить регулярную обратную связь с наставником.|Чек-ины; Вопросы; Эскалация",
    "QUESTION|Что важно в первые 30 дней?|Знать роль и KPI|Избегать вопросов|Работать без целей|Игнорировать обратную связь|1|В книге это описано как базовый этап адаптации."
  ].join("\n");

  const parsed = parseLinePlanText(raw, createInput(2));

  assert.equal(parsed.title, "Адаптация сотрудников");
  assert.equal(parsed.topics.length, 2);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0].options.length, 4);
});

test("parseLinePlanText throws when no TOPIC lines are present", () => {
  const raw = [
    "TITLE|Пустой план",
    "DESCRIPTION|Описание",
    "QUESTION|Вопрос?|A|B|C|D|1|Пояснение"
  ].join("\n");

  assert.throws(
    () => parseLinePlanText(raw, createInput(1)),
    /TOPIC/i
  );
});
