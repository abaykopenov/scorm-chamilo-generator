import { execFileSync } from "node:child_process";

/**
 * Build Docling-based PDF extractor script.
 * Uses Docling as primary parser for superior text extraction quality,
 * with automatic fallback to pdfplumber/pypdf if Docling is not installed.
 *
 * Docling advantages:
 * - Preserves document structure (headings, paragraphs, lists, tables)
 * - Correct Unicode handling (no Cyrillic/Latin homoglyph confusion)
 * - No stuck-together words
 * - Clean table extraction
 * - Automatic TOC/metadata detection
 */
export function buildPdfExtractorScript() {
  return `
import sys
import json
import re
import traceback

# ============================
# Shared cleanup functions
# ============================

CYR_TO_LAT = {
    '\\u0430': 'a', '\\u0410': 'A', '\\u0432': 'b', '\\u0412': 'B',
    '\\u0441': 'c', '\\u0421': 'C', '\\u0435': 'e', '\\u0415': 'E',
    '\\u041d': 'H', '\\u043a': 'k', '\\u041a': 'K', '\\u043c': 'm',
    '\\u041c': 'M', '\\u043d': 'n', '\\u043e': 'o', '\\u041e': 'O',
    '\\u0440': 'p', '\\u0420': 'P', '\\u0442': 't', '\\u0422': 'T',
    '\\u0443': 'y', '\\u0445': 'x', '\\u0425': 'X', '\\u0456': 'i',
    '\\u0406': 'I'
}

LAT_TO_CYR = {
    'a': '\\u0430', 'A': '\\u0410', 'c': '\\u0441', 'C': '\\u0421',
    'e': '\\u0435', 'E': '\\u0415', 'o': '\\u043e', 'O': '\\u041e',
    'p': '\\u0440', 'P': '\\u0420', 'x': '\\u0445', 'X': '\\u0425',
    'y': '\\u0443', 'H': '\\u041d', 'K': '\\u041a', 'M': '\\u041c',
    'T': '\\u0422', 'B': '\\u0412'
}

def fix_mixed_script(text):
    """Fix words with mixed Cyrillic and Latin characters (homoglyphs)."""
    if not text:
        return text

    def fix_word(match):
        word = match.group(0)
        lat = sum(1 for c in word if 'a' <= c.lower() <= 'z')
        cyr = sum(1 for c in word if '\\u0400' <= c <= '\\u04ff')
        if lat == 0 or cyr == 0:
            return word
        if lat + cyr < 3:
            return word
        if '_' in word or '.' in word:
            return ''.join(CYR_TO_LAT.get(c, c) for c in word)
        if lat >= cyr:
            return ''.join(CYR_TO_LAT.get(c, c) for c in word)
        else:
            return ''.join(LAT_TO_CYR.get(c, c) for c in word)

    text = re.sub(r'\\b[\\w.]+\\b', fix_word, text)
    return text

def clean_extracted_text(text):
    """Apply common cleaning to extracted text."""
    if not text:
        return text

    # Remove (cid:NNN) font artifacts
    text = re.sub(r'\\(cid:\\d+\\)', ' ', text)

    # Remove TOC dot-leaders
    text = re.sub(r'\\s*\\.{3,}\\s*\\d{1,4}', '', text)
    text = re.sub(r'\\s*\\.{4,}\\s*', ' ', text)

    # Fix hyphenated breaks
    text = re.sub(r'(\\w)-\\s*\\n\\s*(\\w)', r'\\1\\2', text)

    # Fix mixed Cyrillic/Latin
    text = fix_mixed_script(text)

    # Remove ISBN, copyright
    text = re.sub(r'ISBN[\\s:\\-]*[\\dXx\\-]{10,}', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\\u00a9\\s*\\d{4}.*', '', text)

    # Remove contact info
    text = re.sub(r'[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}', '', text)
    text = re.sub(r'https?://[^\\s]+', '', text)

    # Clean whitespace
    text = re.sub(r'[ \\t]{2,}', ' ', text)
    text = re.sub(r'\\n{3,}', '\\n\\n', text)

    return text.strip()

def is_metadata_section(text):
    """Check if text is a metadata/TOC section to skip."""
    if not text or len(text.strip()) < 30:
        return True

    lower = text.lower()
    metadata_patterns = [
        r'ISBN[\\s:\\-]*[\\dXx\\-]+',
        r'\\u00a9\\s*\\d{4}',
        r'All\\s*rights\\s*reserved',
        r'Published\\s*by',
        r'Copyright',
        r'\\u0412\\u0441\\u0435\\s*\\u043f\\u0440\\u0430\\u0432\\u0430\\s*\\u0437\\u0430\\u0449\\u0438\\u0449\\u0435\\u043d\\u044b',
        r'\\u0418\\u0437\\u0434\\u0430\\u0442\\u0435\\u043b\\u044c\\u0441\\u0442\\u0432[\\u043e\\u0430]',
    ]
    match_count = sum(1 for p in metadata_patterns if re.search(p, text, re.IGNORECASE))
    return match_count >= 2

# ============================
# Docling-based parser
# ============================

def parse_with_docling(file_path):
    """Parse PDF using Docling for high-quality structured extraction."""
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(file_path)

    # Export as Markdown — preserves headings, lists, tables
    markdown_text = result.document.export_to_markdown()

    # Also try to get structured data for better processing
    doc_dict = result.document.export_to_dict()

    # Filter metadata sections from markdown
    sections = markdown_text.split('\\n\\n')
    filtered = []
    for section in sections:
        if is_metadata_section(section):
            continue
        filtered.append(section)

    text = '\\n\\n'.join(filtered)
    text = clean_extracted_text(text)

    return text, "docling"

# ============================
# pdfplumber/pypdf fallback
# ============================

def detect_metadata_page(text):
    if not text or len(text.strip()) < 50:
        return True
    metadata_patterns = [
        r'ISBN[\\s:\\-]*[\\dXx\\-]+',
        r'\\u00a9\\s*\\d{4}',
        r'\\u0412\\u0441\\u0435\\s*\\u043f\\u0440\\u0430\\u0432\\u0430\\s*\\u0437\\u0430\\u0449\\u0438\\u0449\\u0435\\u043d\\u044b',
        r'\\u0418\\u0437\\u0434\\u0430\\u0442\\u0435\\u043b\\u044c\\u0441\\u0442\\u0432[\\u043e\\u0430]',
        r'All\\s*rights\\s*reserved',
        r'Published\\s*by',
        r'Copyright',
    ]
    match_count = sum(1 for p in metadata_patterns if re.search(p, text, re.IGNORECASE))
    return match_count >= 2

def clean_header_footer(text, page_num):
    lines = text.split('\\n')
    cleaned = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r'^\\d{1,4}$', stripped):
            continue
        if re.match(r'^\\d+\\s+[\\u0410-\\u042f\\u0430-\\u044fA-Za-z]', stripped) and len(stripped) < 60:
            if re.match(r'^\\d+\\s+\\S+\\s+\\S+\\.?$', stripped):
                continue
        cleaned.append(line)
    return '\\n'.join(cleaned)

def remove_contact_info(text):
    text = re.sub(r'[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}', '', text)
    text = re.sub(r'(?:\\u0442\\u0435\\u043b\\.?|phone|\\+7|8\\s*[\\(\\-])\\s*[\\d\\(\\)\\-\\s]{7,}', '', text, flags=re.IGNORECASE)
    text = re.sub(r'https?://[^\\s]+', '', text)
    return text

def has_garbled_words(text):
    if not text:
        return False
    words = text.split()
    for word in words:
        runs = re.findall(r'[\\u0400-\\u04FF]+', word)
        for run in runs:
            if len(run) > 18:
                return True
    return False

def remove_garbled_sentences(text):
    if not text:
        return text
    sentences = re.split(r'(?<=[.!?])\\s+', text)
    clean = [s for s in sentences if not has_garbled_words(s)]
    return ' '.join(clean)

def parse_with_pdfplumber(file_path):
    """Fallback parser using pdfplumber."""
    try:
        import pdfplumber
        USE_PDFPLUMBER = True
    except ImportError:
        USE_PDFPLUMBER = False

    if not USE_PDFPLUMBER:
        try:
            from pypdf import PdfReader
        except ImportError:
            try:
                from PyPDF2 import PdfReader
            except ImportError:
                raise RuntimeError("Neither docling, pdfplumber, nor pypdf installed.")

    text_parts = []

    if USE_PDFPLUMBER:
        with pdfplumber.open(file_path) as pdf:
            for page_num, page in enumerate(pdf.pages):
                raw_check = page.extract_text() or ""
                if page_num < 3 and detect_metadata_page(raw_check):
                    continue
                page_text = page.extract_text(
                    x_tolerance=3, y_tolerance=3, layout=False
                ) or ""
                if not page_text:
                    continue
                page_text = clean_header_footer(page_text, page_num)
                page_text = remove_contact_info(page_text)
                page_text = remove_garbled_sentences(page_text)
                if page_text.strip():
                    text_parts.append(page_text)
    else:
        reader = PdfReader(file_path)
        for page_num, page in enumerate(reader.pages):
            page_text = page.extract_text()
            if not page_text:
                continue
            if page_num < 3 and detect_metadata_page(page_text):
                continue
            page_text = clean_header_footer(page_text, page_num)
            page_text = remove_contact_info(page_text)
            if page_text.strip():
                text_parts.append(page_text)

    raw_text = "\\n\\n".join(text_parts)
    text = clean_extracted_text(raw_text)
    parser_name = "pdfplumber" if USE_PDFPLUMBER else "pypdf"
    return text, parser_name

# ============================
# Main: try Docling first, fallback to pdfplumber
# ============================

try:
    file_path = sys.argv[1]
    text = ""
    parser_name = "unknown"

    try:
        text, parser_name = parse_with_docling(file_path)
    except ImportError:
        # Docling not installed, use fallback
        text, parser_name = parse_with_pdfplumber(file_path)
    except Exception as docling_err:
        # Docling failed, try fallback
        import sys as _sys
        print(f"Docling failed ({docling_err}), falling back to pdfplumber", file=_sys.stderr)
        text, parser_name = parse_with_pdfplumber(file_path)

    print(json.dumps({"text": text, "parser": parser_name}), flush=True)
    sys.exit(0)

except Exception as e:
    print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}), flush=True)
    sys.exit(1)
`.trim();
}

export function runPythonScript(script, filePath) {
  // Try venv Python first (where Docling is installed), then system Python
  const venvPython = new URL("../../.venv/bin/python3", import.meta.url).pathname;
  const systemPython = process.platform === "win32" ? "python" : "python3";
  
  const pythonCandidates = [venvPython, systemPython];
  let lastError = null;
  
  for (const pythonPath of pythonCandidates) {
    try {
      const result = execFileSync(pythonPath, ["-c", script, filePath], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300_000,  // 5 min for Docling (slower but higher quality)
        windowsHide: true
      });

      const parsed = JSON.parse(result.trim());
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed.text || "";
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        lastError = error;
        continue; // Try next Python path
      }
      throw error;
    }
  }
  
  throw lastError || new Error("Python is not installed or not in PATH.");
}

export async function extractPdfTextWithPython(filePath) {
  return runPythonScript(buildPdfExtractorScript(), filePath);
}
