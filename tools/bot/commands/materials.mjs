import { sendMessage } from "../api.mjs";
import { escapeMarkdown, formatFileSize, MAX_UPLOAD_SIZE_BYTES, MAX_UPLOAD_SIZE_MB, MAX_UPLOADS_PER_HOUR } from "../config.mjs";
import { getChatSession, upsertSessionFile, attachMaterialToSession, clearSessionMaterials, saveState, checkRateLimit } from "../state.mjs";
import { downloadTelegramFile } from "../api.mjs";
import { afterUploadKeyboard } from "../ui/keyboards.mjs";
import { t } from "../i18n/index.mjs";
import { isSupportedTextMaterial } from "../../../lib/document-parser.js";
import { indexMaterialDocument } from "../../../lib/material-indexer.js";
import { saveUploadedMaterial } from "../../../lib/material-store.js";
import { createDefaultGenerateInput } from "../../../lib/course-defaults.js";
import { resolveEmbeddingConfig } from "../generation/executor.mjs";


export async function handleDocumentUpload(chatId, message) {
  const document = message?.document;
  if (!document) return false;

  const fileId = `${document.file_id || ""}`.trim();
  const fileName = `${document.file_name || "material"}`.trim() || "material";
  const mimeType = `${document.mime_type || ""}`.trim();
  const fileSize = Math.max(0, Number(document.file_size) || 0);

  if (!fileId) { await sendMessage(chatId, "Telegram не передал file_id."); return true; }

  if (!isSupportedTextMaterial({ fileName, mimeType })) {
    await sendMessage(chatId, t("uploadUnsupported"));
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
    const material = await saveUploadedMaterial({ fileName, mimeType, buffer });

    await sendMessage(chatId, t("uploadSaved", escapeMarkdown(material.id)));

    const defaults = createDefaultGenerateInput();
    const embedding = resolveEmbeddingConfig(defaults);
    const result = await indexMaterialDocument(material.id, { embedding });

    if (!result?.ok) {
      upsertSessionFile(chatId, {
        materialId: material.id, telegramFileId: fileId, fileName: material.fileName,
        mimeType: material.mimeType, size: material.size, status: "failed",
        message: `${result?.message || "Indexing failed."}`
      });
      await saveState();
      await sendMessage(chatId, t("uploadFailed", escapeMarkdown(material.fileName), escapeMarkdown(result?.message || "unknown")));
      return true;
    }

    attachMaterialToSession(chatId, material.id);
    upsertSessionFile(chatId, {
      materialId: material.id, telegramFileId: fileId, fileName: material.fileName,
      mimeType: material.mimeType, size: material.size, status: "indexed", message: ""
    });
    await saveState();

    const session = getChatSession(chatId, false);
    const count = session?.materialIds?.length || 0;
    await sendMessage(chatId,
      `${t("uploadIndexed", escapeMarkdown(material.fileName), result.chunksCount ?? 0, count)}\n${t("uploadAfter")}`,
      afterUploadKeyboard(material.fileName)
    );
    return true;
  } catch (error) {
    await sendMessage(chatId, t("uploadFailed", escapeMarkdown(fileName), escapeMarkdown(error.message || "unknown")));
    return true;
  }
}

export async function handleMaterials(chatId) {
  const session = getChatSession(chatId, false);
  if (!session || session.files.length === 0) {
    await sendMessage(chatId, t("materialsEmpty"));
    return;
  }
  const lines = session.files.slice(-15).reverse().map((f, i) => {
    const mark = f.status === "indexed" ? "✅" : f.status === "failed" ? "❌" : "⏳";
    return `${i + 1}. ${mark} ${escapeMarkdown(f.fileName)} (${formatFileSize(f.size)})`;
  });
  await sendMessage(chatId, `📚 Материалов: ${session.materialIds.length}\n\n${lines.join("\n")}`);
}

export async function handleClearMaterials(chatId) {
  const cleared = clearSessionMaterials(chatId);
  if (cleared) {
    await saveState();
    await sendMessage(chatId, t("materialsCleared"));
  } else {
    await sendMessage(chatId, t("materialsNone"));
  }
}
