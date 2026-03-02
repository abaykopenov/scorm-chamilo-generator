import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { createChamiloExercise } from "@/lib/chamilo-client";

export async function POST(request, { params }) {
    const { courseId } = await params;
    const course = await getCourse(courseId);
    if (!course) {
        return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const payload = await request.json().catch(() => ({}));
    const profile = payload?.profile;

    if (!profile?.baseUrl || !profile?.username || !profile?.password || !profile?.courseCode) {
        return NextResponse.json(
            { error: "Заполните URL, логин, пароль и курс Chamilo." },
            { status: 400 }
        );
    }

    if (!course.finalTest?.enabled || !course.finalTest?.questions?.length) {
        return NextResponse.json(
            { error: "У курса нет финального теста или вопросов." },
            { status: 400 }
        );
    }

    try {
        const result = await createChamiloExercise({
            profile,
            exercise: {
                title: course.finalTest.title || "Итоговый тест",
                passingScore: course.finalTest.passingScore || 80,
                attemptsLimit: course.finalTest.attemptsLimit || 3,
                maxTimeMinutes: course.finalTest.maxTimeMinutes || 30,
                questions: course.finalTest.questions
            }
        });

        return NextResponse.json(result);
    } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
