import { NextResponse } from "next/server";
import { getExportZip } from "@/lib/course-store";

export async function GET(_request, { params }) {
  const { exportId } = await params;
  const exportResult = await getExportZip(exportId);
  if (!exportResult) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }

  return new NextResponse(exportResult.buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exportResult.meta.downloadName}"`
    }
  });
}
