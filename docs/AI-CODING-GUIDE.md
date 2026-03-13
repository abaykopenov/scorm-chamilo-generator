# 🤖 AI Coding Guide — SCORM-Chamilo Generator

> Это руководство для ИИ-ассистентов (Copilot, Cursor, Claude и др.) по правилам написания кода в данном проекте.

---

## 📁 Структура проекта

```
scorm-chamilo-generator/
├── app/                    # Next.js App Router (страницы и API)
│   ├── api/                # REST API endpoints
│   │   ├── courses/        # CRUD курсов
│   │   ├── materials/      # Загрузка/индексация PDF
│   │   ├── exports/        # Экспорт SCORM
│   │   ├── local-llm/      # Проверка подключения к LLM
│   │   └── diagnostics/    # Диагностика системы
│   ├── courses/            # Страницы курсов (Web UI)
│   ├── admin/              # Админ-панель
│   ├── page.js             # Главная страница
│   ├── layout.js           # Корневой layout
│   └── globals.css         # Глобальные стили
│
├── components/             # React-компоненты Web UI
│   ├── course-creator.js   # Создание курса
│   ├── course-editor.js    # Редактирование курса
│   └── outline-editor.js   # Редактор оглавления
│
├── lib/                    # Основная бизнес-логика (ЯДРО)
│   ├── chamilo/            # Интеграция с Chamilo LMS
│   │   ├── auth-helpers.js     # Авторизация, куки, сессии
│   │   ├── http-client.js      # HTTP запросы, редиректы
│   │   ├── html-parser.js      # Парсинг HTML форм Chamilo
│   │   ├── upload-helpers.js   # Загрузка SCORM в Chamilo
│   │   └── test-helpers.js     # Создание тестов, вопросов, LP
│   │
│   ├── generation/         # V4 Pipeline генерации курса
│   │   ├── v4-pipeline.js      # Главный пайплайн (Writer + Critic)
│   │   ├── pipeline-helpers.js # Хелперы (RAG, quality checks)
│   │   └── planner-builder.js  # Построение экранов из плана
│   │
│   ├── llm/                # LLM провайдеры
│   │   ├── providers.js        # Ollama, OpenAI-compatible
│   │   ├── parser.js           # Парсинг JSON из LLM
│   │   └── utils.js            # Логирование, таймауты
│   │
│   ├── scorm/              # SCORM 1.2 Builder
│   │   ├── exporter.js         # Точка входа экспорта
│   │   ├── manifest.js         # imsmanifest.xml
│   │   ├── runtime.js          # HTML-генератор слайдов
│   │   └── zip.js              # ZIP-упаковка
│   │
│   ├── validation/         # Валидация данных
│   │   ├── input.js            # Валидация входных параметров
│   │   ├── course.js           # Валидация структуры курса
│   │   └── shared.js           # Общие утилиты
│   │
│   ├── prompts.js          # Промпты для LLM (планировщик, писатель, тест)
│   ├── rag-service.js      # RAG: поиск по векторной базе
│   ├── embeddings.js       # Векторизация текста
│   ├── chunker.js          # Нарезка PDF на чанки
│   ├── local-llm.js        # Фасад LLM (re-exports)
│   ├── course-store.js     # Хранение курсов (Prisma)
│   ├── material-store.js   # Хранение материалов
│   └── course-utils.js     # Утилиты для работы с курсами
│
├── tools/                  # Telegram Bot и CLI
│   ├── telegram-bot.mjs        # Ядро бота (polling loop)
│   ├── run-with-bot.mjs        # Запуск Next.js + Bot
│   └── bot/                    # Модули бота
│       ├── commands/           # Команды (/start, /chamilo, etc.)
│       ├── generation/         # Генерация через бот
│       ├── handlers/           # Обработчики callback
│       ├── i18n/               # Локализация
│       ├── ui/                 # Inline-кнопки
│       ├── state.mjs           # Состояние пользователей
│       └── config.mjs          # Конфигурация бота
│
├── prisma/                 # Схема базы данных
├── adapters/               # Адаптеры LMS (абстракция)
└── scripts/                # Утилитарные скрипты
```

---

## 🔧 Технический стек

| Компонент | Технология | Версия |
|-----------|-----------|--------|
| Runtime | Node.js | 18+ |
| Framework | Next.js (App Router) | 15.x |
| ORM | Prisma | 5.x |
| Database | SQLite | — |
| LLM | Ollama (локально) | — |
| Embeddings | qwen3-embedding / nomic-embed-text | — |
| Vector DB | Qdrant | — |
| Bot | Telegram Bot API (polling) | — |
| LMS | Chamilo 1.11.x | — |
| Modules | ES Modules (`"type": "module"`) | — |

