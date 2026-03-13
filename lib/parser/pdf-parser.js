import { execFileSync } from "node:child_process";

export function buildPdfExtractorScript() {
  return `
import sys
import json
import re
import traceback

def fix_broken_text(text):
    if not text:
        return text
    
    # Fix hyphenated line breaks
    text = re.sub(r'(\\w)-\\s*\\n\\s*(\\w)', r'\\1\\2', text)
    
    # Fix spaces within Cyrillic words (short fragments separated by space)
    lines = text.split('\\n')
    fixed_lines = []
    for line in lines:
        prev = None
        while prev != line:
            prev = line
            # Fix: "word space shortpart" where shortpart is 1-3 Cyrillic lowercase chars
            line = re.sub(r'([\\u0430-\\u044f\\u0451]{2,})\\s+([\\u0430-\\u044f\\u0451]{1,3})(?=\\s|[.,;:!?\\)]|$)', r'\\1\\2', line)
            # Fix: single char (not at word start) space word
            line = re.sub(r'(?<=[\\u0430-\\u044f\\u0451])([\\u0430-\\u044f\\u0451])\\s+([\\u0430-\\u044f\\u0451]{2,})', r'\\1\\2', line)
        fixed_lines.append(line)
    text = '\\n'.join(fixed_lines)
    
    # Clean up multiple spaces
    text = re.sub(r'[ \\t]{2,}', ' ', text)
    
    return text

try:
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            print(json.dumps({"error": "pypdf not installed. Run: pip install pypdf"}), flush=True)
            sys.exit(1)

    file_path = sys.argv[1]
    reader = PdfReader(file_path)
    text_parts = []
    
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text_parts.append(page_text)
            
    raw_text = "\\n\\n".join(text_parts)
    fixed_text = fix_broken_text(raw_text)
    
    print(json.dumps({"text": fixed_text}), flush=True)
    sys.exit(0)

except Exception as e:
    print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}), flush=True)
    sys.exit(1)
`.trim();
}

export function runPythonScript(script, filePath) {
  const pythonPath = process.platform === "win32" ? "python" : "python3";
  try {
    const result = execFileSync(pythonPath, ["-c", script, filePath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true
    });

    const parsed = JSON.parse(result.trim());
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed.text || "";
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      throw new Error("Python is not installed or not in PATH.");
    }
    throw error;
  }
}

export async function extractPdfTextWithPython(filePath) {
  return runPythonScript(buildPdfExtractorScript(), filePath);
}
