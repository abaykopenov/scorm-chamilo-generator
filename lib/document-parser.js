import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mammoth from "mammoth";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".xml"]);
const DOC_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".rtf"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript"
]);

const DOC_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf"
]);

const PDF_MIME_TYPES = new Set([
  "application/pdf"
]);

const MAX_EXTRACTED_TEXT_CHARS = 350_000;
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ODT_MIME_TYPE = "application/vnd.oasis.opendocument.text";
const RTF_MIME_TYPES = new Set(["application/rtf", "text/rtf"]);
const IS_DARWIN = process.platform === "darwin";

function decodeText(buffer) {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function stripHtmlTags(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(text) {
  return `${text || ""}`
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function countPattern(text, pattern) {
  const matches = `${text || ""}`.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function looksLikeUtf8Mojibake(text) {
  const source = `${text || ""}`;
  if (!source) {
    return false;
  }

  const mojibakeTokens = countPattern(source, /\u00D0.|\u00D1.|\u00C2./g);
  const cyrillicLetters = countPattern(source, /\p{Script=Cyrillic}/gu);
  return mojibakeTokens >= 8 && cyrillicLetters < mojibakeTokens;
}

function scoreTextQuality(text) {
  const source = `${text || ""}`;
  return {
    cyrillicLetters: countPattern(source, /\p{Script=Cyrillic}/gu),
    mojibakeTokens: countPattern(source, /\u00D0.|\u00D1.|\u00C2./g)
  };
}

function tryFixUtf8Mojibake(text) {
  const source = `${text || ""}`;
  if (!looksLikeUtf8Mojibake(source)) {
    return source;
  }

  try {
    const repaired = Buffer.from(source, "latin1").toString("utf8");
    const sourceScore = scoreTextQuality(source);
    const repairedScore = scoreTextQuality(repaired);
    const improved =
      repairedScore.cyrillicLetters > sourceScore.cyrillicLetters &&
      repairedScore.mojibakeTokens < sourceScore.mojibakeTokens;

    return improved ? repaired : source;
  } catch {
    return source;
  }
}

function truncateText(text, maxChars, label) {
  const source = `${text || ""}`;
  if (source.length <= maxChars) {
    return source;
  }

  return `${source.slice(0, maxChars)}\n\n[${label} text truncated to ${maxChars} chars]`;
}

function getExtension(fileName) {
  return path.extname(`${fileName || ""}`).toLowerCase();
}

function isTextMime(mimeType) {
  const mime = `${mimeType || ""}`.toLowerCase();
  if (mime.startsWith("text/")) {
    return true;
  }

  return TEXT_MIME_TYPES.has(mime);
}

function isDocMime(mimeType) {
  return DOC_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

function isPdfMime(mimeType) {
  return PDF_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

function isDocxMaterial(extension, mimeType) {
  return extension === ".docx" || `${mimeType || ""}`.toLowerCase() === DOCX_MIME_TYPE;
}

function isOdtMaterial(extension, mimeType) {
  return extension === ".odt" || `${mimeType || ""}`.toLowerCase() === ODT_MIME_TYPE;
}

function isRtfMaterial(extension, mimeType) {
  return extension === ".rtf" || RTF_MIME_TYPES.has(`${mimeType || ""}`.toLowerCase());
}

function withTempFile(buffer, extension, callback) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "rag-material-"));
  const ext = /^[.a-z0-9_-]+$/i.test(`${extension || ""}`) ? extension : ".bin";
  const filePath = path.join(tmpRoot, `input${ext}`);
  writeFileSync(filePath, buffer);

  try {
    return callback(filePath);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function commandUnavailable(error, commandPattern) {
  const details = error instanceof Error ? error.message : `${error || ""}`;
  return new RegExp(`ENOENT|not recognized as an internal or external command|spawnSync\\s+${commandPattern}`, "i").test(details);
}

function isTextutilUnavailable(error) {
  return commandUnavailable(error, "(?:/usr/bin/)?textutil");
}

function runTextutilToText(filePath) {
  if (!IS_DARWIN) {
    throw new Error("textutil is available only on macOS.");
  }

  try {
    return execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true
    });
  } catch (error) {
    if (isTextutilUnavailable(error)) {
      throw new Error(
        "Failed to parse office document via textutil. " +
        "textutil is unavailable in this environment."
      );
    }

    const details = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Failed to parse office document via textutil.${details}`);
  }
}

function isSofficeUnavailable(error) {
  return commandUnavailable(error, "(?:soffice|libreoffice)(?:\\.exe)?");
}

function readConvertedTextFile(tmpDir, sourceFilePath) {
  const expected = path.join(tmpDir, `${path.parse(sourceFilePath).name}.txt`);
  if (existsSync(expected)) {
    return readFileSync(expected, "utf8");
  }

  const txtCandidate = readdirSync(tmpDir)
    .filter((name) => name.toLowerCase().endsWith(".txt"))
    .map((name) => path.join(tmpDir, name))[0];

  if (txtCandidate && existsSync(txtCandidate)) {
    return readFileSync(txtCandidate, "utf8");
  }

  return "";
}

function runSofficeToText(filePath) {
  const outDir = path.dirname(filePath);
  const candidates = ["soffice", "soffice.exe", "libreoffice", "libreoffice.exe"];
  const errors = [];

  for (const command of candidates) {
    try {
      execFileSync(command, ["--headless", "--convert-to", "txt:Text", "--outdir", outDir, filePath], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true
      });

      const text = readConvertedTextFile(outDir, filePath);
      if (normalizeWhitespace(text)) {
        return text;
      }
      errors.push(`${command}: conversion output is empty`);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error || "Unknown soffice error");
      if (isSofficeUnavailable(error)) {
        errors.push(`${command}: not available`);
      } else {
        errors.push(`${command}: ${details}`);
      }
    }
  }

  throw new Error(`Failed to parse office document via LibreOffice. ${errors.join(" | ")}`);
}

async function extractDocxTextWithMammoth(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const raw = `${result?.value || ""}`;
    const normalized = normalizeWhitespace(raw);
    if (normalized) {
      return normalized;
    }
    throw new Error("DOCX has no extractable text.");
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error || "Unknown mammoth parse error");
    throw new Error(`Failed to parse DOCX via mammoth. ${details}`);
  }
}

function runPythonScript(script, filePath) {
  const interpreterCandidates = [
    { command: "python3", args: ["-X", "utf8"] },
    { command: "python", args: ["-X", "utf8"] },
    { command: "py", args: ["-3", "-X", "utf8"] },
    { command: "python3", args: [] },
    { command: "python", args: [] },
    { command: "py", args: ["-3"] }
  ];
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8"
  };

  const errors = [];

  for (const candidate of interpreterCandidates) {
    try {
      return execFileSync(candidate.command, [...candidate.args, "-", filePath, String(MAX_EXTRACTED_TEXT_CHARS)], {
        input: script,
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 35_000,
        windowsHide: true
      });
    } catch (error) {
      const label = `${candidate.command}${candidate.args.length ? " " + candidate.args.join(" ") : ""}`;
      const details = error instanceof Error ? error.message : String(error || "unknown python error");
      errors.push(`${label}: ${details}`);
    }
  }

  throw new Error(`No working Python interpreter found. ${errors.join(" | ")}`);
}

function buildPypdfScript() {
  return [
    "import sys",
    "path = sys.argv[1]",
    "max_chars = int(sys.argv[2])",
    "PdfReader = None",
    "try:",
    "    from pypdf import PdfReader  # type: ignore",
    "except Exception:",
    "    try:",
    "        from PyPDF2 import PdfReader  # type: ignore",
    "    except Exception as import_error:",
    "        raise RuntimeError('pypdf/PyPDF2 is not installed') from import_error",
    "reader = PdfReader(path)",
    "if getattr(reader, 'is_encrypted', False):",
    "    try:",
    "        reader.decrypt('')",
    "    except Exception:",
    "        pass",
    "parts = []",
    "total = 0",
    "for page in reader.pages:",
    "    if total >= max_chars:",
    "        break",
    "    text = page.extract_text() or ''",
    "    if not text:",
    "        continue",
    "    remain = max_chars - total",
    "    if remain <= 0:",
    "        break",
    "    piece = text[:remain]",
    "    parts.append(piece)",
    "    total += len(piece)",
    "output = '\\n\\n'.join(parts)",
    "if hasattr(sys.stdout, 'buffer'):",
    "    sys.stdout.buffer.write(output.encode('utf-8', errors='replace'))",
    "else:",
    "    sys.stdout.write(output)"
  ].join("\n");
}

function buildDocxXmlScript() {
  return [
    "import sys",
    "import zipfile",
    "import xml.etree.ElementTree as ET",
    "path = sys.argv[1]",
    "max_chars = int(sys.argv[2])",
    "with zipfile.ZipFile(path) as zf:",
    "    data = zf.read('word/document.xml')",
    "root = ET.fromstring(data)",
    "ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}",
    "paragraphs = []",
    "total = 0",
    "for para in root.findall('.//w:p', ns):",
    "    if total >= max_chars:",
    "        break",
    "    parts = [node.text for node in para.findall('.//w:t', ns) if node.text]",
    "    if not parts:",
    "        continue",
    "    line = ''.join(parts).strip()",
    "    if not line:",
    "        continue",
    "    remain = max_chars - total",
    "    if len(line) > remain:",
    "        line = line[:remain]",
    "    paragraphs.append(line)",
    "    total += len(line)",
    "output = '\\n\\n'.join(paragraphs)",
    "if hasattr(sys.stdout, 'buffer'):",
    "    sys.stdout.buffer.write(output.encode('utf-8', errors='replace'))",
    "else:",
    "    sys.stdout.write(output)"
  ].join("\n");
}

function buildOdtXmlScript() {
  return [
    "import sys",
    "import zipfile",
    "import xml.etree.ElementTree as ET",
    "path = sys.argv[1]",
    "max_chars = int(sys.argv[2])",
    "with zipfile.ZipFile(path) as zf:",
    "    data = zf.read('content.xml')",
    "root = ET.fromstring(data)",
    "ns = {'text': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'}",
    "nodes = root.findall('.//text:h', ns) + root.findall('.//text:p', ns)",
    "paragraphs = []",
    "total = 0",
    "for node in nodes:",
    "    if total >= max_chars:",
    "        break",
    "    line = ''.join(node.itertext()).strip()",
    "    if not line:",
    "        continue",
    "    remain = max_chars - total",
    "    if len(line) > remain:",
    "        line = line[:remain]",
    "    paragraphs.append(line)",
    "    total += len(line)",
    "output = '\\n\\n'.join(paragraphs)",
    "if hasattr(sys.stdout, 'buffer'):",
    "    sys.stdout.buffer.write(output.encode('utf-8', errors='replace'))",
    "else:",
    "    sys.stdout.write(output)"
  ].join("\n");
}

function buildQuartzPdfKitScript() {
  return [
    "import sys",
    "from Foundation import NSURL",
    "from Quartz import PDFDocument",
    "path = sys.argv[1]",
    "max_chars = int(sys.argv[2])",
    "url = NSURL.fileURLWithPath_(path)",
    "doc = PDFDocument.alloc().initWithURL_(url)",
    "if doc is None:",
    "    raise RuntimeError('PDFDocument init failed')",
    "parts = []",
    "total = 0",
    "for i in range(doc.pageCount()):",
    "    if total >= max_chars:",
    "        break",
    "    page = doc.pageAtIndex_(i)",
    "    if page is None:",
    "        continue",
    "    text = page.string()",
    "    if text:",
    "        piece = str(text)",
    "        remain = max_chars - total",
    "        if remain <= 0:",
    "            break",
    "        if len(piece) > remain:",
    "            piece = piece[:remain]",
    "        parts.append(piece)",
    "        total += len(piece)",
    "output = '\\n\\n'.join(parts)",
    "if hasattr(sys.stdout, 'buffer'):",
    "    sys.stdout.buffer.write(output.encode('utf-8', errors='replace'))",
    "else:",
    "    sys.stdout.write(output)"
  ].join("\n");
}

function extractPdfTextWithPython(filePath) {
  const attempts = [{ name: "pypdf", script: buildPypdfScript() }];
  if (IS_DARWIN) {
    attempts.push({ name: "quartz-pdfkit", script: buildQuartzPdfKitScript() });
  }

  const errors = [];

  for (const attempt of attempts) {
    try {
      return runPythonScript(attempt.script, filePath);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error || "Unknown PDF parser error");
      errors.push(`[${attempt.name}] ${details}`);
    }
  }

  throw new Error(
    "Failed to parse PDF. Install Python 3 with pypdf (pip install pypdf). " +
    `Details: ${errors.join(" | ")}`
  );
}

function decodeRtfText(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : `${buffer || ""}`;

  let text = source
    .replace(/\\\r\\n/g, "\n")
    .replace(/\\par[d]?/gi, "\n")
    .replace(/\\line/gi, "\n")
    .replace(/\\tab/gi, "\t")
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, codeText) => {
      let code = Number(codeText);
      if (!Number.isFinite(code)) {
        return " ";
      }
      if (code < 0) {
        code += 65536;
      }
      if (code < 0 || code > 0x10ffff) {
        return " ";
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return " ";
      }
    })
    .replace(/\{\\\*[^{}]*\}/g, " ")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, " ")
    .replace(/[{}]/g, " ");

  return normalizeWhitespace(text);
}

async function extractOfficeDocumentText({ fileName, mimeType, extension, buffer }) {
  const errors = [];
  async function attempt(label, runner) {
    try {
      const value = await runner();
      const normalized = normalizeWhitespace(value);
      if (normalized) {
        return normalized;
      }
      errors.push(`${label}: empty output`);
      return "";
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error || "Unknown extractor error");
      errors.push(`${label}: ${details}`);
      return "";
    }
  }

  if (isDocxMaterial(extension, mimeType)) {
    const mammothText = await attempt("mammoth", () => extractDocxTextWithMammoth(buffer));
    if (mammothText) {
      return mammothText;
    }

    const pyDocxText = await attempt("python-docx-xml", () =>
      withTempFile(buffer, extension || ".docx", (filePath) => runPythonScript(buildDocxXmlScript(), filePath))
    );
    if (pyDocxText) {
      return pyDocxText;
    }
  }

  if (isOdtMaterial(extension, mimeType)) {
    const pyOdtText = await attempt("python-odt-xml", () =>
      withTempFile(buffer, extension || ".odt", (filePath) => runPythonScript(buildOdtXmlScript(), filePath))
    );
    if (pyOdtText) {
      return pyOdtText;
    }
  }

  if (isRtfMaterial(extension, mimeType)) {
    const rtfText = decodeRtfText(buffer);
    if (rtfText) {
      return rtfText;
    }
    errors.push("rtf-parser: empty output");
  }

  if (IS_DARWIN) {
    const textutilText = await attempt("textutil", () =>
      withTempFile(buffer, extension || ".doc", runTextutilToText)
    );
    if (textutilText) {
      return textutilText;
    }
  }

  const sofficeText = await attempt("soffice", () =>
    withTempFile(buffer, extension || ".doc", runSofficeToText)
  );
  if (sofficeText) {
    return sofficeText;
  }

  throw new Error(
    "Failed to parse office document. " +
    "Use .docx/.rtf or install LibreOffice (soffice in PATH). " +
    `Details: ${errors.join(" | ")}`
  );
}

export function isSupportedTextMaterial({ fileName, mimeType }) {
  const extension = getExtension(fileName);
  return (
    TEXT_EXTENSIONS.has(extension) ||
    DOC_EXTENSIONS.has(extension) ||
    PDF_EXTENSIONS.has(extension) ||
    isTextMime(mimeType) ||
    isDocMime(mimeType) ||
    isPdfMime(mimeType)
  );
}

export async function parseDocumentText({ fileName, mimeType, buffer }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Material file buffer is missing.");
  }

  if (!isSupportedTextMaterial({ fileName, mimeType })) {
    throw new Error(
      `Unsupported format for indexing: ${fileName || "unknown file"}. ` +
      "MVP parser supports txt, md, csv, json, html, xml, docx, doc, odt, rtf and pdf."
    );
  }

  const extension = getExtension(fileName);
  const rawText = await (async () => {
    if (TEXT_EXTENSIONS.has(extension) || isTextMime(mimeType)) {
      return decodeText(buffer);
    }

    if (DOC_EXTENSIONS.has(extension) || isDocMime(mimeType)) {
      return extractOfficeDocumentText({
        fileName,
        mimeType,
        extension,
        buffer
      });
    }

    if (PDF_EXTENSIONS.has(extension) || isPdfMime(mimeType)) {
      return withTempFile(buffer, extension || ".pdf", extractPdfTextWithPython);
    }

    return decodeText(buffer);
  })();

  const raw = truncateText(rawText, MAX_EXTRACTED_TEXT_CHARS, fileName || "material");
  const repaired = tryFixUtf8Mojibake(raw);
  const maybeHtml = extension === ".html" || extension === ".htm" || /<html[\s>]/i.test(raw);
  const normalized = normalizeWhitespace(maybeHtml ? stripHtmlTags(repaired) : repaired);

  if (!normalized) {
    throw new Error(`Material ${fileName || "file"} has no extractable text content.`);
  }

  return normalized;
}
