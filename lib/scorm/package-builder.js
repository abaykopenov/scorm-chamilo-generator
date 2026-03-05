import { buildManifest } from "./manifest.js";
import { createRuntimeAssets, createScoHtmlFiles } from "./runtime.js";
import { createZip } from "./zip.js";

export function buildScormPackage(course) {
  const manifest = buildManifest(course);
  const files = [
    { name: "imsmanifest.xml", content: manifest },
    ...createRuntimeAssets(course),
    ...createScoHtmlFiles(course)
  ];

  return {
    manifest,
    files,
    buffer: createZip(files)
  };
}
