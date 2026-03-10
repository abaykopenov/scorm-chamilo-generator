import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import {
  addExerciseToLearningPath,
  createFinalTestExerciseInChamilo,
  findLatestLpId
} from "@/lib/chamilo-client";

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

  if (!course.finalTest?.enabled || !Array.isArray(course.finalTest?.questions) || course.finalTest.questions.length === 0) {
    return NextResponse.json(
      {
        error: "Final test is disabled or has no questions."
      },
      { status: 400 }
    );
  }

  try {
    const exercise = await createFinalTestExerciseInChamilo({
      profile,
      finalTest: course.finalTest,
      courseTitle: course.title
    });

    if (!exercise?.ok || !exercise?.exerciseId) {
      const message = exercise?.message || "Chamilo exercise creation failed";
      return NextResponse.json(
        {
          error: message,
          exercise
        },
        { status: 502 }
      );
    }

    let lpLinked = null;
    const requestedLpId = Number(payload?.lpId);
    const lpId = Number.isFinite(requestedLpId) && requestedLpId > 0
      ? requestedLpId
      : await findLatestLpId({
          profile,
          cookieJar: exercise._cookieJar || undefined
        });

    if (lpId) {
      try {
        lpLinked = await addExerciseToLearningPath({
          profile,
          lpId,
          exerciseId: exercise.exerciseId,
          exerciseTitle: course.finalTest.title || "Final test",
          cookieJar: exercise._cookieJar || undefined
        });
      } catch (error) {
        lpLinked = {
          ok: false,
          error: error instanceof Error ? error.message : "Learning path link failed"
        };
      }
    } else {
      lpLinked = {
        ok: false,
        error: "Learning path was not found automatically. Open LP in Chamilo and retry."
      };
    }

    if ("_cookieJar" in exercise) {
      delete exercise._cookieJar;
    }

    return NextResponse.json(
      {
        exercise,
        lpLinked,
        lpId: lpId || null
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Chamilo test publish failed"
      },
      { status: 500 }
    );
  }
}
