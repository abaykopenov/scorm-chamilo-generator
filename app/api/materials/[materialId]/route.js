import { NextResponse } from "next/server";
import { deleteMaterial, getMaterial } from "@/lib/material-store";

export async function DELETE(_request, { params }) {
  const { materialId } = await params;
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
