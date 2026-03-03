import { getJob, subscribeJob } from "@/lib/job-store";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
    const { jobId } = await params;
    const job = await getJob(jobId);

    if (!job) {
        return new Response(JSON.stringify({ error: "Job not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
        });
    }

    // If job is already done, return JSON
    if (job.status === "completed" || job.status === "failed") {
        return Response.json(job);
    }

    // SSE stream for ongoing jobs
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            // Send current state immediately
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: job.id,
                status: job.status,
                progress: job.progress,
                currentStep: job.currentStep,
                courseId: job.courseId,
                error: job.error,
                stepsCompleted: job.steps.length
            })}\n\n`));

            // Subscribe to updates  
            const unsub = subscribeJob(jobId, (data) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    if (data.status === "completed" || data.status === "failed") {
                        setTimeout(() => {
                            try { controller.close(); } catch { }
                        }, 500);
                    }
                } catch {
                    unsub();
                }
            });

            // Cleanup on abort
            request.signal.addEventListener("abort", () => {
                unsub();
                try { controller.close(); } catch { }
            });
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
        }
    });
}
