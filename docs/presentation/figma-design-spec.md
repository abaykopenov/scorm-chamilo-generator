# Figma Design Spec: SCORM + RAG + Chamilo

## 1) Art Direction
- Mood: технологичный, уверенный, продуктовый.
- Visual metaphor: поток данных от материалов к готовому SCORM и публикации в LMS.
- Style: clean enterprise + акцентные диаграммы.
- Base theme: светлый фон, насыщенные акцентные цвета, крупная типографика.

## 2) Canvas & Grid
- Frame size: `1920x1080` (16:9).
- Safe area: `120 px` слева/справа, `72 px` сверху/снизу.
- Grid: `12 columns`, margin `120`, gutter `24`.
- Baseline: `8 px`.

## 3) Typography
- Title font: `Sora` (700/600).
- Body font: `Manrope` (500/400).
- Data/labels: `IBM Plex Mono` (500).

### Text styles
- `Display/XL`: Sora 72/78, 700
- `H1`: Sora 52/58, 700
- `H2`: Sora 40/46, 700
- `H3`: Sora 30/36, 600
- `Body/L`: Manrope 26/36, 500
- `Body/M`: Manrope 22/30, 500
- `Body/S`: Manrope 18/26, 500
- `Meta`: IBM Plex Mono 16/22, 500

## 4) Color System
- `bg.canvas`: `#F4F8FF`
- `bg.card`: `#FFFFFF`
- `ink.primary`: `#0D1B2A`
- `ink.secondary`: `#334155`
- `line.soft`: `#D7E2F0`
- `brand.primary`: `#0057FF`
- `brand.secondary`: `#00A3A3`
- `brand.accent`: `#FF7A00`
- `state.success`: `#159957`
- `state.warning`: `#D98E04`
- `state.danger`: `#C7382A`

### Gradients
- `hero.gradient`: `#0057FF -> #00A3A3` (135 deg)
- `accent.gradient`: `#00A3A3 -> #7FD7D7` (135 deg)

## 5) Effects
- Card shadow: `0 12 30 rgba(13,27,42,0.08)`
- Elevated shadow: `0 18 44 rgba(13,27,42,0.12)`
- Border radius:
  - Card: `24`
  - Chip/Button: `14`
  - Tiny: `10`

## 6) Core Components
- `TopBar/SlideMeta`: номер слайда, раздел, логотип.
- `Chip/Section`: цветной чип раздела (`Architecture`, `RAG`, `Delivery`).
- `Card/Metric`: заголовок, крупное число, подпись.
- `Card/Feature`: иконка, заголовок, 2-3 строки пояснения.
- `Flow/Step`: номер шага, заголовок, описание, стрелка между шагами.
- `Timeline/Row`: milestone + статус (`Done`, `In Progress`, `Next`).

## 7) Slides Blueprint (10 слайдов)

### Slide 1: Title
- Левый блок (7 колонок): название, подзаголовок, 3 буллета ценности.
- Правый блок (5 колонок): вертикальный стек из 3 metric-card.
- Фон: мягкий radial shape + gradient ribbon сверху.

### Slide 2: Problem & Goals
- Верх: заголовок.
- Низ: 2 card-колонки 6/6.
- Левая: проблемы.
- Правая: цели проекта.

### Slide 3: Value Proposition
- Заголовок + подзаголовок.
- 3 крупные feature-card в ряд:
  - Скорость разработки курса
  - Контроль структуры и качества
  - Прямая публикация в Chamilo

### Slide 4: Architecture Overview
- Заголовок + подпись.
- Большой контейнер под `architecture-large.png`.
- Снизу 3 chip: `Client+API`, `RAG Pipeline`, `Data+Delivery`.

### Slide 5: End-to-End Flow
- Горизонтальный flow из 6 шагов:
  - Upload -> Index -> Retrieve -> Generate -> Export -> Publish
- У каждого шага: иконка + 1 строка результата.

### Slide 6: Tech Stack
- 2 строки карточек:
  - UI/API: Next.js
  - LLM: Ollama/OpenAI-compatible
  - Retrieval: LangChain + Qdrant
  - Storage: local `.data` + vectors
  - Export: SCORM 1.2 builder
  - Integration: Chamilo form-upload

### Slide 7: What Is Implemented
- Таблица статусов 3 секции:
  - Done
  - In Progress
  - Next
- Использовать цветные status pills.

### Slide 8: Modules Map
- Граф модулей системы (карточки + связи).
- Выделить ядро: `course-generator`, `local-llm`, `rag-service`, `chamilo-client`.

### Slide 9: Results
- 4 metric-card:
  - SCORM export ready
  - RAG indexing active
  - Chamilo publish flow
  - Fallback strategy
- Ниже: короткий блок “Operational learnings”.

### Slide 10: Conclusion & Roadmap
- Левая часть: выводы проекта.
- Правая часть: roadmap на 3 этапа.
- Низ: CTA “Pilot in corporate LMS”.

## 8) Image Assets (from project)
- `docs/architecture/architecture-large.png`
- `docs/architecture/architecture-1-client-api.png`
- `docs/architecture/architecture-2-rag-pipeline.png`
- `docs/architecture/architecture-3-data-delivery.png`

## 9) Motion (optional for pitch)
- Fade-in by block (120 ms stagger).
- Diagram reveal in 3 steps on Slide 4.
- Flow steps reveal left-to-right on Slide 5.