---

## 🧱 Анти-монолитная архитектура

> **ГЛАВНОЕ ПРАВИЛО: Код НЕ должен быть монолитным.**
> Каждый файл — одна ответственность. Если файл растёт — разделяй.

### Лимиты размера файлов

| Метрика | Мягкий лимит | Жёсткий лимит |
|---------|-------------|---------------|
| Строк в файле | **200** | **300** |
| Функций в файле | **8** | **12** |
| Параметров у функции | **4** | **6** (используй объект) |
| Вложенность (if/for/try) | **3** | **4** |

### Когда разделять файл

```
❌ ПЛОХО: один файл делает всё
upload-helpers.js (592 строк)
  - connectToChamilo()
  - parseUploadForm()
  - uploadScormFile()
  - detectUploadOutcome()
  - extractLpIdFromResult()
  - normalizeChamiloProfile()

✅ ХОРОШО: каждый файл — одна зона ответственности
chamilo/
  auth-helpers.js     — авторизация, cookie, профиль  (~100 строк)
  http-client.js      — fetch, redirect chain, headers  (~80 строк)
  html-parser.js      — парсинг форм и HTML            (~150 строк)
  upload-helpers.js   — загрузка SCORM                  (~200 строк)
  test-helpers.js     — создание тестов и вопросов      (~200 строк)
```

### Принцип единственной ответственности

Каждый модуль отвечает за **одну** вещь:

```javascript
// ✅ ПРАВИЛЬНО: файл делает одну вещь
// lib/chamilo/auth-helpers.js
export function normalizeChamiloProfile(profile) { ... }
export function connectToChamilo(options) { ... }
export function ensureChamiloCookieJar(profile, jar) { ... }

// ❌ НЕПРАВИЛЬНО: файл делает всё подряд
// lib/chamilo/everything.js
export function connectToChamilo() { ... }
export function uploadScorm() { ... }
export function createTest() { ... }
export function addQuestion() { ... }
export function linkToLP() { ... }
export function parseHtml() { ... }
```

### Как разделять монолит

1. **Найди группы функций** по общей теме (auth, parsing, upload, test)
2. **Создай новый файл** для каждой группы
3. **Перенеси функции** — оставь re-export из старого файла для обратной совместимости
4. **Обнови импорты** во всех зависимых файлах

```javascript
// Было: import { connectToChamilo, uploadScorm, createTest } from "./chamilo-client.js";
// Стало:
import { connectToChamilo } from "./chamilo/auth-helpers.js";
import { uploadScorm } from "./chamilo/upload-helpers.js";
import { createTest } from "./chamilo/test-helpers.js";
```

### Когда создавать новый модуль

- Файл превышает **200 строк** → разделяй
- Функция превышает **50 строк** → выноси хелперы
- Модуль имеет **2+ несвязанных ответственности** → разделяй
- Ловишь себя на **копировании кода** → создай shared utility
- Добавляешь **новую интеграцию** (Moodle, iSpring) → новая папка

---

## 📐 Правила написания кода

### 1. Модульная система
```javascript
// ✅ ПРАВИЛЬНО: ES Modules
import { something } from "./module.js";
export function doStuff() { ... }

// ❌ НЕПРАВИЛЬНО: CommonJS
const something = require("./module");
module.exports = { doStuff };
```

### 2. Расширения файлов
- **`.js`** — для файлов в `lib/`, `components/`, `app/`
- **`.mjs`** — для файлов в `tools/` (Telegram bot)
- Всегда указывай `.js` в import: `import { x } from "./file.js"`

### 3. Асинхронность
```javascript
// ✅ Всегда async/await
async function createExercise(options) {
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

// ❌ Не используй .then() цепочки
fetch(url).then(res => res.json()).then(data => { ... });
```

### 4. Обработка ошибок
```javascript
// ✅ Всегда try/catch с логированием
try {
  const result = await riskyOperation();
  console.log(`[module-name] Success: ${result.id}`);
} catch (err) {
  console.error(`[module-name] Failed: ${err?.message || err}`);
  // Не глотай ошибку молча — или throw, или return fallback
}

// ❌ Никогда не оставляй пустой catch
try { await something(); } catch {} // ПЛОХО
```

### 5. Логирование
```javascript
// Используй префикс модуля в квадратных скобках:
console.log(`[chamilo-test] Exercise created: id=${exerciseId}`);
console.log(`[v4-pipeline] Writing screen M${m} S${s} C${c} P${p}`);
console.error(`[rag-service] No chunks found for query: "${query}"`);

// Доступные префиксы:
// [bot]           — Telegram бот
// [chamilo-test]  — Создание тестов в Chamilo
// [chamilo-lp]    — Привязка к Learning Path
// [chamilo-upload] — Загрузка SCORM
// [v4-pipeline]   — Генерация курса
// [rag-service]   — RAG поиск
// [llm]           — Запросы к LLM
```

