import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { regenerateScreenInCourse } from "@/lib/regeneration";
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

  const payload = await request.json().catch(() => ({}));
  const moduleIndex = Number(payload?.moduleIndex);
  const sectionIndex = Number(payload?.sectionIndex);
  const scoIndex = Number(payload?.scoIndex);
  const screenIndex = Number(payload?.screenIndex);

  if (![moduleIndex, sectionIndex, scoIndex, screenIndex].every((value) => Number.isFinite(value))) {
    return NextResponse.json({ error: "moduleIndex, sectionIndex, scoIndex and screenIndex are required" }, { status: 400 });
  }

  try {
    const regenerated = await regenerateScreenInCourse(existing, {
      moduleIndex,
      sectionIndex,
      scoIndex,
      screenIndex
    });
    regenerated.id = courseId;
    const saved = await saveCourse(regenerated);
    return NextResponse.json(saved, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to regenerate screen"
      },
      { status: 400 }
    );
  }
}
