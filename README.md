# SCORM 1.2 Generator for Chamilo

Параметризуемый веб-сервис на Next.js для генерации SCORM 1.2 пакетов под Chamilo.

## Что умеет

- Создает черновик курса по брифу и параметрам структуры.
- Поддерживает иерархию `Course -> Module -> Section -> SCO -> Screen`.
- Позволяет менять структуру курса и параметры итогового теста.
- Экспортирует SCORM 1.2 ZIP с несколькими SCO и финальным тестовым SCO.
- Ограничивает количество попыток и время теста внутри самого пакета.
- Может генерировать курс через локальную LLM, например `Ollama`.
- Может сразу отправлять собранный SCORM ZIP в Chamilo через форму импорта.

## Локальный запуск

```bash
npm install
npm run dev
```

Откройте [http://localhost:3000](http://localhost:3000).

## Локальная LLM

На экране создания курса выберите:

- `Шаблонный draft` для генерации без LLM
- `Ollama` для локального вызова `http://127.0.0.1:11434`
- `OpenAI-compatible` для локального сервера с `/chat/completions`

Пример для Ollama:

```bash
ollama serve
ollama pull qwen2.5:14b
```

Затем укажите в UI:

- `Provider`: `Ollama`
- `Base URL`: `http://127.0.0.1:11434`
- `Model`: `qwen2.5:14b`

Если LLM недоступна или ответит невалидным JSON, сервис автоматически откатится к шаблонной генерации.

## Публикация в Chamilo

На странице курса заполните блок `Публикация в Chamilo`:

- `Portal URL`: адрес портала LMS
- `Username`
- `Password`
- `Course code`
- `Upload page path`
- `Login path`

По умолчанию используются пути:

- `Login path`: `/index.php`
- `Upload page path`: `/main/newscorm/lp_controller.php?action=import`

Сервис:

1. логинится в Chamilo;
2. открывает страницу импорта SCORM;
3. отправляет ZIP напрямую.

Пароль не сохраняется в JSON курса.

## Тесты

```bash
npm test
```
