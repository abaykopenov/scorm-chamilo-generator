// ---------------------------------------------------------------------------
// lib/parser/toc-extractor.js — Extract Table of Contents from parsed text
// ---------------------------------------------------------------------------
// Uses heuristic regex patterns to detect TOC entries in document text.
// Supports Russian and English chapter/section naming conventions.
// Falls back to structural heading detection when no explicit TOC found.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

/**
 * Try to extract TOC via pdfplumber's outline/bookmarks support.
 * Returns structured TOC or null if not available.
 */
function extractTocViaPython(filePath) {
  const script = `
import sys
import json

try:
    import pdfplumber
except ImportError:
    print(json.dumps({"toc": [], "method": "unavailable"}), flush=True)
    sys.exit(0)

try:
    file_path = sys.argv[1]
    toc = []
    
    with pdfplumber.open(file_path) as pdf:
        # Try PDF outlines/bookmarks first
        if hasattr(pdf, 'metadata') and pdf.metadata:
            pass  # metadata doesn't contain TOC
        
        # Heuristic: scan first 10 pages for TOC-like content
        toc_pages_text = []
        for i, page in enumerate(pdf.pages[:15]):
            text = page.extract_text() or ""
            # Check if this page looks like a TOC page
            lines = [l.strip() for l in text.split("\\n") if l.strip()]
            
            # Count lines ending with page numbers (TOC pattern)
            toc_line_count = 0
            for line in lines:
                # Russian: "Глава 1. Основы .......... 15"
                # English: "Chapter 1. Basics .......... 15"
                if __import__('re').search(r'[.…]{3,}\\s*\\d{1,4}\\s*$', line):
                    toc_line_count += 1
                elif __import__('re').search(r'\\s{3,}\\d{1,4}\\s*$', line):
                    toc_line_count += 1
            
            if toc_line_count >= 3:
                toc_pages_text.append(text)
        
        # Parse TOC entries from detected TOC pages
        import re
        for page_text in toc_pages_text:
            for line in page_text.split("\\n"):
                line = line.strip()
                if not line:
                    continue
                
                # Pattern: "Title ..... PageNum" or "Title    PageNum"
                match = re.match(r'^(.+?)[.…\\s]{3,}(\\d{1,4})\\s*$', line)
                if not match:
                    continue
                
                title = match.group(1).strip()
                page_num = int(match.group(2))
                
                if len(title) < 3 or page_num < 1:
                    continue
                
                # Determine level
                level = 2  # default: subsection
                if re.match(r'^(Глава|Раздел|Часть|Chapter|Part|Section)\\s', title, re.IGNORECASE):
                    level = 1
                elif re.match(r'^\\d+\\.\\s', title):
                    level = 1
                elif re.match(r'^\\d+\\.\\d+\\.?\\s', title):
                    level = 2
                elif re.match(r'^\\d+\\.\\d+\\.\\d+\\.?\\s', title):
                    level = 3
                
                toc.append({
                    "level": level,
                    "title": title,
                    "page": page_num
                })
    
    print(json.dumps({"toc": toc, "method": "pdfplumber-heuristic"}), flush=True)
    sys.exit(0)

except Exception as e:
    print(json.dumps({"toc": [], "method": "error", "error": str(e)}), flush=True)
    sys.exit(0)
`.trim();

  try {
    const pythonPath = process.platform === "win32" ? "python" : "python3";
    const result = execFileSync(pythonPath, ["-c", script, filePath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true
    });

    const parsed = JSON.parse(result.trim());
    return parsed?.toc?.length > 0 ? parsed.toc : null;
  } catch {
    return null;
  }
}

/**
 * Extract TOC from already-parsed plain text using regex heuristics.
 * This is a fallback when PDF-level extraction isn't available.
 */
