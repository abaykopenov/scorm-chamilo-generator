import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function stripQuotes(value) {
  const raw = `${value || ""}`.trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    const inner = raw.slice(1, -1);
    if (raw.startsWith('"')) {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
    }
    return inner;
  }
  return raw;
}

function parseEnvContent(content) {
  const result = [];
  const lines = `${content || ""}`.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;

    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = normalized.slice(separatorIndex + 1);
    result.push([key, stripQuotes(rawValue)]);
  }
  return result;
}

export function loadLocalEnvFiles(options = {}) {
  const cwd = options.cwd || process.cwd();
  const files = Array.isArray(options.files) && options.files.length > 0
    ? options.files
    : [".env", ".env.local"];

  const protectedKeys = new Set(Object.keys(process.env));

  for (const fileName of files) {
    const absolutePath = path.join(cwd, fileName);
    if (!existsSync(absolutePath)) {
      continue;
    }

    let content = "";
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }

    for (const [key, value] of parseEnvContent(content)) {
      if (protectedKeys.has(key)) {
        continue;
      }
      process.env[key] = value;
    }
  }
}
