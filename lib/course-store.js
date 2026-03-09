import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

export async function listCourses(options = {}) {
  await ensureDirectories();
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 100;

  const names = await readdir(COURSES_DIR).catch(() => []);
  const jsonFiles = names.filter((name) => name.toLowerCase().endsWith(".json"));

  const courses = [];
  for (const fileName of jsonFiles) {
    const filePath = path.join(COURSES_DIR, fileName);
    try {
      const [course, fileStat] = await Promise.all([
        readJson(filePath),
        stat(filePath)
      ]);

      const moduleCount = Array.isArray(course?.modules) ? course.modules.length : 0;
      const generationStatus = `${course?.generationStatus || "completed"}`.trim() || "completed";
      const completedModules = Number(course?.completedModules || (generationStatus === "completed" ? moduleCount : 0));

      courses.push({
        id: `${course?.id || ""}`.trim() || fileName.replace(/\.json$/i, ""),
        title: `${course?.title || "Untitled course"}`.trim() || "Untitled course",
        description: `${course?.description || ""}`.trim(),
        updatedAt: course?.updatedAt || fileStat.mtime.toISOString(),
        createdAt: course?.createdAt || fileStat.birthtime.toISOString(),
        generationStatus,
        completedModules,
        moduleCount
      });
    } catch {
      // ignore corrupted course json file
    }
  }

  courses.sort((a, b) => {
    const left = new Date(a.updatedAt).getTime() || 0;
    const right = new Date(b.updatedAt).getTime() || 0;
    return right - left;
  });

  return courses.slice(0, limit);
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
