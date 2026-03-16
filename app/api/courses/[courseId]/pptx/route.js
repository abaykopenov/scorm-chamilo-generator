import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { exportCourseToPptx } from "@/lib/export/pptx-exporter";
import { guardResourceId } from "@/lib/security";

function toSafeAsciiFileName(name, fallback) {
  return String(name || fallback)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || fallback;
}

function encodeFileNameUtf8(name) {
  return encodeURIComponent(String(name || "course.pptx"))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function GET(_request, { params }) {
  const { courseId: rawId } = await params;
  const courseId = guardResourceId(rawId, "Course");
  if (courseId instanceof NextResponse) return courseId;

  try {
    const course = await getCourse(courseId);
    if (!course) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const buffer = await exportCourseToPptx(course);
    const title = `${course.title || "course"}`.replace(/[^\p{L}\p{N}_-]+/gu, "_");
    const fileName = `${title}.pptx`;
    const asciiName = toSafeAsciiFileName(fileName, `${courseId}.pptx`);
    const encodedName = encodeFileNameUtf8(fileName);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
      }
    });
  } catch (err) {
    console.error(`[pptx-route] Export failed: ${err?.message || err}`);
    return NextResponse.json(
      { ok: false, error: err?.message || "PPTX export failed" },
      { status: 500 }
    );
  }
}
