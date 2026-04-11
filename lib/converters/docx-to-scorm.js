// ---------------------------------------------------------------------------
// DOCX → SCORM direct converter  (v3 — formatting, images, tables)
// Reads a .docx file, extracts structure and text, builds a course object
// compatible with buildScormPackage(). NO LLM — text stays unchanged.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import mammoth from "mammoth";
import { createId } from "../ids.js";

const MIN_PARA_LENGTH = 2;

/**
 * Parse DOCX buffer using mammoth → HTML, then extract elements
 * including tables, lists, headings, images with formatting preserved.
 */
async function parseDocxElements(buffer) {
  // Collect images from DOCX
  const images = [];

  const result = await mammoth.convertToHtml({ buffer }, {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Title'] => h1:fresh",
    ],
    convertImage: mammoth.images.imgElement(async (image) => {
      try {
        const imgBuffer = await image.read();
        const base64 = imgBuffer.toString("base64");
        const mime = image.contentType || "image/png";
        const src = `data:${mime};base64,${base64}`;
        const id = `img_${images.length}`;
        images.push({ id, src, mime });
        return { src };
      } catch {
        return { src: "" };
      }
    })
  });

  const html = result.value;
  const elements = [];

  let pos = 0;
  const len = html.length;

  while (pos < len) {
    while (pos < len && /\s/.test(html[pos])) pos++;
    if (pos >= len) break;

    if (html[pos] !== '<') { pos++; continue; }

    // Heading
    const headingResult = matchTag(html, pos, /^h([1-3])$/i);
    if (headingResult) {
      const text = stripAllTags(headingResult.inner).trim();
      if (text) {
        elements.push({ type: "heading", level: parseInt(headingResult.groups[0], 10), text });
      }
      pos = headingResult.end;
      continue;
    }

    // Table
    const tableResult = matchTag(html, pos, /^table$/i);
    if (tableResult) {
      const table = parseHtmlTable(tableResult.inner);
      if (table) elements.push(table);
      pos = tableResult.end;
      continue;
    }

    // List (ul/ol)
    const listResult = matchTag(html, pos, /^(ul|ol)$/i);
    if (listResult) {
      const items = [...listResult.inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map(m => preserveInlineHtml(m[1]).trim())
        .filter(Boolean);
      if (items.length > 0) {
        elements.push({ type: "list", items });
      }
      pos = listResult.end;
      continue;
    }

    // Paragraph
    const paraResult = matchTag(html, pos, /^p$/i);
    if (paraResult) {
      const rawInner = paraResult.inner;

      // Check for image inside paragraph
      const imgMatch = rawInner.match(/<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/i);
      if (imgMatch) {
        const src = imgMatch[1];
        const altMatch = rawInner.match(/alt\s*=\s*["']([^"']*)["']/i);
        elements.push({ type: "image", src, alt: altMatch?.[1] || "" });
        pos = paraResult.end;
        continue;
      }

      const plainText = stripAllTags(rawInner).trim();
      const richHtml = preserveInlineHtml(rawInner).trim();

      if (plainText.length >= MIN_PARA_LENGTH) {
        // Store both plain text and rich HTML
        elements.push({
          type: "text",
          text: plainText,
          html: richHtml !== plainText ? richHtml : undefined
        });
      }
      pos = paraResult.end;
      continue;
    }

    pos++;
  }

  return elements;
}

/**
 * Match an opening tag at position, find its closing tag, return inner content.
 */
function matchTag(html, pos, tagPattern) {
  const openMatch = html.slice(pos).match(/^<([a-z][a-z0-9]*)[^>]*>/i);
  if (!openMatch) return null;

  const tagName = openMatch[1];
  const groups = tagName.match(tagPattern);
  if (!groups) return null;

  const afterOpen = pos + openMatch[0].length;
  const closeTag = `</${tagName}>`;
  const closeIdx = findClosingTag(html, afterOpen, tagName);
  if (closeIdx === -1) return null;

  return {
    tag: tagName,
    groups: groups.slice(1),
    inner: html.slice(afterOpen, closeIdx),
    end: closeIdx + closeTag.length
  };
}

