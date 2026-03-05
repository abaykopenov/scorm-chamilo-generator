import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { rebuildCourseStructure } from "@/lib/structure-engine";

export async function POST(request, { params }) {
  const { courseId } = await params;
  const existing = await getCourse(courseId);
  if (!existing) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const payload = await request.json();
  const rebuilt = rebuildCourseStructure(existing, payload?.structure);
  const savedCourse = await saveCourse(rebuilt);
  return NextResponse.json(savedCourse);
}
