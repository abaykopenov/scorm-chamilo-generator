import { NextResponse } from "next/server";
import { saveCourse } from "@/lib/course-store";
import { generateCourseDraft } from "@/lib/course-generator";

export async function POST(request) {
  const payload = await request.json();
  const course = await generateCourseDraft(payload);
  const savedCourse = await saveCourse(course);
  return NextResponse.json(savedCourse, { status: 201 });
}
