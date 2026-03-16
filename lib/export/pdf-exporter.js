/**
 * Export course to PDF (summary/handout format).
 * Uses pdfkit — zero external dependencies beyond Node.js.
 *
 * Structure: Cover → Table of Contents → Modules/Screens → Final Test → Answer Key
 */

import PDFDocument from "pdfkit";
import path from "node:path";
import { COLORS, FONTS, MARGINS } from "./pdf-styles.js";
import { buildGlossary } from "./glossary-builder.js";

const LOG_PREFIX = "[pdf-export]";

// DejaVu Sans supports Cyrillic, Latin, Greek — system-installed
const FONT_DIR = "/usr/share/fonts/truetype/dejavu";
const FONT_REGULAR = path.join(FONT_DIR, "DejaVuSans.ttf");
const FONT_BOLD = path.join(FONT_DIR, "DejaVuSans-Bold.ttf");

function sanitize(text) {
  if (text == null) return "";
  if (typeof text === "string") return text.replace(/\[object Object\]/gi, "").trim();
  if (typeof text === "object") return `${text.text || text.label || text.value || ""}`.trim();
  return String(text).trim();
}

function addCoverPage(doc, course) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.primary);

  const cx = doc.page.width / 2;
  doc.fillColor(COLORS.white)
    .font("bold")
    .fontSize(FONTS.titleSize)
    .text(sanitize(course.title) || "Учебный курс", MARGINS.page, 200, {
      width: doc.page.width - MARGINS.page * 2,
      align: "center"
    });

  const desc = sanitize(course.description);
  if (desc) {
    doc.moveDown(1)
      .font("main")
      .fontSize(FONTS.h3Size)
      .fillColor("#ffffffcc")
      .text(desc, MARGINS.page, doc.y, {
        width: doc.page.width - MARGINS.page * 2,
        align: "center"
      });
  }

  const modules = Array.isArray(course.modules) ? course.modules : [];
  const screenCount = modules.reduce(
    (sum, m) => sum + (m.sections || []).reduce(
      (ss, s) => ss + (s.scos || []).reduce(
        (cs, c) => cs + (c.screens || []).length, 0), 0), 0);

  doc.moveDown(3)
    .fontSize(FONTS.bodySize)
    .fillColor("#ffffffaa")
    .text(`${modules.length} модулей • ${screenCount} экранов`, MARGINS.page, doc.y, {
      width: doc.page.width - MARGINS.page * 2,
      align: "center"
    });

  doc.moveDown(1)
    .text(new Date().toLocaleDateString("ru-RU"), MARGINS.page, doc.y, {
      width: doc.page.width - MARGINS.page * 2,
      align: "center"
    });
}

function addModuleContent(doc, course) {
  const modules = Array.isArray(course.modules) ? course.modules : [];
  let screenNum = 0;

  for (let mi = 0; mi < modules.length; mi++) {
    const mod = modules[mi];
    doc.addPage();

    // Module header
    doc.rect(0, 0, doc.page.width, 80).fill(COLORS.primary);
    doc.fillColor(COLORS.white)
      .font("bold")
      .fontSize(FONTS.h1Size)
      .text(`Модуль ${mi + 1}: ${sanitize(mod.title)}`, MARGINS.page, 25, {
        width: doc.page.width - MARGINS.page * 2
      });

    doc.y = 100;
    doc.font("main").fillColor(COLORS.body);

    const sections = Array.isArray(mod.sections) ? mod.sections : [];
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      addSectionHeading(doc, `${mi + 1}.${si + 1} ${sanitize(section.title)}`);

      const scos = Array.isArray(section.scos) ? section.scos : [];
      for (const sco of scos) {
        const screens = Array.isArray(sco.screens) ? sco.screens : [];
        for (const screen of screens) {
          screenNum++;
          addScreen(doc, screen, screenNum);
        }
      }
    }
  }

  return screenNum;
}

function addSectionHeading(doc, text) {
  checkPageBreak(doc, 40);
  doc.moveDown(0.5)
    .font("bold")
    .fontSize(FONTS.h2Size)
    .fillColor(COLORS.primaryDark)
    .text(text, MARGINS.page, doc.y, { width: doc.page.width - MARGINS.page * 2 })
    .moveDown(0.3);

  // Underline
  doc.moveTo(MARGINS.page, doc.y)
    .lineTo(doc.page.width - MARGINS.page, doc.y)
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .stroke();

  doc.font("main").moveDown(0.4);
}

function addScreen(doc, screen, num) {
  checkPageBreak(doc, 60);

  // Screen title
  doc.font("bold")
    .fontSize(FONTS.h3Size)
    .fillColor(COLORS.heading)
    .text(`${num}. ${sanitize(screen.title)}`, MARGINS.page, doc.y, {
      width: doc.page.width - MARGINS.page * 2
    })
    .moveDown(0.3);
  doc.font("main");

  const blocks = Array.isArray(screen.blocks) ? screen.blocks : [];
  for (const block of blocks) {
    checkPageBreak(doc, 30);
    renderBlock(doc, block);
  }

  doc.moveDown(0.5);
}