/**
 * Find the matching closing tag, handling nesting.
 */
function findClosingTag(html, startPos, tagName) {
  const openRe = new RegExp(`<${tagName}[\\s>]`, 'gi');
  const closeRe = new RegExp(`</${tagName}>`, 'gi');
  let depth = 1;
  let pos = startPos;

  while (pos < html.length && depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;

    const openMatch = openRe.exec(html);
    const closeMatch = closeRe.exec(html);

    if (!closeMatch) return -1;

    if (openMatch && openMatch.index < closeMatch.index) {
      depth++;
      pos = openMatch.index + openMatch[0].length;
    } else {
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.index + closeMatch[0].length;
    }
  }
  return -1;
}

/**
 * Parse HTML table into a structured block.
 */
function parseHtmlTable(tableHtml) {
  const rows = [];
  const trMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const tr of trMatches) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(td => stripAllTags(td[1]).trim());
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return null;

  if (rows.length === 1) {
    return { type: "table", columns: rows[0], rows: [] };
  }
  return { type: "table", columns: rows[0], rows: rows.slice(1) };
}

/**
 * Strip ALL HTML tags — for plain text extraction.
 */
function stripAllTags(html) {
  return decodeEntities(
    `${html || ""}`
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

/**
 * Preserve inline formatting tags (bold, italic, links, code) — strip only block tags.
 * Sanitizes to only allow safe inline elements.
 */
function preserveInlineHtml(html) {
  let result = `${html || ""}`;

  // Convert <br> to newline
  result = result.replace(/<br\s*\/?>/gi, "\n");

  // Keep allowed inline tags, strip everything else
  // Allowed: <strong>, <b>, <em>, <i>, <a>, <code>, <u>, <s>, <sub>, <sup>
  const allowedTags = /^\/?(strong|b|em|i|a|code|u|s|sub|sup)$/i;

  // Replace disallowed tags
  result = result.replace(/<\/?([a-z][a-z0-9]*)[^>]*>/gi, (match, tagName) => {
    if (allowedTags.test(tagName)) {
      // For <a> tags, sanitize to only keep href
      if (/^a$/i.test(tagName) && !match.startsWith("</")) {
        const hrefMatch = match.match(/href\s*=\s*["']([^"']+)["']/i);
        if (hrefMatch) {
          return `<a href="${hrefMatch[1]}" target="_blank">`;
        }
        return "<a>";
      }
      return match;
    }
    return "";
  });

  return decodeEntities(result);
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Merge consecutive short text elements into longer paragraphs.
 */
function mergeShortTexts(elements) {
  const merged = [];
  let buffer = [];
  let htmlBuffer = [];

  function flushBuffer() {
    if (buffer.length === 0) return;
    const combined = buffer.join("\n");
    const combinedHtml = htmlBuffer.some(h => h) ? htmlBuffer.map((h, i) => h || buffer[i]).join("<br>") : undefined;
    merged.push({ type: "text", text: combined, html: combinedHtml });
    buffer = [];
    htmlBuffer = [];
  }

  for (const el of elements) {
    if (el.type === "text") {
      const isShort = el.text.length < 80;
      const isCodeLine = /^[\$#]|^[a-zA-Z_\-\/]+\s*\\?$|^\|/.test(el.text.trim());
      const isOneWord = el.text.trim().split(/\s+/).length <= 3 && el.text.length < 40;

      if (isShort && (isCodeLine || isOneWord)) {
        buffer.push(el.text);
        htmlBuffer.push(el.html || null);
      } else {
        flushBuffer();
        merged.push(el);
      }
    } else {
      flushBuffer();
      merged.push(el);
    }
  }
  flushBuffer();
  return merged;
}

/**
 * Group elements into a FLAT course structure:
 *   Heading1 → Module (1 section → 1 SCO → 1 screen)
 *   Heading2/3 → text heading blocks within the same screen
 *   All other → content blocks within the same screen
 */
function buildCourseFromElements(elements, fallbackTitle) {
  const courseId = createId("course");
  let courseTitle = fallbackTitle || "Документ";
  
  const firstHeadingIdx = elements.findIndex(el => el.type === "heading");
  if (firstHeadingIdx > 0) {
    const preTexts = elements.slice(0, firstHeadingIdx).filter(e => e.type === "text" && e.text.length > 10);
    if (preTexts.length > 0) courseTitle = preTexts[0].text;
  } else if (firstHeadingIdx === 0) {
    courseTitle = elements[0].text;
  }

  const mergedElements = mergeShortTexts(elements);

  // Split by H1
  const moduleGroups = [];
  let currentGroup = { title: courseTitle, elements: [] };

  for (const el of mergedElements) {
    if (el.type === "heading" && el.level === 1) {
      if (currentGroup.elements.length > 0) {
        moduleGroups.push(currentGroup);
      }
      currentGroup = { title: el.text, elements: [] };
      continue;
    }

    // H2/H3 → bold heading block (no structural split)
    if (el.type === "heading" && (el.level === 2 || el.level === 3)) {
      const tag = el.level === 2 ? "h3" : "h4";
      currentGroup.elements.push({
        type: "text",
        text: el.text,
        html: `<${tag}>${el.text}</${tag}>`
      });
      continue;
    }

    currentGroup.elements.push(el);
  }
  if (currentGroup.elements.length > 0) {
    moduleGroups.push(currentGroup);
  }

  // Build modules
  const modules = moduleGroups.map(group => {
    const modId = createId("mod");
    const secId = createId("sec");
    const scoId = createId("sco");

    const firstTextBlock = group.elements.find(b => b.type === "text");
    const screenTitle = firstTextBlock
      ? firstTextBlock.text.slice(0, 120).replace(/\s+/g, " ").trim()
      : group.title;

    return {
      id: modId,
      title: group.title,
      sections: [{
        id: secId,
        title: "Содержание",
        scos: [{
          id: scoId,
          title: screenTitle,
          screens: [{
            title: screenTitle,
            blocks: group.elements
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
          screens: [{
            title: "Пустой документ",
            blocks: [{ type: "text", text: "Документ не содержит текста." }]
          }]
        }]
      }]
    });
  }

  for (const mod of modules) {
    if (mod.sections.length === 0) {
      mod.sections.push({
        id: createId("sec"),
        title: mod.title,
        scos: [{ id: createId("sco"), title: mod.title, screens: [{ title: mod.title, blocks: [{ type: "text", text: mod.title }] }] }]
      });
    }
    for (const sec of mod.sections) {
      if (sec.scos.length === 0) {
        sec.scos.push({
          id: createId("sco"),
          title: sec.title,
          screens: [{ title: sec.title, blocks: [{ type: "text", text: sec.title }] }]
        });
      }
    }
  }

  return {
    id: courseId,
    title: courseTitle,
    description: `Конвертирован из DOCX. ${modules.length} модулей.`,
    modules,
    finalTest: { enabled: false, questions: [] }
  };
}

/**
 * Main entry point: buffer + fileName → course object
 */
export async function convertDocxToScorm(buffer, fileName) {
  const docTitle = (fileName || "document")
    .replace(/\.docx?$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  const elements = await parseDocxElements(buffer);
  const course = buildCourseFromElements(elements, docTitle);

  return course;
}

/**
 * Read from file path
 */
export async function convertDocxFileToScorm(filePath, fileName) {
  const buffer = await readFile(filePath);
  return convertDocxToScorm(buffer, fileName);
}
