import { buildTinCanManifest } from "./manifest.js";
import { createRuntimeAssets, createScoHtmlFiles } from "./runtime.js";
import { createZip } from "../scorm/zip.js";

export function buildXapiPackage(course) {
  const manifest = buildTinCanManifest(course);
  const files = [
    { name: "tincan.xml", content: manifest },
    ...createRuntimeAssets(course),
    ...createScoHtmlFiles(course)
  ];

  return {
    manifest,
    files,
    buffer: createZip(files)
  };
}
