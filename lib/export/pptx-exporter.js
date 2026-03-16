/**
 * Export course to PPTX (PowerPoint) format.
 * Uses pptxgenjs — no Office/LibreOffice dependencies.
 *
 * Structure: Title slide → TOC → Content slides (1 screen = 1 slide) → Test slides → Answer key
 */

import PptxGenJS from "pptxgenjs";
import { SLIDE_COLORS, SLIDE_FONTS, SLIDE_LAYOUT } from "./pptx-styles.js";
import { buildGlossary } from "./glossary-builder.js";

const LOG_PREFIX = "[pptx-export]";

function sanitize(text) {
  if (text == null) return "";
  if (typeof text === "string") return text.replace(/\[object Object\]/gi, "").trim();
  if (typeof text === "object") return `${text.text || text.label || text.value || ""}`.trim();
  return String(text).trim();
}

function addTitleSlide(pptx, course) {
  const slide = pptx.addSlide();
  slide.background = { color: SLIDE_COLORS.primary };

  slide.addText(sanitize(course.title) || "Учебный курс", {
    x: SLIDE_LAYOUT.marginX, y: 1.5,
    w: SLIDE_LAYOUT.contentWidth, h: 1.5,
    fontSize: SLIDE_FONTS.title,
    color: SLIDE_COLORS.white,
    bold: true,
    align: "center"
  });

  const desc = sanitize(course.description);
  if (desc) {
    slide.addText(desc, {
      x: SLIDE_LAYOUT.marginX, y: 3.2,
      w: SLIDE_LAYOUT.contentWidth, h: 0.8,
      fontSize: SLIDE_FONTS.body,
      color: SLIDE_COLORS.white,
      align: "center"
    });
  }

  slide.addText(new Date().toLocaleDateString("ru-RU"), {
    x: SLIDE_LAYOUT.marginX, y: 4.5,
    w: SLIDE_LAYOUT.contentWidth, h: 0.5,
    fontSize: SLIDE_FONTS.small,
    color: SLIDE_COLORS.white,
    align: "center"
  });
}

function addTocSlide(pptx, course) {
  const slide = pptx.addSlide();
  slide.addText("Содержание", {
    x: SLIDE_LAYOUT.marginX, y: SLIDE_LAYOUT.marginY,
    w: SLIDE_LAYOUT.contentWidth, h: 0.6,
    fontSize: SLIDE_FONTS.h1,
    color: SLIDE_COLORS.primary,
    bold: true
  });

  const modules = Array.isArray(course.modules) ? course.modules : [];
  const items = modules.map((m, i) => ({
    text: `${i + 1}. ${sanitize(m.title)}`,
    options: {
      fontSize: SLIDE_FONTS.h3,
      color: SLIDE_COLORS.heading,
      bullet: false,
      breakLine: true
    }
  }));

  if (items.length > 0) {
    slide.addText(items, {
      x: SLIDE_LAYOUT.marginX, y: 1.3,
      w: SLIDE_LAYOUT.contentWidth, h: 3.8,
      valign: "top",
      lineSpacingMultiple: 1.5
    });
  }
}

function addModuleSlides(pptx, course) {
  const modules = Array.isArray(course.modules) ? course.modules : [];
  let screenNum = 0;

  for (let mi = 0; mi < modules.length; mi++) {
    const mod = modules[mi];

    // Module divider slide
    const divider = pptx.addSlide();
    divider.background = { color: SLIDE_COLORS.primaryDark };
    divider.addText(`Модуль ${mi + 1}`, {
      x: SLIDE_LAYOUT.marginX, y: 1.5,
      w: SLIDE_LAYOUT.contentWidth, h: 0.6,
      fontSize: SLIDE_FONTS.h2,
      color: SLIDE_COLORS.white,
      align: "center"
    });
    divider.addText(sanitize(mod.title), {
      x: SLIDE_LAYOUT.marginX, y: 2.3,
      w: SLIDE_LAYOUT.contentWidth, h: 1,
      fontSize: SLIDE_FONTS.title,
      color: SLIDE_COLORS.white,
      bold: true,
      align: "center"
    });

    const sections = Array.isArray(mod.sections) ? mod.sections : [];
    for (const section of sections) {
      const scos = Array.isArray(section.scos) ? section.scos : [];
      for (const sco of scos) {
        const screens = Array.isArray(sco.screens) ? sco.screens : [];
        for (const screen of screens) {
          screenNum++;
          addScreenSlide(pptx, screen, screenNum, mi + 1);
        }
      }
    }
  }

  return screenNum;
}

