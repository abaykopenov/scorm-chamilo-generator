import { NextResponse } from "next/server";
import { getExportZip } from "@/lib/course-store";

export async function GET(_request, { params }) {
  const { exportId } = await params;
  const exportResult = await getExportZip(exportId);
  if (!exportResult) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }

  const originalName = exportResult.meta.downloadName || "scorm-package.zip";
  const utf8Name = encodeURIComponent(originalName);
  // ASCII-safe fallback so browsers always get .zip extension
  const asciiName = originalName.replace(/[^\x20-\x7E]/g, "_");

  return new NextResponse(exportResult.buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`
    }
  });
}
