import { NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings-store";

export async function GET() {
    const settings = await getSettings();
    return NextResponse.json(settings);
}

export async function PUT(request) {
    const payload = await request.json().catch(() => ({}));
    const saved = await saveSettings(payload);
    return NextResponse.json(saved);
}
