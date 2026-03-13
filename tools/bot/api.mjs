import { TELEGRAM_API_URL, BOT_TOKEN } from "./config.mjs";

export async function telegramCall(method, payload, options = {}) {
  const { multipart = false, timeoutSeconds = 40 } = options;
  const url = `${TELEGRAM_API_URL}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: multipart ? undefined : { "Content-Type": "application/json" },
    body: multipart ? payload : JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutSeconds * 1000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const description = `${data?.description || `HTTP ${response.status}`}`.trim();
    throw new Error(`Telegram API ${method} failed: ${description}`);
  }
  return data.result;
}

export async function sendMessage(chatId, text, options = {}) {
  try {
    return await telegramCall("sendMessage", {
      chat_id: chatId,
      text: `${text || ""}`.slice(0, 4096),
      parse_mode: "HTML",
      ...options
    });
  } catch (err) {
    if (err.message?.includes("bot was blocked by the user")) {
      console.warn(`[bot] Attempted to message ${chatId}, but bot was blocked.`);
      return null;
    }
    throw err;
  }
}

export async function editMessageText(chatId, messageId, text, options = {}) {
  try {
    return await telegramCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${text || ""}`.slice(0, 4096),
      parse_mode: "HTML",
      ...options
    });
  } catch (err) {
    if (err.message?.includes("message is not modified")) return null;
    console.warn(`[bot] Failed to edit message ${messageId}: ${err.message}`);
    return null;
  }
}

export async function sendDocument(chatId, zipBuffer, fileName, caption) {
  const form = new FormData();
  form.set("chat_id", `${chatId}`);
  if (caption) form.set("caption", `${caption}`.slice(0, 1024));
  form.set(
    "document",
    new Blob([zipBuffer], { type: "application/zip" }),
    `${fileName || "course-scorm12.zip"}`
  );
  return telegramCall("sendDocument", form, { multipart: true, timeoutSeconds: 120 });
}

export async function downloadTelegramFile(fileId) {
  const metadata = await telegramCall("getFile", { file_id: fileId });
  const filePath = `${metadata?.file_path || ""}`.trim();
  if (!filePath) throw new Error("Telegram did not return file_path for this document.");

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Failed to download file from Telegram (HTTP ${response.status}).`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Downloaded file is empty.");
  return { buffer, filePath };
}

export async function fetchOllamaModelNames(baseUrl) {
  const normalized = `${baseUrl || ""}`.trim().replace(/\/$/, "");
  if (!normalized) throw new Error("Ollama base URL is empty.");
  const response = await fetch(`${normalized}/api/tags`, { method: "GET", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Ollama /api/tags returned HTTP ${response.status}.`);
  const payload = await response.json().catch(() => ({}));
  const names = Array.isArray(payload?.models)
    ? payload.models.map(item => `${item?.name || ""}`.trim()).filter(Boolean)
    : [];
  return Array.from(new Set(names));
}
