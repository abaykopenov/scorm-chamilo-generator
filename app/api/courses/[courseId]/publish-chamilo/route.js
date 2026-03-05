import { NextResponse } from "next/server";
import { getCourse } from "@/lib/course-store";
import { uploadScormToChamilo } from "@/lib/chamilo-client";
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
    const archive = await exportCourseToScormArchive(course);
    const published = await uploadScormToChamilo({
      zipBuffer: archive.zipBuffer,
      fileName: archive.fileName,
      profile
    });

    return NextResponse.json({
      exportId: archive.exportId,
      downloadUrl: archive.downloadUrl,
      manifestValid: archive.manifestValid,
      scoCount: archive.scoCount,
      published
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