function renderBlock(doc, block) {
  const type = `${block.type || "text"}`.trim();
  const contentWidth = doc.page.width - MARGINS.page * 2;

  if (type === "text") {
    const text = sanitize(block.text);
    if (!text) return;
    doc.fontSize(FONTS.bodySize)
      .fillColor(COLORS.body)
      .text(text, MARGINS.page, doc.y, { width: contentWidth, lineGap: FONTS.lineGap })
      .moveDown(0.3);
    return;
  }

  if (type === "list") {
    const items = Array.isArray(block.items) ? block.items : [];
    for (const item of items) {
      const text = sanitize(typeof item === "string" ? item : item?.text);
      if (!text) continue;
      checkPageBreak(doc, 20);
      doc.fontSize(FONTS.bodySize)
        .fillColor(COLORS.body)
        .text(`• ${text}`, MARGINS.page + MARGINS.bulletIndent, doc.y, {
          width: contentWidth - MARGINS.bulletIndent,
          lineGap: FONTS.lineGap
        })
        .moveDown(0.15);
    }
    doc.moveDown(0.2);
    return;
  }

  if (type === "table") {
    const cols = Array.isArray(block.columns) ? block.columns : [];
    const rows = Array.isArray(block.rows) ? block.rows : [];
    if (!cols.length && !rows.length) return;
    checkPageBreak(doc, 40);
    doc.moveDown(0.3);
    
    const colCount = Math.max(cols.length, (rows[0] && rows[0].length) || 1);
    const cellWidth = contentWidth / colCount;
    let currentY = doc.y;

    if (cols.length) {
      doc.font("bold").fontSize(FONTS.bodySize - 1).fillColor(COLORS.secondary);
      let maxRowY = currentY;
      cols.forEach((col, i) => {
        doc.text(sanitize(String(col)), MARGINS.page + (i * cellWidth) + 5, currentY + 5, { width: cellWidth - 10 });
        if (doc.y > maxRowY) maxRowY = doc.y;
      });
      currentY = maxRowY + 5;
      doc.moveTo(MARGINS.page, currentY).lineTo(MARGINS.page + contentWidth, currentY).strokeOpacity(0.2).stroke();
      currentY += 5;
    }

    doc.font("main").fontSize(FONTS.bodySize - 1).fillColor(COLORS.body);
    for (const row of rows) {
      checkPageBreak(doc, 30);
      let maxRowY = currentY;
      const rowArr = Array.isArray(row) ? row : [];
      rowArr.forEach((cell, i) => {
        doc.text(sanitize(String(cell)), MARGINS.page + (i * cellWidth) + 5, currentY + 5, { width: cellWidth - 10 });
        if (doc.y > maxRowY) maxRowY = doc.y;
      });
      currentY = maxRowY + 5;
      doc.moveTo(MARGINS.page, currentY).lineTo(MARGINS.page + contentWidth, currentY).strokeOpacity(0.1).stroke();
      currentY += 5;
      doc.y = currentY; // update global Y
    }
    doc.moveDown(0.5);
    return;
  }

  if (type === "note" || type === "warning") {
    const text = sanitize(block.text);
    if (!text) return;
    const bgColor = type === "warning" ? "#fce8e6" : "#e8f0fe";
    const textColor = type === "warning" ? COLORS.error : COLORS.primary;
    const label = type === "warning" ? "⚠️ " : "ℹ️ ";

    doc.rect(MARGINS.page, doc.y, contentWidth, 2).fill(textColor);
    doc.y += 4;
    doc.fontSize(FONTS.smallSize)
      .fillColor(textColor)
      .text(`${label}${text}`, MARGINS.page + 6, doc.y, {
        width: contentWidth - 12,
        lineGap: FONTS.lineGap
      })
      .moveDown(0.4);
  }
}

function addFinalTest(doc, course) {
  const test = course.finalTest;
  if (!test?.enabled && !Array.isArray(test?.questions)) return;
  const questions = Array.isArray(test.questions) ? test.questions : [];
  if (questions.length === 0) return;

  doc.addPage();
  doc.fontSize(FONTS.h1Size)
    .fillColor(COLORS.heading)
    .text("📝 Финальный тест", MARGINS.page, MARGINS.page, {
      width: doc.page.width - MARGINS.page * 2
    })
    .moveDown(1);

  const contentWidth = doc.page.width - MARGINS.page * 2;

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    checkPageBreak(doc, 80);

    doc.fontSize(FONTS.h3Size)
      .fillColor(COLORS.heading)
      .text(`${qi + 1}. ${sanitize(q.prompt)}`, MARGINS.page, doc.y, { width: contentWidth })
      .moveDown(0.3);

    const options = Array.isArray(q.options) ? q.options : [];
    const letters = ["a", "b", "c", "d", "e", "f"];
    for (let oi = 0; oi < options.length; oi++) {
      doc.fontSize(FONTS.bodySize)
        .fillColor(COLORS.body)
        .text(`   ${letters[oi] || oi + 1}) ${sanitize(options[oi])}`, MARGINS.page + 10, doc.y, {
          width: contentWidth - 10
        })
        .moveDown(0.1);
    }

    doc.moveDown(0.5);
  }

  // Answer key
  addAnswerKey(doc, questions);
}

