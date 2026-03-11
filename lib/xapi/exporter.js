import { createId } from "../ids.js";
import { saveExport } from "../course-store.js";
import { buildXapiPackage } from "./package-builder.js";

function countScos(course) {
  const learningScos = course.modules.reduce(
    (total, moduleItem) =>
      total + moduleItem.sections.reduce((sectionTotal, sectionItem) => sectionTotal + sectionItem.scos.length, 0),
    0
  );
  return learningScos + (course.finalTest?.enabled ? 1 : 0);
}

export async function exportCourseToXapiArchive(course) {
  const exportId = createId("export");
  const packageResult = buildXapiPackage(course);
  const downloadName = `${course.title.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "course"}-xapi.zip`;
  
  const metadata = await saveExport(exportId, packageResult.buffer, {
    courseId: course.id,
    format: "xapi",
    manifestValid: packageResult.manifest.includes("<tincan"),
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
