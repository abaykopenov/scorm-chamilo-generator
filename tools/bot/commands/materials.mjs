import { sendMessage, downloadTelegramFile } from "../api.mjs";
import { escapeMarkdown, formatFileSize, MAX_UPLOAD_SIZE_BYTES, MAX_UPLOAD_SIZE_MB, MAX_UPLOADS_PER_HOUR } from "../config.mjs";
import { getChatSession, attachMaterialToSession, clearSessionMaterials, saveState, checkRateLimit, upsertSessionFile } from "../state.mjs";
import { afterUploadKeyboard } from "../ui/keyboards.mjs";
import { t } from "../i18n/index.mjs";
import { uploadDocumentFromBuffer } from "../../../lib/rag-llm-client.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const UPLOADS_DIR = path.join(process.cwd(), ".data", "telegram-bot", "uploads");

export async function handleDocumentUpload(chatId, message) {
  const document = message?.document;
  if (!document) return false;

  const fileId = `${document.file_id || ""}`.trim();
  const fileName = `${document.file_name || "material"}`.trim() || "material";
  const mimeType = `${document.mime_type || ""}`.trim();
  const fileSize = Math.max(0, Number(document.file_size) || 0);

  if (!fileId) { 
    await sendMessage(chatId, "Telegram не передал file_id."); 
    return true; 
  }

  if (fileSize > MAX_UPLOAD_SIZE_BYTES) {
    await sendMessage(chatId, t("uploadTooBig", formatFileSize(fileSize), MAX_UPLOAD_SIZE_MB));
    return true;
  }

  // Telegram Bot API hard limit: 20 MB for file downloads
  const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
  if (fileSize > TELEGRAM_DOWNLOAD_LIMIT) {
    await sendMessage(chatId,
      `⚠️ Файл «<b>${escapeMarkdown(fileName)}</b>» (${formatFileSize(fileSize)}) превышает лимит Telegram Bot API (20 МБ).\n\n` +
      `Telegram не позволяет ботам скачивать файлы больше 20 МБ.\n\n` +
      `💡 <b>Решения:</b>\n` +
      `• Разделите файл на несколько частей до 20 МБ\n` +
      `• Загрузите файл через веб-интерфейс: <code>http://localhost:3000</code>\n` +
      `• Сожмите PDF (например, через ilovepdf.com)`
    );
    return true;
  }

  // Rate limit
  const check = checkRateLimit(chatId, "upload", MAX_UPLOADS_PER_HOUR);
  if (!check.allowed) {
    await sendMessage(chatId, t("uploadRateLimit", check.waitMinutes));
    return true;
  }

  try {
    await sendMessage(chatId, t("uploadReceived", escapeMarkdown(fileName), formatFileSize(fileSize)));
    const { buffer } = await downloadTelegramFile(fileId);
    
    // Save local copy for potential DOCX/PDF conversion
    await mkdir(UPLOADS_DIR, { recursive: true });
    const localFilePath = path.join(UPLOADS_DIR, `${Date.now()}_${fileName}`);
    await writeFile(localFilePath, buffer);
    
    // Upload to RAG-LLM service for indexing
    const result = await uploadDocumentFromBuffer(buffer, fileName, { collection: "default" });

    if (!result.ok) {
      await sendMessage(chatId, t("uploadFailed", escapeMarkdown(fileName), escapeMarkdown(result?.message || "unknown")));
      return true;
    }

    // Store reference in session with local file path
    const materialId = result.documentId;
    attachMaterialToSession(chatId, materialId);
    upsertSessionFile(chatId, {
      materialId: materialId,
      telegramFileId: fileId,
      fileName: fileName,
      mimeType: mimeType,
      size: fileSize,
      filePath: localFilePath,
      status: "indexed"
    });
    
    await saveState();

    const session = getChatSession(chatId, false);
    const count = session?.materialIds?.length || 0;
    await sendMessage(chatId,
      `✅ Файл «<b>${escapeMarkdown(fileName)}</b>» проиндексирован (${result.chunksCount || 0} чанков).\n\n` +
      `📚 Всего материалов: ${count}\n\n` +
      `Теперь вы можете использовать эти материалы при создании курса с помощью команды /create`,
      afterUploadKeyboard(fileName)
    );
    return true;
  } catch (error) {
    await sendMessage(chatId, t("uploadFailed", escapeMarkdown(fileName), escapeMarkdown(error.message || "unknown")));
    return true;
  }
}

export async function handleMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session || !session.materialIds || session.materialIds.length === 0) {
    await sendMessage(chatId, "📚 У вас пока нет загруженных материалов.\n\nОтправьте документ в чат, чтобы добавить его для RAG.");
    return;
  }
  
  const lines = session.materialIds.slice(-15).reverse().map((id, i) => {
    return `${i + 1}. 📄 ${escapeMarkdown(id.slice(0, 30))}...`;
  });
  
  await sendMessage(chatId, `📚 Материалов: ${session.materialIds.length}\n\n${lines.join("\n")}\n\nЭти материалы будут использоваться при создании курса.`);
}

export async function handleClearMaterials(chatId) {
  const cleared = clearSessionMaterials(chatId);
  if (cleared) {
    await saveState();
    await sendMessage(chatId, "🗑 Все материалы удалены из сессии.");
  } else {
    await sendMessage(chatId, "📚 Нет материалов для очистки.");
  }
}