### 6. Форматирование
- **Отступы:** 2 пробела
- **Точки с запятой:** да
- **Кавычки:** двойные `"string"` (в большинстве файлов)
- **Trailing commas:** нет
- **Max line length:** ~120 символов (мягкий лимит)

### 7. Именование
```javascript
// Функции — camelCase
function buildExerciseCreateRequestBody() { ... }

// Константы — UPPER_SNAKE_CASE
const MAX_ATTEMPTS = 3;
const LOG_CHARS_RESPONSE_PREVIEW = 300;

// Файлы — kebab-case
// auth-helpers.js, pipeline-helpers.js, course-store.js

// Классы/типы — не используем (функциональный стиль)
```

### 8. Работа с Chamilo LMS

> ⚠️ Chamilo — legacy PHP приложение. При работе с ним соблюдай:

```javascript
// 1. ВСЕГДА скрапь форму перед POST (CSRF, hidden fields)
const forms = parseForms(html, responseUrl);
const form = forms.find(f => f.method === "POST");

// 2. ВСЕГДА используй fetchWithRedirectChain для POST
// (redirect: "manual" теряет данные из редиректов)
const result = await fetchWithRedirectChain({
  url, method: "POST", body, headers, cookieJar, maxRedirects: 6
});

// 3. Checkbox'ы — НЕ отправляй (в HTML unchecked = не отправлено)
if (type === "checkbox") continue;

// 4. Radio — отправляй только ПЕРВОЕ значение
if (type === "radio" && seenNames.has(name)) continue;

// 5. post_time — бери из серверного заголовка Date
const serverTime = Math.floor(new Date(response.headers.get("date")).getTime() / 1000);
```

### 9. Работа с LLM
```javascript
// 1. Всегда устанавливай timeout (LLM может зависнуть)
const TIMEOUT_MS = 300_000; // 5 минут для больших моделей

// 2. Всегда валидируй JSON-ответ
const parsed = parseJsonFromLlmText(response);
if (!parsed || !parsed.modules) {
  throw new Error("Invalid LLM response structure");
}

// 3. Retry с repair prompt при ошибке парсинга
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    return await generateWithLlm(prompt);
  } catch {
    prompt = createRepairPrompt(prompt, lastResponse, error.message);
  }
}
```

### 10. API Routes (Next.js)
```javascript
// app/api/something/route.js
export async function POST(request) {
  try {
    const body = await request.json();
    // ... логика
    return Response.json({ ok: true, data });
  } catch (err) {
    return Response.json(
      { ok: false, error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
```

---

## 🔌 Переменные окружения (.env)

| Переменная | Описание | Пример |
|-----------|---------|--------|
| `OLLAMA_BASE_URL` | URL Ollama сервера | `http://localhost:11434` |
| `LLM_MODEL` | Модель для генерации | `qwen3:32b` |
| `EMBEDDING_MODEL` | Модель для embeddings | `qwen3-embedding` |
| `QDRANT_URL` | URL Qdrant сервера | `http://localhost:6333` |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота | `123456:ABC-DEF` |
| `TELEGRAM_ADMIN_IDS` | ID администраторов | `123456789` |
| `LLM_TIMEOUT_MS` | Таймаут LLM запроса | `300000` |

---

## 🚫 Чего НЕ делать

### Архитектура
1. **Не пиши монолиты** — файл > 300 строк = обязательно разделяй
2. **Не дублируй код** — создай shared utility
3. **Не создавай God-функции** — функция > 50 строк = разделяй на хелперы
4. **Не складывай всё в один файл** — каждый модуль = одна ответственность
5. **Не создавай классы** — проект использует функциональный стиль

### Код
6. **Не используй CommonJS** (`require`, `module.exports`)
7. **Не добавляй зависимости** без крайней необходимости (проект минималистичен)
8. **Не пиши в `console.log` без префикса** `[module-name]`
9. **Не используй** `process.exit()` — бот и Next.js работают в одном процессе
10. **Не оставляй пустой catch** — логируй или пробрасывай ошибку

### Chamilo
11. **Не используй `redirect: "manual"` для POST** к Chamilo — используй `fetchWithRedirectChain`
12. **Не отправляй checkbox'ы** в Chamilo формах — это включит нежелательные опции
13. **Не хардкодь URL** Chamilo — используй `buildChamiloUrl(base, path)`

### Данные
14. **Не кэшируй** объекты Prisma между запросами (SQLite locks)
15. **Не сохраняй пароли** в логи — маскируй: `pass=***`
