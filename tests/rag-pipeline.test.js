import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chunkText } from "../lib/chunker.js";
import { isSupportedTextMaterial, parseDocumentText } from "../lib/document-parser.js";
import { indexMaterialDocument } from "../lib/material-indexer.js";
import { deleteMaterial, getMaterial, getMaterialVectors, saveUploadedMaterial } from "../lib/material-store.js";
import { cosineSimilarity, searchVectorRecords } from "../lib/vector-search.js";

test("chunkText splits long text into chunks", () => {
  const text = Array.from({ length: 18 }, (_, index) => `Параграф ${index + 1}. Контент для теста.`).join("\n\n");
  const chunks = chunkText(text, { maxChars: 220, overlapChars: 60, minChars: 100 });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length > 0));
  assert.equal(chunks[0].order, 1);
});

test("chunkText does not loop forever on one huge paragraph", () => {
  const text = "A".repeat(220_000);
  const chunks = chunkText(text, { maxChars: 1000, overlapChars: 180, minChars: 160 });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.length < 1000);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
});

test("searchVectorRecords returns highest score first", () => {
  const results = searchVectorRecords({
    records: [
      {
        materialId: "m1",
        chunks: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }],
        vectors: [[1, 0, 0], [0, 1, 0]]
      }
    ],
    queryVector: [0.98, 0.04, 0],
    topK: 1
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].chunk.id, "c1");
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.99);
});

test("indexMaterialDocument stores vectors and updates material status", async () => {
  const material = await saveUploadedMaterial({
    fileName: "test-material.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Первый абзац.\n\nВторой абзац.\n\nТретий абзац.", "utf8")
  });

  const result = await indexMaterialDocument(material.id, {
    embedder: async (texts) => texts.map((text, index) => [text.length / 100, index + 1, 0.5]),
    embedding: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "mock-embedding"
    }
  });

  assert.equal(result.ok, true);
  assert.ok(result.chunksCount > 0);

  const updated = await getMaterial(material.id);
  const vectors = await getMaterialVectors(material.id);
  assert.equal(updated?.status, "indexed");
  assert.equal(updated?.embeddingModel, "mock-embedding");
  assert.equal(vectors?.vectors?.length, result.chunksCount);
  assert.equal(vectors?.chunks?.length, result.chunksCount);
});

test("parseDocumentText extracts text from docx via textutil", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "docx-test-"));
  const txtPath = path.join(tempDir, "source.txt");
  const docxPath = path.join(tempDir, "source.docx");
  const expectedText = "DOCX пример для RAG";

  try {
    writeFileSync(txtPath, expectedText, "utf8");
    execFileSync("/usr/bin/textutil", ["-convert", "docx", txtPath, "-output", docxPath]);
    const buffer = readFileSync(docxPath);

    const parsed = parseDocumentText({
      fileName: "source.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer
    });

    assert.ok(parsed.includes(expectedText));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isSupportedTextMaterial accepts pdf and docx", () => {
  assert.equal(
    isSupportedTextMaterial({
      fileName: "manual.pdf",
      mimeType: "application/pdf"
    }),
    true
  );

  assert.equal(
    isSupportedTextMaterial({
      fileName: "guide.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }),
    true
  );
});

test("parseDocumentText truncates very large text input", () => {
  const source = `Ввод\n${"A".repeat(500_000)}\nХвост`;
  const parsed = parseDocumentText({
    fileName: "huge.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(source, "utf8")
  });

  assert.ok(parsed.length < 360_000);
  assert.ok(parsed.includes("truncated"));
});

test("deleteMaterial removes file and metadata", async () => {
  const material = await saveUploadedMaterial({
    fileName: "delete-me.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Удаляемый материал", "utf8")
  });

  const deleted = await deleteMaterial(material.id);
  assert.equal(deleted.ok, true);

  const missing = await getMaterial(material.id);
  assert.equal(missing, null);
});
