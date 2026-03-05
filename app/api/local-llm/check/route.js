import { NextResponse } from "next/server";
import { checkLocalLlmConnection } from "@/lib/local-llm";
import { normalizeGenerationSettings } from "@/lib/validation";

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const generation = normalizeGenerationSettings(payload?.generation);

  try {
    const result = await checkLocalLlmConnection(generation);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        provider: generation.provider,
        message: error instanceof Error ? error.message : "Local LLM connection failed"
      },
      { status: 500 }
    );
  }
}
