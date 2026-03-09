import test from "node:test";
import assert from "node:assert/strict";
import { __chamiloClientInternals, createChamiloTest, parseCoursesFromHtml, parseForms } from "../lib/chamilo-client.js";

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

test("parseCoursesFromHtml extracts courses from script JSON payload", () => {
  const html = `
    <script>
      window.__COURSES__ = [
        {"code":"QA_101","title":"Quality assurance"},
        {"course_code":"OPS_7","name":"Operations basics"}
      ];
    </script>
  `;

  const courses = parseCoursesFromHtml(html, "https://lms.example.com/chamilo/userportal.php");
  assert.equal(courses.length, 2);
  assert.equal(courses[0].code, "OPS_7");
  assert.equal(courses[1].code, "QA_101");
});

test("parseCoursesFromHtml decodes nested-encoded cidReq links", () => {
  const html = `
    <a href="/main/social/profile.php?next=%252Fmain%252Fcourse_home%252Fcourse_home.php%253FcidReq%253DFIN_02">Finance</a>
  `;

  const courses = parseCoursesFromHtml(html, "https://lms.example.com/chamilo/userportal.php");
  assert.equal(courses.length, 1);
  assert.equal(courses[0].code, "FIN_02");
});

test("parseCoursesFromHtml ignores non-course UI elements", () => {
  const html = `
    <html>
      <body>
        <a href="/main/newscorm/lp_controller.php?action=import&cidReq=ADMIN_01">Import</a>
        <a href="/main/profile.php?code=profile">Profile</a>
        <select name="language">
          <option value="EN">English</option>
          <option value="RU">Russian</option>
        </select>
        <a href="/course_home/course_home.php?cidReq=HR101">HR onboarding</a>
      </body>
    </html>
  `;

  const courses = parseCoursesFromHtml(html, "https://lms.example.com/userportal.php");
  assert.equal(courses.length, 1);
  assert.equal(courses[0].code, "HR101");
});

test("parseCoursesFromHtml extracts course options from course select", () => {
  const html = `
    <select id="course_code" name="course_code">
      <option value="">Choose course</option>
      <option value="OPS_01">Operations</option>
      <option value="SAFE_01">Safety</option>
    </select>
  `;

  const courses = parseCoursesFromHtml(html, "https://lms.example.com/chamilo/main/newscorm/lp_controller.php");
  assert.equal(courses.length, 2);
  assert.equal(courses[0].code, "OPS_01");
  assert.equal(courses[1].code, "SAFE_01");
});

function createMockResponse({ status = 200, url = "", body = "", location = "", setCookies = [] } = {}) {
  return {
    status,
    url,
    headers: {
      get(name) {
        if (`${name}`.toLowerCase() === "location") {
          return location || null;
        }
        return null;
      },
      getSetCookie() {
        return setCookies;
      }
    },
    async text() {
      return body;
    }
  };
}

test("createChamiloTest creates exercise and sends PHP-array style question payload", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  let questionGetCount = 0;

  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const method = (options.method || "GET").toUpperCase();

    if (url.endsWith("/index.php") && method === "POST") {
      return createMockResponse({
        status: 302,
        url,
        location: "/main/userportal.php",
        setCookies: ["ch_sid=abc123; Path=/; HttpOnly"]
      });
    }

    if (url.includes("/main/exercise/exercise_admin.php") && method === "GET") {
      return createMockResponse({
        status: 200,
        url,
        body: `<input type="hidden" name="protect_token" value="token_create">`
      });
    }

    if (url.includes("/main/exercise/exercise_admin.php") && method === "POST") {
      return createMockResponse({
        status: 302,
        url,
        location: "/main/exercise/admin.php?cidReq=TEST&exerciseId=321"
      });
    }

    if (url.includes("/main/exercise/admin.php") && method === "GET") {
      questionGetCount += 1;
      return createMockResponse({
        status: 200,
        url,
        body: `<input type="hidden" name="protect_token" value="token_q_${questionGetCount}">`
      });
    }

    if (url.includes("/main/exercise/admin.php") && method === "POST") {
      return createMockResponse({
        status: 200,
        url,
        body: "ok"
      });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    const result = await createChamiloTest(
      {
        baseUrl: "http://lms.local",
        username: "user",
        password: "pass",
        courseCode: "TEST",
        loginPath: "/index.php"
      },
      {
        title: "Quiz 1",
        questions: [
          {
            text: "Capital of France?",
            options: ["Paris", "London", "Berlin", "Rome"],
            correctIndex: 0
          }
        ]
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.exerciseId, "321");
    assert.equal(result.questionCount, 1);

    const createExerciseRequest = requests.find((entry) => entry.url.includes("/main/exercise/exercise_admin.php") && `${entry.options?.method || ""}`.toUpperCase() === "POST");
    assert.ok(createExerciseRequest, "exercise create POST request was not sent");
    assert.ok(createExerciseRequest.options.body.includes("exerciseTitle=Quiz%201"));
    assert.ok(createExerciseRequest.options.body.includes("protect_token=token_create"));

    const questionPostRequest = requests.find((entry) => entry.url.includes("/main/exercise/admin.php") && `${entry.options?.method || ""}`.toUpperCase() === "POST");
    assert.ok(questionPostRequest, "question POST request was not sent");
    assert.ok(questionPostRequest.options.body.includes("questionName=Capital%20of%20France%3F"));
    assert.ok(questionPostRequest.options.body.includes("answer[1]=Paris"));
    assert.ok(questionPostRequest.options.body.includes("weighting[1]=10"));
    assert.ok(!questionPostRequest.options.body.includes("answer%5B1%5D"));

    assert.match(createExerciseRequest.options.headers.Cookie || "", /ch_sid=abc123/);
    assert.match(questionPostRequest.options.headers.Cookie || "", /ch_sid=abc123/);
  } finally {
    global.fetch = originalFetch;
  }
});


test("strict upload confirmation is enabled by default", () => {
  const previous = process.env.CHAMILO_UPLOAD_STRICT_CONFIRMATION;
  delete process.env.CHAMILO_UPLOAD_STRICT_CONFIRMATION;
  try {
    assert.equal(__chamiloClientInternals.isStrictUploadConfirmationEnabled(), true);
  } finally {
    if (previous == null) {
      delete process.env.CHAMILO_UPLOAD_STRICT_CONFIRMATION;
    } else {
      process.env.CHAMILO_UPLOAD_STRICT_CONFIRMATION = previous;
    }
  }
});

test("extractLpIdFromUploadResult picks lp_id from response URL and history", () => {
  const fromUrl = __chamiloClientInternals.extractLpIdFromUploadResult({
    responseUrl: "http://lms.local/main/lp/lp_controller.php?action=build&lp_id=321&cidReq=TEST",
    redirectHistory: [],
    responseSnippet: ""
  });
  assert.equal(fromUrl, "321");

  const fromHistory = __chamiloClientInternals.extractLpIdFromUploadResult({
    responseUrl: "http://lms.local/main/upload/upload.php?cidReq=TEST",
    redirectHistory: [
      {
        status: 302,
        url: "http://lms.local/main/newscorm/lp_controller.php?action=list&cidReq=TEST",
        location: "/main/lp/lp_controller.php?action=build&lp_id=654&cidReq=TEST"
      }
    ],
    responseSnippet: ""
  });
  assert.equal(fromHistory, "654");
});
