import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { exportCourseToScorm } from "@/lib/scorm/exporter";

export async function POST(_request, { params }) {
  const { courseId } = await params;
  const course = await getCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const exportResult = await exportCourseToScorm(course);
  return NextResponse.json(exportResult);
}
