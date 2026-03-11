import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { normalizeCoursePayload } from "@/lib/validation";
import { getAdapter } from "@/lib/lms/registry";
import { guardResourceId, checkApiAuth, checkRateLimit } from "@/lib/security";

export async function POST(request, { params }) {
  const authError = checkApiAuth(request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

  const { courseId: rawId } = await params;
  const courseId = guardResourceId(rawId, "Course");
  if (courseId instanceof NextResponse) return courseId;

  const course = await getCourse(courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const payload = await request.json().catch(() => ({}));
  const lmsId = payload?.lmsId || course?.integrations?.lmsId || "chamilo";

  let adapter;
  try {
    adapter = getAdapter(lmsId);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 400 }
    );
  }

  const existingIntegration = course.integrations?.[adapter.id] || {};
  const rawProfile = {
    ...existingIntegration,
    ...payload?.profile
  };
  const profile = adapter.normalizeProfile(rawProfile);

  try {
    const connection = await adapter.connect(profile);
    const courses = Array.isArray(connection.courses) ? [...connection.courses] : [];

    // For Chamilo: ensure manual course code is in the list
    if (profile.courseCode && !courses.some((c) => `${c?.code || ""}`.trim() === profile.courseCode)) {
      courses.unshift({
        code: profile.courseCode,
        title: `Manual course code (${profile.courseCode})`,
        url: profile.baseUrl || ""
      });
    }

    const connectionMessage = connection.uploadUrl
      ? `Upload page found: ${connection.uploadUrl}. Courses found: ${courses.length}.`
      : `Connected to ${adapter.label}. Courses found: ${courses.length}.`;

    const updatedCourse = normalizeCoursePayload({
      ...course,
      integrations: {
        ...(course.integrations || {}),
        lmsId: adapter.id,
        [adapter.id]: {
          ...existingIntegration,
          ...profile,
          lastConnectionStatus: "connected",
          lastConnectionMessage: connectionMessage,
          lastConnectedAt: new Date().toISOString()
        }
      }
    });

    await saveCourse(updatedCourse);

    return NextResponse.json({
      ok: true,
      lmsId: adapter.id,
      lmsLabel: adapter.label,
      profile: updatedCourse.integrations[adapter.id],
      courses,
      uploadUrl: connection.uploadUrl || "",
      uploadPageTitle: connection.uploadPageTitle || ""
    });
  } catch (error) {
    const updatedCourse = normalizeCoursePayload({
      ...course,
      integrations: {
        ...(course.integrations || {}),
        lmsId: adapter.id,
        [adapter.id]: {
          ...existingIntegration,
          ...profile,
          lastConnectionStatus: "failed",
          lastConnectionMessage: error instanceof Error ? error.message : "Connection failed",
          lastConnectedAt: existingIntegration.lastConnectedAt || ""
        }
      }
    });

    await saveCourse(updatedCourse);

    return NextResponse.json(
      {
        ok: false,
        lmsId: adapter.id,
        error: error instanceof Error ? error.message : `${adapter.label} connection failed`,
        profile: updatedCourse.integrations[adapter.id]
      },
      { status: 500 }
    );
  }
}
