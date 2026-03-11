function escapeXml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildTinCanManifest(course) {
  const courseId = `http://example.com/course/${escapeXml(course.id)}`;
  const title = escapeXml(course.title || "Course");
  const description = escapeXml(course.description || "Generated course");

  return `<?xml version="1.0" encoding="utf-8" ?>
<tincan xmlns="http://projecttincan.com/tincan.xsd">
    <activities>
        <activity id="${courseId}" type="http://adlnet.gov/expapi/activities/course">
            <name lang="en-US">${title}</name>
            <description lang="en-US">${description}</description>
            <launch lang="en-US">index.html</launch>
        </activity>
    </activities>
</tincan>`;
}
