import { NextResponse } from "next/server";
import { connectToChamilo, normalizeChamiloProfile } from "@/lib/chamilo-client";
import { getCourse, saveCourse } from "@/lib/course-store";
import { normalizeCoursePayload } from "@/lib/validation";

export async function POST(request, { params }) {
  const { courseId } = await params;
  const course = await getCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const payload = await request.json().catch(() => ({}));
  const profile = normalizeChamiloProfile({
    ...course.integrations?.chamilo,
    ...payload?.profile
  });

  try {
    const connection = await connectToChamilo({ profile });
    const updatedCourse = normalizeCoursePayload({
      ...course,
      integrations: {
        ...(course.integrations || {}),
        chamilo: {
          ...course.integrations?.chamilo,
          name: profile.name,
          baseUrl: profile.baseUrl,
          username: profile.username,
          courseCode: profile.courseCode,
          uploadPagePath: profile.uploadPagePath,
          loginPath: profile.loginPath,
          lastConnectionStatus: "connected",
          lastConnectionMessage: `Upload page found: ${connection.uploadUrl}`,
          lastConnectedAt: new Date().toISOString()
        }
      }
    });

    await saveCourse(updatedCourse);

    return NextResponse.json({
      ok: true,
      profile: updatedCourse.integrations.chamilo,
      courses: connection.courses,
      uploadUrl: connection.uploadUrl,
      uploadPageTitle: connection.uploadPageTitle
    });
  } catch (error) {
    const updatedCourse = normalizeCoursePayload({
      ...course,
      integrations: {
        ...(course.integrations || {}),
        chamilo: {
          ...course.integrations?.chamilo,
          name: profile.name,
          baseUrl: profile.baseUrl,
          username: profile.username,
          courseCode: profile.courseCode,
          uploadPagePath: profile.uploadPagePath,
          loginPath: profile.loginPath,
          lastConnectionStatus: "failed",
          lastConnectionMessage: error instanceof Error ? error.message : "Chamilo connection failed",
          lastConnectedAt: course.integrations?.chamilo?.lastConnectedAt || ""
        }
      }
    });

    await saveCourse(updatedCourse);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Chamilo connection failed",
        profile: updatedCourse.integrations.chamilo
      },
      { status: 500 }
    );
  }
}
