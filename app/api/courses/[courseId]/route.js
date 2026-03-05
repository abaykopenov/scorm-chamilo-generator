import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { normalizeCoursePayload } from "@/lib/validation";

export async function GET(_request, { params }) {
  const { courseId } = await params;
  const course = await getCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  return NextResponse.json(course);
}

export async function PUT(request, { params }) {
  const { courseId } = await params;
  const existing = await getCourse(courseId);
  if (!existing) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const payload = await request.json();
  const normalized = normalizeCoursePayload({
    ...existing,
    ...payload,
    id: courseId
  });

  const savedCourse = await saveCourse(normalized);
  return NextResponse.json(savedCourse);
}
