import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function decodeText(buffer) {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

export function stripHtmlTags(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function normalizeWhitespace(text) {
  return `${text || ""}`
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function countPattern(text, pattern) {
  const matches = `${text || ""}`.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

export function scoreTextQuality(text) {
  const source = `${text || ""}`;
  return {
    cyrillicLetters: countPattern(source, /\p{Script=Cyrillic}/gu),
    mojibakeTokens: countPattern(source, /\u00D0.|\u00D1.|\u00C2./g)
  };
}

export function looksLikeUtf8Mojibake(text) {
  const source = `${text || ""}`;
  if (!source) {
    return false;
  }
  const score = scoreTextQuality(source);
  return score.mojibakeTokens >= 8 && score.cyrillicLetters < score.mojibakeTokens;
}

export function tryFixUtf8Mojibake(text) {
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

export function truncateText(text, maxChars, label) {
  const source = `${text || ""}`;
  if (source.length <= maxChars) {
    return source;
  }
  return `${source.slice(0, maxChars)}\n\n[${label} text truncated to ${maxChars} chars]`;
}

export function withTempFile(buffer, extension, callback) {
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

export function commandUnavailable(error, commandPattern) {
  const details = error instanceof Error ? error.message : `${error || ""}`;
  return new RegExp(`ENOENT|not recognized as an internal or external command|spawnSync\\s+${commandPattern}`, "i").test(details);
}
