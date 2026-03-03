import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { processFiles } from "@/lib/file-processor";

const UPLOAD_DIR = path.join(process.cwd(), ".data", "uploads");

export async function POST(request) {
    try {
        await mkdir(UPLOAD_DIR, { recursive: true });
        const formData = await request.formData();
        const files = formData.getAll("files");

        if (!files || files.length === 0) {
            return Response.json({ error: "No files provided" }, { status: 400 });
        }

        const savedPaths = [];
        for (const file of files) {
            if (!(file instanceof File)) continue;
            const bytes = await file.arrayBuffer();
            const buffer = Buffer.from(bytes);
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
            const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeName}`);
            await writeFile(filePath, buffer);
            savedPaths.push(filePath);
        }

        // Extract text and chunk
        const result = await processFiles(savedPaths);

        return Response.json({
            ok: true,
            filesProcessed: result.files,
            totalChars: result.totalChars,
            chunksCount: result.chunks.length,
            chunks: result.chunks
        });
    } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
    }
}
