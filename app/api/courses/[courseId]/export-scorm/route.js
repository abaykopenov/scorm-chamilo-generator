import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { exportCourseToScorm } from "@/lib/scorm/exporter";
import { guardResourceId, checkApiAuth, checkRateLimit } from "@/lib/security";

export async function POST(_request, { params }) {
  const authError = checkApiAuth(_request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(_request);
  if (rateLimitError) return rateLimitError;

  const { courseId: rawId } = await params;
  const courseId = guardResourceId(rawId, "Course");
  if (courseId instanceof NextResponse) return courseId;

  const course = await getCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const exportResult = await exportCourseToScorm(course);
  return NextResponse.json(exportResult);
}
