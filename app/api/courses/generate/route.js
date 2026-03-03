import { NextResponse } from "next/server";
import { saveCourse } from "@/lib/course-store";
import { generateCourseDraft } from "@/lib/course-generator";
import { generateParallel } from "@/lib/parallel-generator";
import { buildCourseFromOutline } from "@/lib/local-llm";
import { normalizeGenerateInput } from "@/lib/validation";
import { createJob, saveJob, emitJobUpdate } from "@/lib/job-store";
import { getSettings } from "@/lib/settings-store";
import { createId } from "@/lib/ids";

export async function POST(request) {
  const payload = await request.json();
  const { fileChunks, async: useAsync, concurrency } = payload;

  // Check if we have multiple servers configured → use parallel
  const settings = await getSettings();
  const servers = settings.servers || [];
  const hasServers = servers.filter((s) => s.enabled && s.url && s.model).length > 0;

  if (useAsync && hasServers) {
    // Async parallel generation with job tracking
    const input = normalizeGenerateInput(payload);
    const jobId = createId("job");
    const job = createJob(jobId, {
      title: input.titleHint,
      moduleCount: input.structure.moduleCount,
      serversCount: servers.length
    });
    job.status = "running";
    job.currentStep = "Запуск параллельной генерации...";
    await saveJob(job);

    // Fire and forget — run in background
    (async () => {
      try {
        const outline = await generateParallel(input, servers, job, {
          concurrency: concurrency || 4,
          fileChunks: fileChunks || []
        });

        if (outline) {
          const course = buildCourseFromOutline(input, outline);
          const savedCourse = await saveCourse(course);
          job.status = "completed";
          job.courseId = savedCourse.id;
          job.progress = 100;
          job.currentStep = "✅ Курс готов!";
        } else {
          // Fallback to template
          const course = await generateCourseDraft(payload);
          const savedCourse = await saveCourse(course);
          job.status = "completed";
          job.courseId = savedCourse.id;
          job.progress = 100;
          job.currentStep = "✅ Курс готов (шаблон)";
        }
      } catch (err) {
        job.status = "failed";
        job.error = err.message;
        job.currentStep = `❌ Ошибка: ${err.message}`;
      }
      await saveJob(job);
      emitJobUpdate(job);
    })();

    return NextResponse.json({ jobId, status: "running" }, { status: 202 });
  }

  // Sync generation (original behavior, single server)
  // If fileChunks provided, inject into generation input
  if (fileChunks && fileChunks.length > 0) {
    payload._fileChunks = fileChunks;
  }

  const course = await generateCourseDraft(payload);
  const savedCourse = await saveCourse(course);
  return NextResponse.json(savedCourse, { status: 201 });
}
