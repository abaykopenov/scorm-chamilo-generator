import { NextResponse } from "next/server";
import { listChamiloCourses } from "@/lib/chamilo-client";

export async function POST(request) {
    const payload = await request.json().catch(() => ({}));
    const profile = payload?.profile;

    if (!profile?.baseUrl || !profile?.username || !profile?.password) {
        return NextResponse.json(
            { ok: false, error: "Заполните Portal URL, Username и Password.", courses: [] },
            { status: 400 }
        );
    }

    try {
        const result = await listChamiloCourses(profile);
        return NextResponse.json(result);
    } catch (error) {
        return NextResponse.json(
            { ok: false, error: error instanceof Error ? error.message : "Failed to list courses", courses: [] },
            { status: 500 }
        );
    }
}
