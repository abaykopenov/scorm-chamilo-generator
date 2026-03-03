import { getSettings, saveSettings } from "@/lib/settings-store";
import { LlmPool } from "@/lib/llm-pool";

export async function GET() {
    const settings = await getSettings();
    return Response.json({ servers: settings.servers || [] });
}

export async function PUT(request) {
    const body = await request.json();
    const settings = await getSettings();
    settings.servers = body.servers || [];
    await saveSettings(settings);
    return Response.json({ ok: true, servers: settings.servers });
}

export async function POST(request) {
    // Health check all servers
    const settings = await getSettings();
    const servers = settings.servers || [];
    const pool = new LlmPool(servers);
    const results = await pool.checkAll();
    return Response.json({ results });
}
