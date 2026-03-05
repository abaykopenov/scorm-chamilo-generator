import test from "node:test";
import assert from "node:assert/strict";
import { parseCoursesFromHtml, parseForms } from "../lib/chamilo-client.js";

test("parseForms detects login and upload forms", () => {
  const html = `
    <html>
      <body>
        <form action="/index.php" method="post">
          <input type="hidden" name="token" value="abc">
          <input type="text" name="login" value="">
          <input type="password" name="password" value="">
          <input type="submit" name="submitAuth" value="Login">
        </form>
        <form action="/main/newscorm/lp_controller.php?action=import&cidReq=DEMO" method="post" enctype="multipart/form-data">
          <input type="hidden" name="sec_token" value="xyz">
          <input type="file" name="user_file">
          <input type="submit" name="submitImport" value="Upload">
        </form>
      </body>
    </html>
  `;

  const forms = parseForms(html, "https://lms.example.com/index.php");
  assert.equal(forms.length, 2);
  assert.equal(forms[0].hasPassword, true);
  assert.equal(forms[1].hasFileInput, true);
  assert.equal(forms[1].fileInputName, "user_file");
  assert.equal(forms[1].action, "https://lms.example.com/main/newscorm/lp_controller.php?action=import&cidReq=DEMO");
});

test("parseCoursesFromHtml extracts courses from Chamilo links", () => {
  const html = `
    <html>
      <body>
        <a href="/course_home/course_home.php?cidReq=HR101">HR onboarding</a>
        <a href="/course_home/course_home.php?cidReq=SAFE_01">Safety training</a>
      </body>
    </html>
  `;

  const courses = parseCoursesFromHtml(html, "https://lms.example.com/userportal.php");
  assert.equal(courses.length, 2);
  assert.equal(courses[0].code, "HR101");
  assert.equal(courses[0].title, "HR onboarding");
  assert.equal(courses[1].code, "SAFE_01");
});

test("parseCoursesFromHtml extracts courses from data attributes", () => {
  const html = `
    <html>
      <body>
        <div class="course-card" data-cidreq="ADMIN_01">
          <a href="/main/course_info/course_home.php">Admin course</a>
        </div>
      </body>
    </html>
  `;

  const courses = parseCoursesFromHtml(html, "https://lms.example.com/userportal.php");
  assert.equal(courses.length, 1);
  assert.equal(courses[0].code, "ADMIN_01");
});
