import { NextResponse } from "next/server";
import { getExportZip } from "@/lib/course-store";

function toSafeAsciiFileName(fileName, fallback) {
  const normalized = String(fileName || fallback)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  return normalized || fallback;
}

function encodeFileNameUtf8(fileName) {
  return encodeURIComponent(String(fileName || "export.zip"))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function GET(_request, { params }) {
  const { exportId } = await params;
  const exportResult = await getExportZip(exportId);
  if (!exportResult) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }

  const originalName = exportResult.meta?.downloadName || `${exportId}.zip`;
  const asciiName = toSafeAsciiFileName(originalName, `${exportId}.zip`);
  const encodedName = encodeFileNameUtf8(originalName);
  const buffer = exportResult.buffer instanceof Uint8Array
    ? exportResult.buffer
    : new Uint8Array(exportResult.buffer || []);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
    }
  });
}
