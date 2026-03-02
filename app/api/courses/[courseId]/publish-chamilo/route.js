import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import {
  uploadScormToChamilo,
  createChamiloExercise,
  findLatestLpId,
  addExerciseToLearningPath
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
    // Step 1: Export and upload SCORM package (learning content)
    const archive = await exportCourseToScormArchive(course);
    const published = await uploadScormToChamilo({
      zipBuffer: archive.zipBuffer,
      fileName: archive.fileName,
      profile
    });

    // Step 2: Create native Chamilo exercise (for test tracking/statistics)
    let exerciseResult = null;
    let lpLinked = null;

    if (course.finalTest?.enabled && course.finalTest?.questions?.length > 0) {
      try {
        exerciseResult = await createChamiloExercise({
          profile,
          exercise: {
            title: course.finalTest.title || "Итоговый тест",
            passingScore: course.finalTest.passingScore || 80,
            attemptsLimit: course.finalTest.attemptsLimit || 3,
            maxTimeMinutes: course.finalTest.maxTimeMinutes || 30,
            questions: course.finalTest.questions
          }
        });

        // Step 3: Find the learning path and add the exercise to it
        if (exerciseResult?.ok && exerciseResult?.exerciseId) {
          try {
            const lpId = await findLatestLpId({
              profile,
              cookieJar: exerciseResult._cookieJar
            });

            if (lpId) {
              lpLinked = await addExerciseToLearningPath({
                profile,
                lpId,
                exerciseId: exerciseResult.exerciseId,
                exerciseTitle: course.finalTest.title || "Итоговый тест",
                cookieJar: exerciseResult._cookieJar
              });
            } else {
              lpLinked = { ok: false, error: "LP не найден" };
            }
          } catch (lpErr) {
            lpLinked = { ok: false, error: lpErr.message };
          }
        }
      } catch (exErr) {
        exerciseResult = { ok: false, error: exErr.message };
      }
    }

    // Clean internal data before returning
    if (exerciseResult) delete exerciseResult._cookieJar;

    return NextResponse.json({
      exportId: archive.exportId,
      downloadUrl: archive.downloadUrl,
      manifestValid: archive.manifestValid,
      scoCount: archive.scoCount,
      published,
      exercise: exerciseResult,
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
