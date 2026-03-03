/**
 * File Processor — extract text from uploaded files (PDF, DOCX, TXT)
 * Splits large documents into chunks for LLM context
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Extract text from a file based on its extension
 */
export async function extractText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = await readFile(filePath);

    switch (ext) {
        case ".txt":
        case ".md":
            return buffer.toString("utf8");

        case ".pdf":
            return await extractPdf(buffer);

        case ".docx":
            return await extractDocx(buffer);

        default:
            // Try as plain text
            return buffer.toString("utf8");
    }
}

/**
 * Extract text from PDF using simple pattern matching
 * (No external dependency — basic extraction)
 */
async function extractPdf(buffer) {
    try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        const result = await parser.getText();
        const text = result.text || "";
        console.log(`[FileProcessor] PDF extracted: ${text.length} chars, ${result.pages?.length || "?"} pages`);
        await parser.destroy().catch(() => { });
        return text;
    } catch (err) {
        console.error("[FileProcessor] pdf-parse error:", err.message);
    }

    // Fallback: basic text extraction from PDF binary
    const text = buffer.toString("latin1");
    const chunks = [];
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = streamRegex.exec(text))) {
        const content = match[1]
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "")
            .replace(/[^\x20-\x7E\u0400-\u04FF\n]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        if (content.length > 20) chunks.push(content);
    }
    if (chunks.join("").length < 100) {
        return "[PDF: не удалось извлечь текст]";
    }
    return chunks.join("\n");
}

/**
 * Extract text from DOCX (ZIP with XML)
 */
async function extractDocx(buffer) {
    try {
        const mammoth = require("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        console.log(`[FileProcessor] DOCX extracted: ${result.value.length} chars`);
        return result.value || "";
    } catch (err) {
        console.error("[FileProcessor] mammoth error:", err.message);
    }

    // Fallback: basic extraction from DOCX XML
    const text = buffer.toString("utf8");
    const paragraphs = [];
    const pRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    while ((match = pRegex.exec(text))) {
        if (match[1].trim()) paragraphs.push(match[1]);
    }
    return paragraphs.join(" ") || "[DOCX: не удалось извлечь текст. Установите mammoth: npm i mammoth]";
}

/**
 * Split text into chunks for LLM context
 * @param {string} text - full text
 * @param {number} maxChars - max chars per chunk (roughly ~4 chars per token)
 * @returns {string[]}
 */
export function chunkText(text, maxChars = 30000) {
    if (!text || text.length <= maxChars) return [text].filter(Boolean);

    const chunks = [];
    const paragraphs = text.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
        if ((current + "\n\n" + para).length > maxChars) {
            if (current) chunks.push(current.trim());
            // If single paragraph is too long, split by sentences
            if (para.length > maxChars) {
                const sentences = para.split(/(?<=[.!?])\s+/);
                current = "";
                for (const s of sentences) {
                    if ((current + " " + s).length > maxChars) {
                        if (current) chunks.push(current.trim());
                        current = s;
                    } else {
                        current += (current ? " " : "") + s;
                    }
                }
            } else {
                current = para;
            }
        } else {
            current += (current ? "\n\n" : "") + para;
        }
    }
    if (current.trim()) chunks.push(current.trim());

    return chunks;
}

/**
 * Process multiple uploaded files into chunks
 * @param {string[]} filePaths
 * @returns {Promise<{chunks: string[], totalChars: number, files: string[]}>}
 */
export async function processFiles(filePaths) {
    const allText = [];
    const files = [];

    for (const fp of filePaths) {
        try {
            const text = await extractText(fp);
            if (text && text.length > 10) {
                allText.push(text);
                files.push(path.basename(fp));
            }
        } catch (err) {
            console.error(`[FileProcessor] Error processing ${fp}:`, err.message);
        }
    }

    const combined = allText.join("\n\n---\n\n");
    const chunks = chunkText(combined);

    return {
        chunks,
        totalChars: combined.length,
        files
    };
}
