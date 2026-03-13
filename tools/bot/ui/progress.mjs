export function buildProgressBar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

const STAGE_ICONS = {
  "init": "🔧",
  "rag": "🔍",
  "retriever": "🔍",
  "planner": "📋",
  "outline": "📋",
  "writer": "✍️",
  "critic": "🔬",
  "test-builder": "📝",
  "postprocess": "🔄",
  "export": "📦",
  "done": "✅"
};

const STAGE_LABELS = {
  "init": "Инициализация",
  "rag": "Поиск по документам (RAG)",
  "retriever": "Извлечение фактов",
  "planner": "Планирование структуры",
  "outline": "Создание плана курса",
  "writer": "Генерация контента",
  "critic": "Проверка качества",
  "test-builder": "Создание теста",
  "postprocess": "Постобработка",
  "export": "Упаковка SCORM",
  "done": "Готово!"
};

export function formatProgressMessage(percent, stage, message, startedAt) {
  const bar = buildProgressBar(percent);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins} мин ${secs} сек` : `${secs} сек`;

  const icon = STAGE_ICONS[stage] || "⏳";
  const label = STAGE_LABELS[stage] || stage;

  const lines = [
    `⏳ <b>Генерация курса</b>`,
    `${bar} <b>${percent}%</b>`,
    `${icon} <b>${label}</b>`,
  ];
  if (message) lines.push(`   ❯ ${message}`);
  lines.push(`⏱ ${timeStr}`);

  // Estimate remaining time based on progress
  if (percent > 5 && percent < 100 && elapsed > 3) {
    const totalEstimate = Math.round(elapsed / (percent / 100));
    const remaining = totalEstimate - elapsed;
    if (remaining > 0) {
      const rMin = Math.floor(remaining / 60);
      const rSec = remaining % 60;
      const remainStr = rMin > 0 ? `~${rMin} мин ${rSec} сек` : `~${rSec} сек`;
      lines.push(`⏳ Осталось: ${remainStr}`);
    }
  }

  return lines.join("\n");
}
