import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { rebuildCourseStructure } from "@/lib/structure-engine";
import { guardResourceId, checkApiAuth, checkRateLimit } from "@/lib/security";

export async function POST(request, { params }) {
  const authError = checkApiAuth(request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

  const { courseId: rawId } = await params;
  const courseId = guardResourceId(rawId, "Course");
  if (courseId instanceof NextResponse) return courseId;

  const existing = await getCourse(courseId);
  if (!existing) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const payload = await request.json();
  const rebuilt = rebuildCourseStructure(existing, payload?.structure);
  const savedCourse = await saveCourse(rebuilt);
  return NextResponse.json(savedCourse);
}
