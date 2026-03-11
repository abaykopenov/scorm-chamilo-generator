import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { createId } from "../ids.js";


function buildPyPdfImageExtractorScript() {
  return [
    "import sys",
    "import os",
    "path = sys.argv[1]",
    "outdir = sys.argv[2]",
    "try:",
    "    from pypdf import PdfReader",
    "except ImportError:",
    "    try:",
    "        from PyPDF2 import PdfReader",
    "    except ImportError:",
    "        sys.exit(0)",
    "reader = PdfReader(path)",
    "if getattr(reader, 'is_encrypted', False):",
    "    try:",
    "        reader.decrypt('')",
    "    except Exception:",
    "        pass",
    "for i, page in enumerate(reader.pages):",
    "    for count, image_file_object in enumerate(getattr(page, 'images', [])):",
    "        try:",
    "            ext = image_file_object.name.split('.')[-1] if '.' in image_file_object.name else 'png'",
    "            out_path = os.path.join(outdir, f'page_{i+1}_img_{count}.{ext}')",
    "            with open(out_path, 'wb') as fp:",
    "                fp.write(image_file_object.data)",
    "        except Exception as e:",
    "            pass"
  ].join("\n");
}

function runPythonScript(script, filePath, outDir) {
  const interpreterCandidates = [
    { command: "python3", args: ["-X", "utf8"] },
    { command: "python", args: ["-X", "utf8"] },
    { command: "py", args: ["-3", "-X", "utf8"] },
    { command: "python3", args: [] },
    { command: "python", args: [] }
  ];
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8"
  };

  const errors = [];

  for (const candidate of interpreterCandidates) {
    try {
      execFileSync(candidate.command, [...candidate.args, "-", filePath, outDir], {
        input: script,
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 35_000,
        windowsHide: true,
        stdio: 'pipe'
      });
      return; 
    } catch (error) {
      const label = candidate.command;
      const details = error instanceof Error ? error.message : String(error || "unknown python error");
      errors.push(`${label}: ${details}`);
    }
  }

  throw new Error(`Failed to extract images via Python. No working interpreter found. ${errors.join(" | ")}`);
}

/**
 * Extracts images from a PDF buffer by dumping them to a temporary folder via pypdf.
 * Yields { buffer, fileName } objects.
 */
export async function extractImagesFromPdf(buffer) {
  const tmpRoot = path.join(tmpdir(), `rag-images-${createId("tmp")}`);
  const inputPdfPath = path.join(tmpRoot, "input.pdf");
  const extractedImages = [];

  try {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(inputPdfPath, buffer);

    runPythonScript(buildPyPdfImageExtractorScript(), inputPdfPath, tmpRoot);

    const dirContent = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
    for (const fileName of dirContent) {
      if (fileName === "input.pdf") continue;
      const lowerFile = fileName.toLowerCase();
      if (lowerFile.endsWith(".png") || lowerFile.endsWith(".jpg") || lowerFile.endsWith(".jpeg")) {
        const filePath = path.join(tmpRoot, fileName);
        const imageBuffer = readFileSync(filePath);
        extractedImages.push({
          fileName,
          buffer: imageBuffer,
          base64: imageBuffer.toString("base64"),
          mimeType: lowerFile.endsWith(".png") ? "image/png" : "image/jpeg"
        });
      }
    }
  } catch (error) {
    console.error("Image extraction error:", error);
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {
      // Ignored
    }
  }

  return extractedImages;
}