function addScreenSlide(pptx, screen, num, moduleNum) {
  const slide = pptx.addSlide();

  // Header bar
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_LAYOUT.width, h: 0.6,
    fill: { color: SLIDE_COLORS.primary }
  });

  slide.addText(`М${moduleNum} • ${sanitize(screen.title)}`, {
    x: SLIDE_LAYOUT.marginX, y: 0.08,
    w: SLIDE_LAYOUT.contentWidth, h: 0.45,
    fontSize: SLIDE_FONTS.h3,
    color: SLIDE_COLORS.white,
    bold: true
  });

  // Content
  const blocks = Array.isArray(screen.blocks) ? screen.blocks : [];
  const textParts = buildSlideContent(blocks);

  if (textParts.length > 0) {
    slide.addText(textParts, {
      x: SLIDE_LAYOUT.marginX, y: 0.8,
      w: SLIDE_LAYOUT.contentWidth, h: 4.3,
      valign: "top",
      lineSpacingMultiple: 1.2
    });
  }

  // Footer
  slide.addText(`${num}`, {
    x: SLIDE_LAYOUT.width - 1, y: SLIDE_LAYOUT.height - 0.4,
    w: 0.5, h: 0.3,
    fontSize: SLIDE_FONTS.small,
    color: SLIDE_COLORS.muted,
    align: "right"
  });
}

function buildSlideContent(blocks) {
  const parts = [];

  for (const block of blocks) {
    const type = `${block.type || "text"}`.trim();

    if (type === "text") {
      const text = sanitize(block.text);
      if (!text) continue;
      parts.push({
        text: text + "\n\n",
        options: {
          fontSize: SLIDE_FONTS.body,
          color: SLIDE_COLORS.body,
          breakLine: true
        }
      });
    }

    if (type === "list") {
      const items = Array.isArray(block.items) ? block.items : [];
      for (const item of items) {
        const text = sanitize(typeof item === "string" ? item : item?.text);
        if (!text) continue;
        parts.push({
          text: text,
          options: {
            fontSize: SLIDE_FONTS.body,
            color: SLIDE_COLORS.body,
            bullet: { code: "2022" },
            indentLevel: 0,
            breakLine: true
          }
        });
      }
      // Spacing after list
      parts.push({ text: "\n", options: { fontSize: 6, breakLine: true } });
    }

    if (type === "note" || type === "warning") {
      const text = sanitize(block.text);
      if (!text) continue;
      const prefix = type === "warning" ? "⚠️ " : "ℹ️ ";
      parts.push({
        text: prefix + text + "\n",
        options: {
          fontSize: SLIDE_FONTS.small,
          color: type === "warning" ? SLIDE_COLORS.error : SLIDE_COLORS.primary,
          italic: true,
          breakLine: true
        }
      });
    }

    if (type === "table") {
      const cols = Array.isArray(block.columns) ? block.columns : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (!cols.length && !rows.length) continue;
      let text = "";
      if (cols.length) {
        text += cols.map(c => sanitize(String(c))).join("  |  ") + "\n";
        text += cols.map(() => "---").join(" | ") + "\n";
      }
      for (const row of rows) {
        const rowArr = Array.isArray(row) ? row : [];
        text += rowArr.map(c => sanitize(String(c))).join("  |  ") + "\n";
      }
      parts.push({
        text: text + "\n",
        options: {
          fontSize: SLIDE_FONTS.small,
          color: SLIDE_COLORS.secondary,
          breakLine: true
        }
      });
    }
  }

  return parts;
}

function addTestSlides(pptx, course) {
  const test = course.finalTest;
  if (!test?.enabled && !Array.isArray(test?.questions)) return;
  const questions = Array.isArray(test.questions) ? test.questions : [];
  if (questions.length === 0) return;

  // Test divider
  const divider = pptx.addSlide();
  divider.background = { color: SLIDE_COLORS.accent };
  divider.addText("📝 Финальный тест", {
    x: SLIDE_LAYOUT.marginX, y: 2,
    w: SLIDE_LAYOUT.contentWidth, h: 1,
    fontSize: SLIDE_FONTS.title,
    color: SLIDE_COLORS.white,
    bold: true,
    align: "center"
  });

  const letters = ["a", "b", "c", "d", "e", "f"];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const slide = pptx.addSlide();

    slide.addText(`Вопрос ${qi + 1} из ${questions.length}`, {
      x: SLIDE_LAYOUT.marginX, y: SLIDE_LAYOUT.marginY,
      w: SLIDE_LAYOUT.contentWidth, h: 0.4,
      fontSize: SLIDE_FONTS.small,
      color: SLIDE_COLORS.muted
    });

    slide.addText(sanitize(q.prompt), {
      x: SLIDE_LAYOUT.marginX, y: 1,
      w: SLIDE_LAYOUT.contentWidth, h: 1.2,
      fontSize: SLIDE_FONTS.h3,
      color: SLIDE_COLORS.heading,
      bold: true,
      valign: "top"
    });

    const options = Array.isArray(q.options) ? q.options : [];
    const optionParts = options.map((opt, oi) => ({
      text: `${letters[oi] || oi + 1}) ${sanitize(opt)}`,
      options: {
        fontSize: SLIDE_FONTS.body,
        color: SLIDE_COLORS.body,
        breakLine: true,
        bullet: false
      }
    }));

    if (optionParts.length > 0) {
      slide.addText(optionParts, {
        x: SLIDE_LAYOUT.marginX + 0.3, y: 2.5,
        w: SLIDE_LAYOUT.contentWidth - 0.6, h: 2.5,
        valign: "top",
        lineSpacingMultiple: 1.6
      });
    }
  }

  // Answer key slide
  addAnswerKeySlide(pptx, questions);
}

