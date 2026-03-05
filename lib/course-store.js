import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const COURSES_DIR = path.join(DATA_DIR, "courses");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");

async function ensureDirectories() {
  await Promise.all([
    mkdir(COURSES_DIR, { recursive: true }),
    mkdir(EXPORTS_DIR, { recursive: true })
  ]);
}

async function writeJson(filePath, value) {
  await ensureDirectories();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function saveCourse(course) {
  await ensureDirectories();
  const filePath = path.join(COURSES_DIR, `${course.id}.json`);
  const payload = {
    ...course,
    updatedAt: new Date().toISOString()
  };
  await writeJson(filePath, payload);
  return payload;
}

export async function getCourse(courseId) {
  const filePath = path.join(COURSES_DIR, `${courseId}.json`);
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

export async function saveExport(exportId, zipBuffer, metadata) {
  await ensureDirectories();
  const zipPath = path.join(EXPORTS_DIR, `${exportId}.zip`);
  const metaPath = path.join(EXPORTS_DIR, `${exportId}.json`);

  await writeFile(zipPath, zipBuffer);
  await writeJson(metaPath, {
    ...metadata,
    exportId,
    zipPath,
    createdAt: new Date().toISOString()
  });

  return {
    ...metadata,
    exportId,
    zipPath
  };
}

export async function getExportMeta(exportId) {
  const metaPath = path.join(EXPORTS_DIR, `${exportId}.json`);
  try {
    return await readJson(metaPath);
  } catch {
    return null;
  }
}

export async function getExportZip(exportId) {
  const meta = await getExportMeta(exportId);
  if (!meta) {
    return null;
  }

  try {
    await stat(meta.zipPath);
    const buffer = await readFile(meta.zipPath);
    return { meta, buffer };
  } catch {
    return null;
  }
}
