import { NextResponse } from "next/server";
import { createBlankCoursePayload } from "@/lib/course-defaults";
import { generateCourseDraft } from "@/lib/course-generator";
import { listCourses, saveCourse } from "@/lib/course-store";
import { checkApiAuth, checkRateLimit } from "@/lib/security";

export async function GET(request) {
  const authError = checkApiAuth(request);
  if (authError) return authError;

  const limit = Number(request.nextUrl.searchParams.get("limit") || 100);
  const courses = await listCourses({ limit });
  return NextResponse.json({ courses }, { status: 200 });
}

export async function POST(request) {
  const authError = checkApiAuth(request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

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
    generation: payload.generation,
    rag: payload.rag
  };

  const course = await generateCourseDraft(base);
  const savedCourse = await saveCourse({
    ...course,
    generationStatus: "completed",
    completedModules: Array.isArray(course?.modules) ? course.modules.length : 0
  });
  return NextResponse.json(savedCourse, { status: 201 });
}
