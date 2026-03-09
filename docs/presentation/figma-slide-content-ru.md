# Контент для слайдов (RU): SCORM + RAG + Chamilo

## Слайд 1. Титульный
**Заголовок:**
SCORM + RAG Course Generator for Chamilo

**Подзаголовок:**
Локальная платформа для генерации e-learning курсов, экспорта SCORM 1.2 и публикации в LMS Chamilo.

**Ключевые тезисы:**
- Генерация курса из брифа и материалов
- Контроль структуры `Course -> Module -> Section -> SCO -> Screen`
- Публикация в Chamilo в одном потоке

## Слайд 2. Проблема и цель
**Проблемы:**
- Ручная сборка курсов занимает много времени
- Нужна строгая структура и тесты
- Часто нет единого потока от материалов до LMS

**Цели проекта:**
- Автоматизировать создание курса и тестов
- Добавить RAG по загруженным документам
- Получать готовый SCORM ZIP и сразу публиковать в Chamilo

## Слайд 3. Ценность решения
- **Быстрее:** меньше ручной авторской работы
- **Качественнее:** встроенные проверки, fallback-стратегии
- **Практичнее:** локальный запуск без внешних облаков

## Слайд 4. Архитектура (обзор)
**Подпись:**
Архитектура состоит из трех уровней: Client/API, RAG + Generation Pipeline, Data + Delivery.

**Ассет:**
`docs/architecture/architecture-large.png`

## Слайд 5. E2E поток
1. Upload материалов
2. Index (парсинг, чанкинг, embeddings)
3. Retrieve top-K контекста
4. Generate outline/line-plan/course
5. Export SCORM 1.2 ZIP
6. Publish в Chamilo

## Слайд 6. Технологический стек
- **Frontend/API:** Next.js 15
- **LLM providers:** Ollama / OpenAI-compatible
- **RAG:** LangChain (JS) + Qdrant (optional) + локальный fallback
- **Storage:** local `.data` (materials/courses/exports)
- **SCORM:** внутренний package builder + runtime
- **LMS:** Chamilo form-based upload

## Слайд 7. Что реализовано
**Done:**
- Загрузка материалов и индексация
- Генерация курса с управлением структуры
- Экспорт SCORM 1.2
- Подключение к Chamilo и upload

**In progress:**
- Улучшение качества fallback-контента
- Оптимизация таймаутов и retry

**Next:**
- Умная QA-валидация покрытия контента
- Более глубокая аналитика качества вопросов

## Слайд 8. Модули системы
- `course-generator`
- `local-llm`
- `rag-service`
- `material-indexer`
- `document-parser`
- `vector-search` / `langchain-qdrant`
- `scorm/exporter`
- `chamilo-client`

## Слайд 9. Результаты
- Полный цикл от документа до курса
- RAG-контекст учитывается при генерации
- Fallback-стратегия при сбоях LLM
- Рабочий экспорт и публикация в Chamilo

## Слайд 10. Выводы и roadmap
**Вывод:**
Проект закрывает практическую задачу быстрого выпуска структурированных e-learning курсов в локальном контуре.

**Roadmap:**
1. Улучшение качества генерации и тестов
2. Автоматическая QA-проверка содержания
3. Пилотное внедрение в корпоративный процесс обучения