function addAnswerKeySlide(pptx, questions) {
  const slide = pptx.addSlide();
  slide.addText("🔑 Ответы", {
    x: SLIDE_LAYOUT.marginX, y: SLIDE_LAYOUT.marginY,
    w: SLIDE_LAYOUT.contentWidth, h: 0.6,
    fontSize: SLIDE_FONTS.h1,
    color: SLIDE_COLORS.accent,
    bold: true
  });

  const letters = ["a", "b", "c", "d", "e", "f"];
  const answerParts = questions.map((q, qi) => {
    const correctIdx = Number(q.correctOptionIndex) || 0;
    const letter = letters[correctIdx] || `${correctIdx + 1}`;
    return {
      text: `${qi + 1}. ${letter}) ${sanitize((q.options || [])[correctIdx])}`,
      options: {
        fontSize: SLIDE_FONTS.body,
        color: SLIDE_COLORS.accent,
        breakLine: true
      }
    };
  });

  if (answerParts.length > 0) {
    slide.addText(answerParts, {
      x: SLIDE_LAYOUT.marginX, y: 1.3,
      w: SLIDE_LAYOUT.contentWidth, h: 3.8,
      valign: "top",
      lineSpacingMultiple: 1.4
    });
  }
}

function addGlossarySlide(pptx, course) {
  const { terms } = course.glossary || { terms: [] };
  if (!terms || terms.length === 0) return;

  // Split into slides of ~10 terms each for readability
  const perSlide = 10;
  for (let page = 0; page < terms.length; page += perSlide) {
    const pageTerms = terms.slice(page, page + perSlide);
    const slide = pptx.addSlide();

    slide.addText(page === 0 ? "📖 Глоссарий" : "📖 Глоссарий (продолжение)", {
      x: SLIDE_LAYOUT.marginX, y: SLIDE_LAYOUT.marginY,
      w: SLIDE_LAYOUT.contentWidth, h: 0.6,
      fontSize: SLIDE_FONTS.h1,
      color: SLIDE_COLORS.primary,
      bold: true
    });

    const termParts = [];
    for (const entry of pageTerms) {
      // Term (bold)
      termParts.push({
        text: entry.term,
        options: {
          fontSize: SLIDE_FONTS.body,
          color: SLIDE_COLORS.heading,
          bold: true,
          breakLine: !entry.definition
        }
      });
      // Definition
      if (entry.definition) {
        termParts.push({
          text: ` — ${entry.definition}`,
          options: {
            fontSize: SLIDE_FONTS.small,
            color: SLIDE_COLORS.body,
            breakLine: true
          }
        });
      }
    }

    slide.addText(termParts, {
      x: SLIDE_LAYOUT.marginX, y: 1.2,
      w: SLIDE_LAYOUT.contentWidth, h: 4,
      valign: "top",
      lineSpacingMultiple: 1.4
    });
  }
}

/**
 * Export course JSON to PPTX Buffer.
 * @param {object} course - Course JSON object
 * @returns {Promise<Buffer>} PPTX file as Buffer
 */
export async function exportCourseToPptx(course) {
  console.log(`${LOG_PREFIX} Generating PPTX for "${sanitize(course.title)}"`);

  // Pre-build glossary with LLM definitions if not already attached
  if (!course.glossary || !Array.isArray(course.glossary?.terms)) {
    try {
      const { buildGlossary } = await import("./glossary-builder.js");
      course.glossary = await buildGlossary(course);
    } catch (glossaryError) {
      console.warn(`${LOG_PREFIX} Glossary generation failed: ${glossaryError?.message}`);
    }
  }

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = sanitize(course.title) || "Учебный курс";
  pptx.author = "SCORM-Chamilo Generator";

  addTitleSlide(pptx, course);
  addTocSlide(pptx, course);
  const screenCount = addModuleSlides(pptx, course);
  addTestSlides(pptx, course);
  addGlossarySlide(pptx, course);

  const data = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  console.log(`${LOG_PREFIX} PPTX generated: ${(buffer.length / 1024).toFixed(0)} KB, ${screenCount} screens`);
  return buffer;
}
