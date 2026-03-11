import { NextResponse } from "next/server";
import { generateCourseContentFromOutline } from "@/lib/course-generator";
import { saveCourse } from "@/lib/course-store";

function toErrorMessage(error) {
  return error instanceof Error ? error.message : `${error || "Unknown error"}`;
}

export const maxDuration = 300;

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { payload, outline, ragContext, plannerPlan } = body;
  const streamMode = request.nextUrl.searchParams.get("stream") === "1";

  if (!payload || !outline || !ragContext || !plannerPlan) {
    return NextResponse.json({ ok: false, message: "Missing required fields (payload, outline, ragContext, plannerPlan)" }, { status: 400 });
  }

  if (!streamMode) {
    try {
      const course = await generateCourseContentFromOutline(payload, outline, ragContext, plannerPlan, {});
      const savedCourse = await saveCourse({
        ...course,
        generationStatus: "completed",
        completedModules: Array.isArray(course?.modules) ? course.modules.length : 0
      });
      return NextResponse.json(savedCourse, { status: 201 });
    } catch (error) {
      return NextResponse.json(
        { ok: false, message: toErrorMessage(error) },
        { status: 400 }
      );
    }
  }

  // Define a custom progress stream for phase B/C
  const createContentProgressStream = () => {
    let active = true;
    let pushEvent = () => {};

    const hooks = {
      onProgress: (percent, stage, message, meta) => {
        if (!active) return;
        pushEvent({ type: "progress", percent, stage, message, meta });
      }
    };

    const run = async () => {
      try {
        pushEvent({ type: "progress", percent: 25, stage: "content", message: "Starting content generation pipeline..." });
        const course = await generateCourseContentFromOutline(payload, outline, ragContext, plannerPlan, hooks);
        
        pushEvent({ type: "progress", percent: 95, stage: "saving", message: "Saving final course..." });
        const savedCourse = await saveCourse({
          ...course,
          generationStatus: "completed",
          completedModules: Array.isArray(course?.modules) ? course.modules.length : 0
        });
        
        pushEvent({ type: "completion", courseId: savedCourse.id, message: "Course generated successfully" });
      } catch (error) {
        if (!active) return;
        console.error("Content generation stream error:", error);
        pushEvent({ type: "error", message: toErrorMessage(error) });
      } finally {
        pushEvent({ type: "close" });
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        pushEvent = (data) => {
          if (!active) return;
          try {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
            if (data.type === "close") {
              active = false;
              controller.close();
            }
          } catch {
            active = false;
          }
        };
        run();
      },
      cancel() {
        active = false;
        pushEvent = () => {};
      }
    });

    return stream;
  };

  return new Response(createContentProgressStream(), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