function extractTocFromText(text) {
  if (!text || text.length < 100) return [];

  const lines = text.split("\n");
  const toc = [];

  // Heading patterns for Russian and English
  const headingPatterns = [
    // "Глава 1. Основы робототехники" or "Глава 1: Основы"
    { regex: /^(?:Глава|Раздел|Часть)\s+(\d+)[.:]\s*(.+)/i, level: 1 },
    // "Chapter 1. Introduction" or "Chapter 1: Introduction"
    { regex: /^(?:Chapter|Part|Section)\s+(\d+)[.:]\s*(.+)/i, level: 1 },
    // "1. Основы робототехники"
    { regex: /^(\d{1,2})\.\s+([А-ЯA-Z][^\n]{5,80})$/, level: 1 },
    // "1.1 Установка ROS" or "1.1. Установка"
    { regex: /^(\d{1,2}\.\d{1,2})\.?\s+([А-ЯA-Zа-яa-z][^\n]{5,80})$/, level: 2 },
    // "1.1.1 Подраздел"
    { regex: /^(\d{1,2}\.\d{1,2}\.\d{1,2})\.?\s+([А-ЯA-Zа-яa-z][^\n]{5,80})$/, level: 3 },
  ];

  // Also detect TOC page entries: "Title ..... 15"
  const tocEntryPattern = /^(.{5,80}?)\s*[.…]{3,}\s*(\d{1,4})\s*$/;

  let isTocPage = false;
  let tocEntryCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;

    // Check for TOC page entries
    const tocMatch = tocEntryPattern.exec(trimmed);
    if (tocMatch) {
      tocEntryCount++;
      const title = tocMatch[1].trim();
      const page = parseInt(tocMatch[2], 10);
      
      if (title.length >= 3 && page >= 1) {
        let level = 2;
        if (/^(?:Глава|Раздел|Часть|Chapter|Part)\s/i.test(title)) level = 1;
        if (/^\d+\.\s/.test(title)) level = 1;
        if (/^\d+\.\d+/.test(title)) level = 2;
        
        toc.push({ level, title, page });
      }
      
      if (tocEntryCount >= 3) isTocPage = true;
      continue;
    }

    // If we already found TOC entries, stop looking at headings
    if (isTocPage && tocEntryCount > 0 && toc.length > 0) {
      // If we hit a non-TOC line after TOC entries, we're past the TOC
      if (!tocMatch) {
        isTocPage = false;
      }
      continue;
    }

    // Check structural headings (only if no TOC page found)
    if (toc.length === 0 || !isTocPage) {
      for (const pattern of headingPatterns) {
        const match = pattern.regex.exec(trimmed);
        if (match) {
          const title = match[2] ? match[2].trim() : trimmed;
          // Skip if it looks like a regular sentence
          if (title.length > 100) continue;
          if (/[.!?]$/.test(title) && title.length > 60) continue;
          
          toc.push({
            level: pattern.level,
            title: title,
            page: 0  // unknown from text
          });
          break;
        }
      }
    }
  }

  return toc;
}

/**
 * Deduplicate and clean TOC entries.
 */
function cleanToc(toc) {
  if (!toc || toc.length === 0) return [];

  const seen = new Set();
  const cleaned = [];

  for (const entry of toc) {
    const key = `${entry.title}`.trim().toLowerCase().slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip very short entries
    if (`${entry.title}`.trim().length < 3) continue;

    // Skip entries that look like metadata
    if (/^(?:Оглавление|Содержание|Contents|Table of Contents|Предисловие|Foreword)$/i.test(entry.title)) continue;

    cleaned.push({
      level: entry.level || 1,
      title: `${entry.title}`.trim(),
      page: entry.page || 0
    });
  }

  return cleaned;
}

/**
 * Extract Table of Contents from a PDF file and/or its parsed text.
 * Tries PDF-level extraction first, falls back to text heuristics.
 *
 * @param {string|null} filePath - Path to the PDF file (if available)
 * @param {string|null} parsedText - Already-extracted text (if available)
 * @returns {Array<{level: number, title: string, page: number}>}
 */
export function extractTableOfContents(filePath, parsedText = null) {
  let toc = null;

  // Try PDF-level extraction first
  if (filePath) {
    try {
      toc = extractTocViaPython(filePath);
    } catch {
      // Silently fall back
    }
  }

  // Fall back to text heuristics
  if (!toc || toc.length === 0) {
    if (parsedText) {
      toc = extractTocFromText(parsedText);
    }
  }

  const cleaned = cleanToc(toc || []);
  
  if (cleaned.length > 0) {
    console.log(`[toc-extractor] 📋 Extracted ${cleaned.length} TOC entries (${cleaned.filter(e => e.level === 1).length} chapters)`);
  }

  return cleaned;
}

/**
 * Format TOC entries for use in the generation planner.
 * Returns a structured summary string.
 */
export function formatTocForPlanner(toc) {
  if (!Array.isArray(toc) || toc.length === 0) return "";

  const lines = toc.map(entry => {
    const indent = "  ".repeat(Math.max(0, entry.level - 1));
    const pageInfo = entry.page > 0 ? ` (p.${entry.page})` : "";
    return `${indent}- ${entry.title}${pageInfo}`;
  });

  return [
    "BOOK TABLE OF CONTENTS (use this structure to organize course modules):",
    ...lines
  ].join("\n");
}
