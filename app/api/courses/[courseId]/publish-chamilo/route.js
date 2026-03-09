import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import {
  addExerciseToLearningPath,
  createFinalTestExerciseInChamilo,
  findLatestLpId,
  uploadScormToChamilo
} from "@/lib/chamilo-client";
import { exportCourseToScormArchive } from "@/lib/scorm/exporter";

export async function POST(request, { params }) {
  const { courseId } = await params;
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
    const chamiloScormCourse = {
      ...course,
      finalTest: {
        ...(course.finalTest || {}),
        enabled: false
      }
    };
    const archive = await exportCourseToScormArchive(chamiloScormCourse);
    const published = await uploadScormToChamilo({
      zipBuffer: archive.zipBuffer,
      fileName: archive.fileName,
      profile
    });

    if (!published.ok) {
      return NextResponse.json(
        {
          error: published.message || "Chamilo did not confirm SCORM import.",
          published,
          exportId: archive.exportId,
          downloadUrl: archive.downloadUrl,
          manifestValid: archive.manifestValid,
          scoCount: archive.scoCount
        },
        { status: 502 }
      );
    }

    let exercise = null;
    let lpLinked = null;

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
        try {
          const lpId = published.lpId || await findLatestLpId({
            profile,
            cookieJar: exercise._cookieJar || undefined
          });
          if (lpId) {
            lpLinked = await addExerciseToLearningPath({
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

    if (exercise && "_cookieJar" in exercise) {
      delete exercise._cookieJar;
    }

    return NextResponse.json({
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
        error: error instanceof Error ? error.message : "Chamilo publish failed"
      },
      { status: 500 }
    );
  }
}
