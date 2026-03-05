import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "./ids.js";

const DATA_DIR = path.join(process.cwd(), ".data");
const MATERIALS_DIR = path.join(DATA_DIR, "materials");
const FILES_DIR = path.join(MATERIALS_DIR, "files");
const DOCS_DIR = path.join(MATERIALS_DIR, "documents");
const CHUNKS_DIR = path.join(MATERIALS_DIR, "chunks");
const VECTORS_DIR = path.join(MATERIALS_DIR, "vectors");

async function ensureDirectories() {
  await Promise.all([
    mkdir(FILES_DIR, { recursive: true }),
    mkdir(DOCS_DIR, { recursive: true }),
    mkdir(CHUNKS_DIR, { recursive: true }),
    mkdir(VECTORS_DIR, { recursive: true })
  ]);
}

function sanitizeFileName(fileName) {
  const safe = `${fileName || "material"}`
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "");

  return safe || "material";
}

function getDocumentPath(materialId) {
  return path.join(DOCS_DIR, `${materialId}.json`);
}

function getChunksPath(materialId) {
  return path.join(CHUNKS_DIR, `${materialId}.json`);
}

function getVectorsPath(materialId) {
  return path.join(VECTORS_DIR, `${materialId}.json`);
}

async function writeJson(filePath, value) {
  await ensureDirectories();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function readJsonOptional(filePath) {
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

function toIsoNow() {
  return new Date().toISOString();
}

function computeHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function getMaterialStatusLabel(status) {
  if (["uploaded", "indexed", "failed"].includes(status)) {
    return status;
  }
  return "uploaded";
}

export async function saveUploadedMaterial({ fileName, mimeType, buffer }) {
  await ensureDirectories();

  const materialId = createId("material");
  const safeFileName = sanitizeFileName(fileName);
  const storedName = `${materialId}_${safeFileName}`;
  const filePath = path.join(FILES_DIR, storedName);
  const createdAt = toIsoNow();
  const payload = {
    id: materialId,
    fileName: safeFileName,
    storedFileName: storedName,
    filePath,
    mimeType: `${mimeType || "application/octet-stream"}`,
    size: buffer.byteLength,
    sha256: computeHash(buffer),
    status: "uploaded",
    chunksCount: 0,
    embeddingModel: "",
    embeddingProvider: "",
    errorMessage: "",
    createdAt,
    updatedAt: createdAt
  };

  await Promise.all([
    writeFile(filePath, buffer),
    writeJson(getDocumentPath(materialId), payload)
  ]);

  return payload;
}

export async function listMaterials() {
  await ensureDirectories();

  const files = (await readdir(DOCS_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => right.localeCompare(left));

  const documents = await Promise.all(
    files.map((name) => readJsonOptional(path.join(DOCS_DIR, name)))
  );

  return documents
    .filter(Boolean)
    .sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""));
}

export async function getMaterial(materialId) {
  return readJsonOptional(getDocumentPath(materialId));
}

export async function updateMaterial(materialId, patch) {
  const current = await getMaterial(materialId);
  if (!current) {
    return null;
  }

  const payload = {
    ...current,
    ...patch,
    status: getMaterialStatusLabel(patch?.status ?? current.status),
    updatedAt: toIsoNow()
  };

  await writeJson(getDocumentPath(materialId), payload);
  return payload;
}

export async function readMaterialFile(materialId) {
  const material = await getMaterial(materialId);
  if (!material) {
    return null;
  }

  try {
    await stat(material.filePath);
    const buffer = await readFile(material.filePath);
    return { material, buffer };
  } catch {
    return null;
  }
}

export async function saveMaterialChunks(materialId, chunks) {
  await writeJson(getChunksPath(materialId), {
    materialId,
    chunks,
    updatedAt: toIsoNow()
  });
}

export async function getMaterialChunks(materialId) {
  const payload = await readJsonOptional(getChunksPath(materialId));
  return payload?.chunks ?? [];
}

export async function saveMaterialVectors(materialId, vectorsPayload) {
  await writeJson(getVectorsPath(materialId), {
    materialId,
    ...vectorsPayload,
    updatedAt: toIsoNow()
  });
}

export async function getMaterialVectors(materialId) {
  return readJsonOptional(getVectorsPath(materialId));
}

export async function listMaterialVectorRecords(materialIds) {
  const ids = Array.isArray(materialIds) ? materialIds.filter(Boolean) : [];
  if (ids.length === 0) {
    return [];
  }

  const records = await Promise.all(ids.map((id) => getMaterialVectors(id)));
  return records.filter(Boolean);
}

export async function deleteMaterial(materialId) {
  const material = await getMaterial(materialId);
  if (!material) {
    return {
      ok: false,
      materialId,
      message: "Material not found."
    };
  }

  const paths = [
    material.filePath,
    getDocumentPath(materialId),
    getChunksPath(materialId),
    getVectorsPath(materialId)
  ];

  await Promise.all(
    paths.map((filePath) => rm(filePath, { force: true }).catch(() => {}))
  );

  return {
    ok: true,
    materialId,
    fileName: material.fileName
  };
}
