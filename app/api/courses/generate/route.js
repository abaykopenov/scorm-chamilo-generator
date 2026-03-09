import { NextResponse } from "next/server";
import { saveCourse } from "@/lib/course-store";
import { generateCourseDraft } from "@/lib/course-generator";

function clampProgress(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(numeric)));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : "Course generation failed.";
}

function createProgressStream(payload) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const send = (event) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      const report = (percent, stage, message) => {
        send({
          type: "progress",
          percent: clampProgress(percent),
          stage: `${stage || ""}`,
          message: `${message || ""}`
        });
      };

      try {
        report(3, "request", "Preparing request");

        const course = await generateCourseDraft(payload, {
          onProgress: report,
          onModuleReady: async (event) => {
            const moduleIndex = Number(event?.moduleIndex || 0);
            const totalModules = Number(event?.totalModules || 0);
            const moduleTitle = `${event?.module?.title || ""}`.trim();

            const snapshot = {
              ...(event?.course || {}),
              generationStatus: "in_progress",
              completedModules: moduleIndex + 1
            };

            if (snapshot?.id) {
              await saveCourse(snapshot);
            }

            send({
              type: "module_ready",
              courseId: snapshot?.id || "",
              moduleIndex,
              totalModules,
              moduleTitle,
              completedModules: moduleIndex + 1
            });
          }
        });

        report(92, "saving", "Saving course");
        const savedCourse = await saveCourse({
          ...course,
          generationStatus: "completed",
          completedModules: Array.isArray(course?.modules) ? course.modules.length : 0
        });

        report(100, "done", "Completed");
        send({ type: "done", course: savedCourse });
      } catch (error) {
        send({ type: "error", message: toErrorMessage(error) });
      } finally {
        controller.close();
      }
    }
  });
}

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const streamMode = request.nextUrl.searchParams.get("stream") === "1";

  if (!streamMode) {
    try {
      const course = await generateCourseDraft(payload);
      const savedCourse = await saveCourse({
        ...course,
        generationStatus: "completed",
        completedModules: Array.isArray(course?.modules) ? course.modules.length : 0
      });
      return NextResponse.json(savedCourse, { status: 201 });
    } catch (error) {
      return NextResponse.json(
        {
          ok: false,
          message: toErrorMessage(error)
        },
        { status: 400 }
      );
    }
  }

  return new Response(createProgressStream(payload), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
