import { NextResponse } from "next/server";
import { createBlankCoursePayload } from "@/lib/course-defaults";
import { generateCourseDraft } from "@/lib/course-generator";
import { saveCourse, listCourses } from "@/lib/course-store";

export async function GET() {
  const courses = await listCourses();
  return NextResponse.json(courses);
}

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const base = {
    ...createBlankCoursePayload(),
    titleHint: payload.title ?? payload.titleHint,
    audience: payload.audience,
    learningGoals: payload.learningGoals,
    durationMinutes: payload.durationMinutes,
    language: payload.language,
    structure: payload.structure,
    finalTest: payload.finalTest,
    generation: payload.generation
  };

  const course = await generateCourseDraft(base);
  const savedCourse = await saveCourse(course);
  return NextResponse.json(savedCourse, { status: 201 });
}
