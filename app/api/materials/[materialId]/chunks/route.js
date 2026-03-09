import { NextResponse } from "next/server";
import { getMaterial, getMaterialChunks } from "@/lib/material-store";

function toBoundedInt(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export async function GET(request, { params }) {
  const { materialId } = await params;
  const material = await getMaterial(materialId);

  if (!material) {
    return NextResponse.json(
      {
        ok: false,
        message: "Material not found."
      },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);
  const offset = toBoundedInt(searchParams.get("offset"), 0, 0, 50000);
  const limit = toBoundedInt(searchParams.get("limit"), 20, 1, 200);
  const previewChars = toBoundedInt(searchParams.get("previewChars"), 0, 0, 2000);

  const chunks = await getMaterialChunks(materialId);
  const total = chunks.length;
  const paged = chunks.slice(offset, offset + limit).map((chunk) => {
    const text = `${chunk?.text || ""}`;
    const preview = previewChars > 0
      ? text.slice(0, previewChars)
      : text;

    return {
      id: `${chunk?.id || ""}`,
      order: Number(chunk?.order) || 0,
      length: Number(chunk?.length) || text.length,
      text,
      preview,
      truncated: previewChars > 0 && text.length > preview.length
    };
  });

  return NextResponse.json({
    ok: true,
    material: {
      id: material.id,
      fileName: material.fileName,
      status: material.status,
      chunksCount: Number(material.chunksCount) || total,
      updatedAt: material.updatedAt || ""
    },
    pagination: {
      offset,
      limit,
      total,
      returned: paged.length,
      hasMore: offset + paged.length < total
    },
    chunks: paged
  });
}
