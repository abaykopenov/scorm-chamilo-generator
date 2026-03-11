import { NextResponse } from "next/server";
import { listAdapters } from "@/lib/lms/registry";

export async function GET() {
  const adapters = listAdapters();
  return NextResponse.json({ adapters });
}
