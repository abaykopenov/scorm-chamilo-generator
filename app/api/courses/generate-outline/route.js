import { NextResponse } from "next/server";
import { generateCourseOutlineOnly } from "@/lib/course-generator";

export const maxDuration = 300;

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  try {
    const data = await generateCourseOutlineOnly(payload, {});
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : `${error || "Unknown error"}`
      },
      { status: 400 }
    );
  }
}
