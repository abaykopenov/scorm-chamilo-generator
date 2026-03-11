import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { getAdapter } from "@/lib/lms/registry";
import { exportCourseToScormArchive } from "@/lib/scorm/exporter";
import { exportCourseToXapiArchive } from "@/lib/xapi/exporter";
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
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const profile = {
    ...(course.integrations?.[adapter.id] || {}),
    ...payload?.profile
  };

  try {
    // ── 1. Export SCORM or xAPI package (theory only, no embedded test) ──────────
    const theoryCourse = {
      ...course,
      finalTest: { ...(course.finalTest || {}), enabled: false }
    };
    const isXapi = Boolean(payload?.exportAsXapi);
    const archive = isXapi 
      ? await exportCourseToXapiArchive(theoryCourse) 
      : await exportCourseToScormArchive(theoryCourse);

    // ── 2. Upload theory via adapter ────────────────────────────────────
    const published = await adapter.uploadTheory({
      zipBuffer: archive.zipBuffer,
      fileName: archive.fileName,
      profile
    });

    if (!published.ok) {
      return NextResponse.json(
        {
          error: published.message || `${adapter.label} did not confirm SCORM import.`,
          published,
          exportId: archive.exportId,
          downloadUrl: archive.downloadUrl,
          manifestValid: archive.manifestValid,
          scoCount: archive.scoCount
        },
        { status: 502 }
      );
    }

    // ── 3. Create native test via adapter (if enabled) ──────────────────
    let exercise = null;
    let lpLinked = null;

    if (
      course.finalTest?.enabled &&
      Array.isArray(course.finalTest?.questions) &&
      course.finalTest.questions.length > 0
    ) {
      exercise = await adapter.createNativeTest({
        profile,
        finalTest: course.finalTest,
        courseTitle: course.title
      }).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : `${adapter.label} exercise creation failed`
      }));

      // ── 4. Link test to learning path via adapter ─────────────────────
      if (exercise?.ok && exercise?.exerciseId) {
        try {
          const lpId = published.lpId || await adapter.findLearningPathId({
            profile,
            cookieJar: exercise._cookieJar || undefined
          });
          if (lpId) {
            lpLinked = await adapter.linkTestToLearningPath({
              profile,
              lpId,
              exerciseId: exercise.exerciseId,
              exerciseTitle: course.finalTest.title || "Final test",
              cookieJar: exercise._cookieJar || undefined
            });
          } else {
            lpLinked = { ok: false, error: "LP not found" };
          }
        } catch (error) {
          lpLinked = {
            ok: false,
            error: error instanceof Error ? error.message : "Learning path link failed"
          };
        }
      }
    }

    // Clean internal state before sending response
    if (exercise && "_cookieJar" in exercise) {
      delete exercise._cookieJar;
    }

    return NextResponse.json({
      lmsId: adapter.id,
      lmsLabel: adapter.label,
      exportId: archive.exportId,
      downloadUrl: archive.downloadUrl,
      manifestValid: archive.manifestValid,
      scoCount: archive.scoCount,
      scormFinalTestEmbedded: false,
      published,
      exercise,
      lpLinked
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : `${adapter.label} publish failed`
      },
      { status: 500 }
    );
  }
}
