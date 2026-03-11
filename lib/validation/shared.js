export function clampNumber(value, config) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return config.default;
  }
  return Math.min(config.max, Math.max(config.min, Math.trunc(parsed)));
}

export function toText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

export function toTextArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => `${item}`.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/) 
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return fallback;
}
