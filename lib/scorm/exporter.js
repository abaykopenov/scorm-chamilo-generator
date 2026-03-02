import { createId } from "../ids.js";
import { saveExport } from "../course-store.js";
import { buildScormPackage } from "./package-builder.js";

function countScos(course) {
  return course.modules.reduce(
    (total, moduleItem) =>
      total + moduleItem.sections.reduce((sectionTotal, sectionItem) => sectionTotal + sectionItem.scos.length, 0),
    0
  );
}

export async function exportCourseToScorm(course) {
  const exportId = createId("export");
  const packageResult = buildScormPackage(course);
  const metadata = await saveExport(exportId, packageResult.buffer, {
    courseId: course.id,
    format: "scorm12",
    manifestValid: packageResult.manifest.includes("<manifest"),
    scoCount: countScos(course),
    downloadName: `${course.title.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "course"}-scorm12.zip`
  });

  return {
    exportId,
    format: "scorm12",
    manifestValid: metadata.manifestValid,
    scoCount: metadata.scoCount,
    downloadUrl: `/api/exports/${exportId}/download`
  };
}

export async function exportCourseToScormArchive(course) {
  const exportId = createId("export");
  const packageResult = buildScormPackage(course);
  const downloadName = `${course.title.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "course"}-scorm12.zip`;
  const metadata = await saveExport(exportId, packageResult.buffer, {
    courseId: course.id,
    format: "scorm12",
    manifestValid: packageResult.manifest.includes("<manifest"),
    scoCount: countScos(course),
    downloadName
  });

  return {
    exportId,
    fileName: downloadName,
    zipBuffer: packageResult.buffer,
    manifestValid: metadata.manifestValid,
    scoCount: metadata.scoCount,
    downloadUrl: `/api/exports/${exportId}/download`
  };
}
