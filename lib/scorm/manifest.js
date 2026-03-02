function escapeXml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createScoItem(sco, resourceId, depth = 0, masteryScore = null) {
  const indent = "  ".repeat(depth);
  return `${indent}<item identifier="ITEM_${sco.id}" identifierref="${resourceId}">
${indent}  <title>${escapeXml(sco.title)}</title>
${masteryScore != null ? `${indent}  <adlcp:masteryscore>${masteryScore}</adlcp:masteryscore>\n` : ""}${indent}</item>`;
}

export function buildManifest(course) {
  const resourceEntries = [];
  const itemEntries = [];

  course.modules.forEach((moduleItem) => {
    const sectionItems = moduleItem.sections
      .map((sectionItem) => {
        const scoItems = sectionItem.scos.map((sco) => {
          const resourceId = `RES_${sco.id}`;
          resourceEntries.push(
            `<resource identifier="${resourceId}" type="webcontent" adlcp:scormtype="sco" href="sco/${sco.id}.html">
  <file href="sco/${sco.id}.html" />
</resource>`
          );
          return createScoItem(sco, resourceId, 4, sco.masteryScore ?? null);
        });

        return `      <item identifier="ITEM_${sectionItem.id}">
        <title>${escapeXml(sectionItem.title)}</title>
${scoItems.join("\n")}
      </item>`;
      })
      .join("\n");

    itemEntries.push(`    <item identifier="ITEM_${moduleItem.id}">
      <title>${escapeXml(moduleItem.title)}</title>
${sectionItems}
    </item>`);
  });


  // Final test is NOT included in SCORM — it's created as a native Chamilo exercise

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST_${escapeXml(course.id)}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
  http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG_1">
    <organization identifier="ORG_1">
      <title>${escapeXml(course.title)}</title>
${itemEntries.join("\n")}
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES_INDEX" type="webcontent" adlcp:scormtype="asset" href="index.html">
      <file href="index.html" />
      <file href="assets/runtime.js" />
      <file href="assets/style.css" />
    </resource>
${resourceEntries.map((entry) => `    ${entry.replaceAll("\n", "\n    ")}`).join("\n")}
  </resources>
</manifest>`;
}