function addAnswerKey(doc, questions) {
  doc.addPage();
  doc.fontSize(FONTS.h1Size)
    .fillColor(COLORS.heading)
    .text("🔑 Ответы к тесту", MARGINS.page, MARGINS.page, {
      width: doc.page.width - MARGINS.page * 2
    })
    .moveDown(1);

  const letters = ["a", "b", "c", "d", "e", "f"];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const correctIdx = Number(q.correctOptionIndex) || 0;
    const letter = letters[correctIdx] || `${correctIdx + 1}`;
    const correctText = sanitize((q.options || [])[correctIdx]);

    doc.fontSize(FONTS.bodySize)
      .fillColor(COLORS.accent)
      .text(`${qi + 1}. ${letter}) ${correctText}`, MARGINS.page, doc.y, {
        width: doc.page.width - MARGINS.page * 2
      })
      .moveDown(0.2);

    const explanation = sanitize(q.explanation);
    if (explanation) {
      doc.fontSize(FONTS.smallSize)
        .fillColor(COLORS.muted)
        .text(`   ${explanation}`, MARGINS.page + 10, doc.y, {
          width: doc.page.width - MARGINS.page * 2 - 10
        })
        .moveDown(0.3);
    }
  }
}

function addGlossaryPage(doc, course) {
  const { terms } = course.glossary || { terms: [] };
  if (!terms || terms.length === 0) return;

  doc.addPage();
  doc.font("bold")
    .fontSize(FONTS.h1Size)
    .fillColor(COLORS.heading)
    .text("📖 Глоссарий терминов", MARGINS.page, MARGINS.page, {
      width: doc.page.width - MARGINS.page * 2
    })
    .moveDown(1);

  doc.font("main");
  const contentWidth = doc.page.width - MARGINS.page * 2;

  for (const entry of terms) {
    checkPageBreak(doc, 40);

    // Term name (bold)
    doc.font("bold")
      .fontSize(FONTS.bodySize)
      .fillColor(COLORS.primaryDark)
      .text(entry.term, MARGINS.page, doc.y, { width: contentWidth });

    // Definition (if available)
    if (entry.definition) {
      doc.font("main")
        .fontSize(FONTS.smallSize || FONTS.bodySize - 1)
        .fillColor(COLORS.body)
        .text(entry.definition, MARGINS.page + 10, doc.y, {
          width: contentWidth - 10
        });
    }

    doc.moveDown(0.4);
  }
}

function checkPageBreak(doc, neededHeight) {
  const bottomMargin = doc.page.height - MARGINS.page;
  if (doc.y + neededHeight > bottomMargin) {
    doc.addPage();
  }
}

/**
 * Export course JSON to PDF Buffer.
 * @param {object} course - Course JSON object
 * @returns {Promise<Buffer>} PDF file as Buffer
 */
export async function exportCourseToPdf(course) {
  console.log(`${LOG_PREFIX} Generating PDF for "${sanitize(course.title)}"`);

  // Pre-build glossary with LLM definitions if not already attached
  if (!course.glossary || !Array.isArray(course.glossary?.terms)) {
    try {
      const { buildGlossary } = await import("./glossary-builder.js");
      course.glossary = await buildGlossary(course);
    } catch (glossaryError) {
      console.warn(`${LOG_PREFIX} Glossary generation failed: ${glossaryError?.message}`);
    }
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: MARGINS.page, bottom: MARGINS.page, left: MARGINS.page, right: MARGINS.page },
        info: {
          Title: sanitize(course.title) || "Учебный курс",
          Author: "SCORM-Chamilo Generator",
          Subject: sanitize(course.description)
        }
      });

      // Register DejaVu Sans for Cyrillic support
      doc.registerFont("main", FONT_REGULAR);
      doc.registerFont("bold", FONT_BOLD);
      doc.font("main");

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => {
        const buffer = Buffer.concat(chunks);
        console.log(`${LOG_PREFIX} PDF generated: ${(buffer.length / 1024).toFixed(0)} KB`);
        resolve(buffer);
      });
      doc.on("error", reject);

      addCoverPage(doc, course);
      doc.addPage();
      addModuleContent(doc, course);
      addFinalTest(doc, course);
      addGlossaryPage(doc, course);

      doc.end();
    } catch (err) {
      console.error(`${LOG_PREFIX} PDF generation failed: ${err?.message || err}`);
      reject(err);
    }
  });
}
