import { NextResponse } from "next/server";
import { indexMaterials } from "@/lib/material-indexer";
import { normalizeEmbeddingSettings, normalizeGenerationSettings } from "@/lib/validation";

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const generation = normalizeGenerationSettings(payload?.generation);
  const embedding = normalizeEmbeddingSettings(
    payload?.embedding,
    {
      provider: generation.provider === "template" ? "ollama" : generation.provider,
      baseUrl: generation.baseUrl,
      model: "nomic-embed-text"
    }
  );

  const documentIds = Array.isArray(payload?.documentIds)
    ? payload.documentIds.map((value) => `${value || ""}`.trim()).filter(Boolean)
    : [];

  const chunking = {
    maxChars: Number(payload?.chunking?.maxChars) || 1000,
    overlapChars: Number(payload?.chunking?.overlapChars) || 180,
    minChars: Number(payload?.chunking?.minChars) || 160
  };

  try {
    const summary = await indexMaterials(documentIds, {
      embedding,
      chunking
    });
    return NextResponse.json({
      ok: true,
      embedding,
      ...summary
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Indexing failed."
      },
      { status: 500 }
    );
  }
}
