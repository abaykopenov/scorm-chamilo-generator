import { execFileSync } from "node:child_process";

export function buildPdfExtractorScript() {
  return `
import sys
import json
import traceback

try:
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            print(json.dumps({"error": "PDF library (pypdf or PyPDF2) is not installed. Run: pip install pypdf"}), flush=True)
            sys.exit(1)

    file_path = sys.argv[1]
    reader = PdfReader(file_path)
    text_parts = []
    
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text_parts.append(page_text)
            
    print(json.dumps({"text": "\\n\\n".join(text_parts)}), flush=True)
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
