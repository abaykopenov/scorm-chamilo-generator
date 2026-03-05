import { NextResponse } from "next/server";
import { listMaterials } from "@/lib/material-store";

export async function GET() {
  const materials = await listMaterials();
  return NextResponse.json({ materials });
}
