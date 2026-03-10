import { NextResponse } from "next/server";
import { isSupportedTextMaterial } from "@/lib/document-parser";
import { saveUploadedMaterial } from "@/lib/material-store";
import { checkApiAuth, checkRateLimit } from "@/lib/security";

const MAX_FILE_SIZE_MB = 50;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

export async function POST(request) {
  const authError = checkApiAuth(request);
  if (authError) return authError;
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, message: "Field \"file\" is required." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ ok: false, message: "Uploaded file is empty." }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { ok: false, message: `File is too large. Max size is ${MAX_FILE_SIZE_MB} MB.` },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const material = await saveUploadedMaterial({
      fileName: file.name,
      mimeType: file.type,
      buffer
    });

    return NextResponse.json({
      ok: true,
      material: {
        ...material,
        indexable: isSupportedTextMaterial({
          fileName: material.fileName,
          mimeType: material.mimeType
        })
      }
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Material upload failed."
      },
      { status: 500 }
    );
  }
}
