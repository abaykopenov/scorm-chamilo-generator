import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { regenerateModuleInCourse } from "@/lib/regeneration";

export async function POST(request, { params }) {
  const { courseId } = await params;
  const existing = await getCourse(courseId);
  if (!existing) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const payload = await request.json().catch(() => ({}));
  const moduleIndex = Number(payload?.moduleIndex);
  if (!Number.isFinite(moduleIndex)) {
    return NextResponse.json({ error: "moduleIndex is required" }, { status: 400 });
  }

  try {
    const regenerated = await regenerateModuleInCourse(existing, moduleIndex);
    regenerated.id = courseId;
    const saved = await saveCourse(regenerated);
    return NextResponse.json(saved, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to regenerate module"
      },
      { status: 400 }
    );
  }
}
