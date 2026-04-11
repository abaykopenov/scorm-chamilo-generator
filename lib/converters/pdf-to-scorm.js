// ---------------------------------------------------------------------------
// PDF → SCORM direct converter
// Reads a .pdf file, extracts text by pages, builds a course object
// compatible with buildScormPackage(). NO LLM — text stays unchanged.
// ---------------------------------------------------------------------------

import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createId } from "../ids.js";

const execFileAsync = promisify(execFile);

/**
 * Extract text from PDF using Python (pdfplumber for better structure).
 * Returns array of {pageNum, text} objects.
 */
async function extractPdfPages(buffer) {
  const tmpPath = join(tmpdir(), `pdf_${randomUUID()}.pdf`);
  try {
    await writeFile(tmpPath, buffer);

    const pythonScript = `
import sys, json
try:
    import pdfplumber
    pdf = pdfplumber.open(sys.argv[1])
    pages = []
    for i, page in enumerate(pdf.pages):
        text = page.extract_text() or ""
        pages.append({"pageNum": i + 1, "text": text.strip()})
    pdf.close()
    print(json.dumps(pages, ensure_ascii=False))
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pdfplumber", "-q"])
    import pdfplumber
    pdf = pdfplumber.open(sys.argv[1])
    pages = []
    for i, page in enumerate(pdf.pages):
        text = page.extract_text() or ""
        pages.append({"pageNum": i + 1, "text": text.strip()})
    pdf.close()
    print(json.dumps(pages, ensure_ascii=False))
`;

    const { stdout } = await execFileAsync("python3", ["-c", pythonScript, tmpPath], {
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024
    });

    return JSON.parse(stdout.trim());
  } finally {
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Build course structure from PDF pages.
 * Groups pages into modules by detecting heading patterns.
 */
function buildCourseFromPages(pages, fallbackTitle) {
  const courseId = createId("course");
  let courseTitle = fallbackTitle || "Документ PDF";

  // Try to detect title from first page
  if (pages.length > 0) {
    const firstPage = pages[0].text;
    const firstLine = firstPage.split("\n").find(l => l.trim().length > 5);
    if (firstLine && firstLine.length < 200) {
      courseTitle = firstLine.trim();
    }
  }

  // Detect heading patterns: lines that look like chapter/section headings
  const headingPatterns = [
    /^(Глава|Раздел|Модуль|Chapter|Module|Part)\s+\d/i,
    /^(\d+\.)\s+[А-ЯA-Z]/,
    /^[IVX]+\.\s+/,
  ];

  // Group pages into modules
  const moduleGroups = [];
  let currentGroup = { title: courseTitle, pages: [] };

  for (const page of pages) {
    if (!page.text) continue;

    const lines = page.text.split("\n").map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || "";

    // Check if this page starts a new module
    const isNewModule = headingPatterns.some(re => re.test(firstLine));

    if (isNewModule && currentGroup.pages.length > 0) {
      moduleGroups.push(currentGroup);
      currentGroup = { title: firstLine.slice(0, 120), pages: [] };
    }

    currentGroup.pages.push(page);
  }
  if (currentGroup.pages.length > 0) {
    moduleGroups.push(currentGroup);
  }

  // If only 1 group and many pages, split into ~5-page modules
  if (moduleGroups.length === 1 && moduleGroups[0].pages.length > 10) {
    const allPages = moduleGroups[0].pages;
    const chunkSize = 5;
    moduleGroups.length = 0;
    for (let i = 0; i < allPages.length; i += chunkSize) {
      const chunk = allPages.slice(i, i + chunkSize);
      const title = chunk[0].text.split("\n")[0]?.trim().slice(0, 120) || `Раздел ${Math.floor(i / chunkSize) + 1}`;
      moduleGroups.push({ title, pages: chunk });
    }
  }

  // Build modules
  const modules = moduleGroups.map(group => {
    const modId = createId("mod");
    const secId = createId("sec");
    const scoId = createId("sco");

    // All pages in group → blocks on one screen
    const blocks = [];
    for (const page of group.pages) {
      if (!page.text) continue;

      // Split page text into paragraphs
      const paragraphs = page.text.split(/\n{2,}/).filter(p => p.trim().length > 2);

      for (const para of paragraphs) {
        blocks.push({ type: "text", text: para.trim() });
      }
    }

    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "(Пустой раздел)" });
    }

    return {
      id: modId,
      title: group.title,
      sections: [{
        id: secId,
        title: "Содержание",
        scos: [{
          id: scoId,
          title: group.title,
          screens: [{
            title: group.title,
            blocks
          }]
        }]
      }]
    };
  });

  // Safety
  if (modules.length === 0) {
    modules.push({
      id: createId("mod"),
      title: courseTitle,
      sections: [{
        id: createId("sec"),
        title: courseTitle,
        scos: [{
          id: createId("sco"),
          title: courseTitle,
          screens: [{ title: "Пустой документ", blocks: [{ type: "text", text: "PDF не содержит текста." }] }]
        }]
      }]
    });
  }

  return {
    id: courseId,
    title: courseTitle,
    description: `Конвертирован из PDF. ${modules.length} модулей, ${pages.length} страниц.`,
    modules,
    finalTest: { enabled: false, questions: [] }
  };
}

/**
 * Main entry: buffer + fileName → course object
 */
export async function convertPdfToScorm(buffer, fileName) {
  const docTitle = (fileName || "document")
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  const pages = await extractPdfPages(buffer);
  return buildCourseFromPages(pages, docTitle);
}

/**
 * Read from file path
 */
export async function convertPdfFileToScorm(filePath, fileName) {
  const buffer = await readFile(filePath);
  return convertPdfToScorm(buffer, fileName);
}
