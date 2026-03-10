import { NextResponse } from "next/server";
import { deleteMaterial, getMaterial } from "@/lib/material-store";
import { guardResourceId, checkApiAuth, checkRateLimit } from "@/lib/security";

export async function DELETE(_request, { params }) {
  const authError = checkApiAuth(_request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(_request);
  if (rateLimitError) return rateLimitError;

  const { materialId: rawId } = await params;
  const materialId = guardResourceId(rawId, "Material");
  if (materialId instanceof NextResponse) return materialId;

  const existing = await getMaterial(materialId);
  if (!existing) {
    return NextResponse.json(
      {
        ok: false,
        message: "Material not found."
      },
      { status: 404 }
    );
  }

  const result = await deleteMaterial(materialId);
  return NextResponse.json(result);
}
