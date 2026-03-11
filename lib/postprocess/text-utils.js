export function isRuText(value) {
  return /[\u0400-\u04FF]/.test(`${value || ""}`);
}

export function looksLikeMojibake(value) {
  const source = `${value || ""}`;
  if (!source) {
    return false;
  }
  return /(?:\u00D0.|\u00D1.|\u00C3.|\u00C2.)/.test(source)
    || /\u00EF\u00BF\u00BD/.test(source)
    || /\uFFFD/.test(source);
}

export function textQualityScore(value) {
  const source = `${value || ""}`;
  const cyr = (source.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  const broken = (source.match(/\uFFFD/g) || []).length
    + (source.match(/\u00EF\u00BF\u00BD/g) || []).length
    + (source.match(/\u001A/g) || []).length;
  return (cyr * 2) + latin - (broken * 5);
}

export function tryFixMojibake(value) {
  let current = `${value || ""}`;
  if (!current || !looksLikeMojibake(current)) {
    return current;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recoded = Buffer.from(current, "latin1").toString("utf8");
    if (!recoded || recoded === current) {
      break;
    }
    if (textQualityScore(recoded) >= textQualityScore(current)) {
      current = recoded;
      continue;
    }
    break;
  }

  return current;
}

export function normalizeText(value) {
  return tryFixMojibake(`${value || ""}`)
    .replace(/\r/g, "\n")
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    .replace(/-\s*\n\s*/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^\s*(?:\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u0435|Note)\s*:[^\n]*(?:\n|$)/gimu, "")
    .trim();
}

export function truncateAtBoundary(text, maxLength) {
  const value = normalizeText(text);
  if (!value || value.length <= maxLength) {
    return value;
  }

  const sentenceBounds = [". ", "! ", "? ", ".", "!", "?"];
  for (const marker of sentenceBounds) {
    const index = value.lastIndexOf(marker, maxLength);
    if (index >= Math.floor(maxLength * 0.6)) {
      const end = marker.length > 1 ? index + marker.length - 1 : index + 1;
      return value.slice(0, end).trim();
    }
  }

  const chunk = value.slice(0, maxLength + 1);
  const wordBoundary = chunk.lastIndexOf(" ");
  if (wordBoundary >= Math.floor(maxLength * 0.55)) {
    return chunk.slice(0, wordBoundary).trim();
  }

  return value.slice(0, maxLength).trim();
}

export function removeDanglingTail(text) {
  let value = normalizeText(text)
    .replace(/[,:;\-…]+\s*$/u, "")
    .trim();

  if (!/[.!?]$/.test(value)) {
    const orphan = value.match(/^(.*)\s+(\p{L}{1,2})$/u);
    if (orphan?.[1] && orphan[1].length >= 40) {
      value = orphan[1].trim();
    }
  }

  return value;
}

export function cleanNarrativeText(text, maxLength) {
  return removeDanglingTail(truncateAtBoundary(text, maxLength));
}

export function sentencePool(text) {
  const normalized = normalizeText(text).replace(/\n+/g, " ");
  if (!normalized) {
    return [];
  }

  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => cleanNarrativeText(part, 180))
    .filter((part) => part.length >= 20);

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(part);
  }

  return unique;
}

