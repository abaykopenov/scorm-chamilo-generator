import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { guardResourceId, checkApiAuth, checkRateLimit } from "@/lib/security";
import { exportCourseToXapiArchive } from "@/lib/xapi/exporter";

export async function POST(request, { params }) {
  const authError = checkApiAuth(request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

  const { courseId: rawId } = await params;
  const courseId = guardResourceId(rawId, "Course");
  if (courseId instanceof NextResponse) return courseId;

  const course = await getCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  try {
    const archive = await exportCourseToXapiArchive(course);

    return NextResponse.json({
      ...archive,
      ok: true,
      message: "xAPI package generated"
    });
  } catch (error) {
    console.error("xAPI export failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "xAPI assembly failed" },
      { status: 500 }
    );
  }
}
