import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import {
  createFinalTestExerciseInChamilo,
  uploadScormToChamilo
} from "@/lib/chamilo-client";
import { exportCourseToScormArchive } from "@/lib/scorm/exporter";
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
  const profile = {
    ...course.integrations?.chamilo,
    ...payload?.profile
  };

  try {
    let exercise = null;
    let chamiloScormCourse = { ...course };

    if (course.finalTest?.enabled && Array.isArray(course.finalTest?.questions) && course.finalTest.questions.length > 0) {
      exercise = await createFinalTestExerciseInChamilo({
        profile,
        finalTest: course.finalTest,
        courseTitle: course.title
      }).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : "Chamilo exercise creation failed"
      }));

      if (exercise?.ok && exercise?.exerciseId) {
        chamiloScormCourse = {
          ...course,
          finalTest: {
            ...course.finalTest,
            chamiloExerciseId: exercise.exerciseId
          }
        };
      } else {
        // Fallback to embedded HTML test if native test creation failed
        chamiloScormCourse = { ...course };
      }
    }

    const archive = await exportCourseToScormArchive(chamiloScormCourse);
    const published = await uploadScormToChamilo({
      zipBuffer: archive.zipBuffer,
      fileName: archive.fileName,
      profile
    });

    if (exercise && "_cookieJar" in exercise) {
      delete exercise._cookieJar;
    }

    if (!published.ok) {
      return NextResponse.json(
        {
          error: published.message || "Chamilo did not confirm SCORM import.",
          published,
          exportId: archive.exportId,
          downloadUrl: archive.downloadUrl,
          manifestValid: archive.manifestValid,
          scoCount: archive.scoCount,
          exercise
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      exportId: archive.exportId,
      downloadUrl: archive.downloadUrl,
      manifestValid: archive.manifestValid,
      scoCount: archive.scoCount,
      scormFinalTestEmbedded: false,
      published,
      exercise
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Chamilo publish failed"
      },
      { status: 500 }
    );
  }
}
