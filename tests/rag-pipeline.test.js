import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chunkText } from "../lib/chunker.js";
import { isSupportedTextMaterial, parseDocumentText } from "../lib/document-parser.js";
import { indexMaterialDocument } from "../lib/material-indexer.js";
import { deleteMaterial, getMaterial, getMaterialVectors, saveUploadedMaterial } from "../lib/material-store.js";
import { cosineSimilarity, searchVectorRecords } from "../lib/vector-search.js";

test("chunkText splits long text into chunks", () => {
  const text = Array.from({ length: 18 }, (_, index) => `Paragraph ${index + 1}. Content for test.`).join("\n\n");
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
    buffer: Buffer.from("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", "utf8")
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

test("parseDocumentText extracts text from docx via mammoth", async () => {
  const fixturePath = path.join(process.cwd(), "node_modules", "mammoth", "test", "test-data", "single-paragraph.docx");
  const buffer = readFileSync(fixturePath);

  const parsed = await parseDocumentText({
    fileName: "single-paragraph.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer
  });

  assert.ok(parsed.includes("Walking on imported air"));
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

test("parseDocumentText truncates very large text input", async () => {
  const source = `Intro\n${"A".repeat(500_000)}\nTail`;
  const parsed = await parseDocumentText({
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
    buffer: Buffer.from("Material to delete", "utf8")
  });

  const deleted = await deleteMaterial(material.id);
  assert.equal(deleted.ok, true);

  const missing = await getMaterial(material.id);
  assert.equal(missing, null);
});

test("chunkText dehyphenates lines and removes duplicate paragraphs", () => {
  const text = [
    "Digital twin hy-\nbrid architecture improves reliability and visibility.",
    "Digital twin hy-\nbrid architecture improves reliability and visibility.",
    "A separate paragraph adds context for operational onboarding tasks."
  ].join("\n\n");

  const chunks = chunkText(text, { maxChars: 2000, overlapChars: 0, minChars: 120 });
  const joined = chunks.map((chunk) => chunk.text).join(" ");

  assert.match(joined, /hybrid architecture/i);
  assert.equal((joined.match(/hybrid architecture/gi) || []).length, 1);
});

test("chunkText skips mojibake-like paragraphs when valid text exists", () => {
  const text = [
    "Ð¾Ð·Ð´Ð°Ð½Ð¸Ñ Ð¸Ð·Ð´ÐµÐ»Ð¸Ñ Ð½Ð° Ð±Ð°Ð·Ðµ MBSE.",
    "Normal paragraph with concrete learning guidance for staff onboarding."
  ].join("\n\n");

  const chunks = chunkText(text, { maxChars: 2000, overlapChars: 0, minChars: 120 });
  const joined = chunks.map((chunk) => chunk.text).join(" ");

  assert.match(joined, /concrete learning guidance/i);
  assert.doesNotMatch(joined, /Ð/);
});
