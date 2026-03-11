import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mammoth from "mammoth";
import { runPythonScript } from "./pdf-parser.js"; 
import { commandUnavailable } from "./utils.js";

const IS_DARWIN = process.platform === "darwin";

export function buildDocxXmlScript() {
  return `
import sys
import json
import zipfile
import xml.etree.ElementTree as ET

def extract_docx_text(docx_path):
    try:
        with zipfile.ZipFile(docx_path) as z:
            xml_content = z.read("word/document.xml")
            tree = ET.fromstring(xml_content)
            namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            texts = []
            for p in tree.findall(".//w:p", namespace):
                p_texts = [node.text for node in p.findall(".//w:t", namespace) if node.text]
                if p_texts:
                    texts.append("".join(p_texts))
            return "\\n".join(texts)
    except Exception as e:
        return f"Error: {str(e)}"

if __name__ == "__main__":
    print(json.dumps({"text": extract_docx_text(sys.argv[1])}))
`.trim();
}

export function buildOdtXmlScript() {
  return `
import sys
import json
import zipfile
import xml.etree.ElementTree as ET

def extract_odt_text(odt_path):
    try:
        with zipfile.ZipFile(odt_path) as z:
            xml_content = z.read("content.xml")
            tree = ET.fromstring(xml_content)
            namespace = {"text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0"}
            texts = []
            for p in tree.findall(".//text:p", namespace):
                texts.append("".join(p.itertext()))
            return "\\n".join(texts)
    except Exception as e:
        return f"Error: {str(e)}"

if __name__ == "__main__":
    print(json.dumps({"text": extract_odt_text(sys.argv[1])}))
`.trim();
}

async function extractDocxTextWithMammoth(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error || "Unknown mammoth error");
    throw new Error(`Mammoth extraction failed: ${details}`);
  }
}

function runTextutilToText(filePath) {
  if (!IS_DARWIN) throw new Error("textutil only on macOS");
  return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
    windowsHide: true
  });
}

function runSofficeToText(filePath) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "soffice-out-"));
  try {
    const soffice = process.platform === "win32" ? "soffice.exe" : "soffice";
    execFileSync(soffice, ["--headless", "--convert-to", "txt", "--outdir", tmpDir, filePath], {
      timeout: 30_000,
      windowsHide: true
    });
    
    const expected = path.join(tmpDir, `${path.parse(filePath).name}.txt`);
    if (existsSync(expected)) return readFileSync(expected, "utf8");
    
    const txtCandidate = readdirSync(tmpDir).find(n => n.toLowerCase().endsWith(".txt"));
    if (txtCandidate) return readFileSync(path.join(tmpDir, txtCandidate), "utf8");
    
    throw new Error("No output file from soffice");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function decodeRtfText(buffer) {
  const raw = new TextDecoder("ascii").decode(buffer);
  return raw
    .replace(/\\rtf1[\s\S]*?}/g, (match) => {
      return match
        .replace(/\\[a-z0-9-]+/g, "")
        .replace(/[{}]/g, "")
        .replace(/\n\s*\n/g, "\n");
    })
    .replace(/\\'[a-f0-9]{2}/gi, (match) => {
      try {
        const code = parseInt(match.slice(2), 16);
        return String.fromCharCode(code);
      } catch { return match; }
    })
    .replace(/[\r\n]{2,}/g, "\n")
    .trim();
}

export async function extractOfficeDocumentText({ buffer, extension, mimeType, withTempFile }) {
  const errors = [];
  const attempt = async (label, runner) => {
    try {
      const val = await runner();
      if (val?.trim()) return val;
      errors.push(`${label}: empty`);
      return "";
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      return "";
    }
  };

  if (extension === ".docx") {
    const mammothText = await attempt("mammoth", () => extractDocxTextWithMammoth(buffer));
    if (mammothText) return mammothText;
    
    const pyText = await attempt("py-docx", () => withTempFile(buffer, ".docx", (fp) => runPythonScript(buildDocxXmlScript(), fp)));
    if (pyText) return pyText;
  }

  if (extension === ".odt") {
    const pyText = await attempt("py-odt", () => withTempFile(buffer, ".odt", (fp) => runPythonScript(buildOdtXmlScript(), fp)));
    if (pyText) return pyText;
  }

  if (extension === ".rtf") {
    const rtfText = decodeRtfText(buffer);
    if (rtfText) return rtfText;
  }

  if (IS_DARWIN) {
    const tuText = await attempt("textutil", () => withTempFile(buffer, extension || ".doc", runTextutilToText));
    if (tuText) return tuText;
  }

  const soText = await attempt("soffice", () => withTempFile(buffer, extension || ".doc", runSofficeToText));
  if (soText) return soText;

  throw new Error(`Failed to parse office doc: ${errors.join(" | ")}`);
}
