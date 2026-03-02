function trimText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

function getAttr(tag, attrName) {
  const match = tag.match(new RegExp(`${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return stripQuotes(match?.[1] ?? "");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function resolveUrl(baseUrl, maybeRelative) {
  return new URL(maybeRelative || "", baseUrl).toString();
}

function parseInputs(formHtml) {
  const inputs = [];
  const inputRegex = /<input\b([^>]*)>/gi;
  let inputMatch;

  while ((inputMatch = inputRegex.exec(formHtml))) {
    const attrs = inputMatch[1] ?? "";
    const name = getAttr(attrs, "name");
    if (!name) continue;

    inputs.push({
      tagName: "input",
      name,
      type: getAttr(attrs, "type").toLowerCase() || "text",
      value: decodeHtml(getAttr(attrs, "value"))
    });
  }

  const textAreaRegex = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  let textAreaMatch;

  while ((textAreaMatch = textAreaRegex.exec(formHtml))) {
    const attrs = textAreaMatch[1] ?? "";
    const name = getAttr(attrs, "name");
    if (!name) continue;

    inputs.push({
      tagName: "textarea",
      name,
      type: "textarea",
      value: decodeHtml((textAreaMatch[2] ?? "").trim())
    });
  }

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let match;

  while ((match = selectRegex.exec(formHtml))) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const name = getAttr(attrs, "name");
    if (!name) continue;

    const optionMatch =
      inner.match(/<option\b[^>]*selected[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) ||
      inner.match(/<option\b[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    inputs.push({
      tagName: "select",
      name,
      type: "select",
      value: stripQuotes(optionMatch?.[1] ?? "")
    });
  }

  return inputs;
}

export function parseForms(html, baseUrl) {
  const forms = [];
  const openTagRegex = /<form\b([^>]*)>/gi;
  let openMatch;

  while ((openMatch = openTagRegex.exec(html))) {
    const attrs = openMatch[1] ?? "";
    const startIndex = openMatch.index + openMatch[0].length;

    let depth = 1;
    let searchIndex = startIndex;
    let endIndex = html.length;
    while (depth > 0 && searchIndex < html.length) {
      const nextOpen = html.indexOf("<form", searchIndex);
      const nextClose = html.indexOf("</form", searchIndex);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        searchIndex = nextOpen + 5;
      } else {
        depth -= 1;
        if (depth === 0) endIndex = nextClose;
        searchIndex = nextClose + 7;
      }
    }

    const body = html.slice(startIndex, endIndex);
    const inputs = parseInputs(body);
    const action = resolveUrl(baseUrl, getAttr(attrs, "action") || baseUrl);
    const method = (getAttr(attrs, "method") || "GET").toUpperCase();
    const fileInput = inputs.find((input) => input.type === "file");
    const hasPassword = inputs.some((input) => input.type === "password");

    forms.push({
      action,
      method,
      inputs,
      html: body,
      hasPassword,
      hasFileInput: Boolean(fileInput),
      fileInputName: fileInput?.name ?? ""
    });
  }

  return forms;
}

function pickForm(forms, predicate, fallbackMessage) {
  const form = forms.find(predicate);
  if (!form) throw new Error(fallbackMessage);
  return form;
}

function formToUrlEncoded(form, overrides) {
  const body = new URLSearchParams();
  form.inputs.forEach((input) => {
    if (input.type === "file") return;
    if (input.type === "submit" && overrides[input.name] == null) return;
    body.set(input.name, overrides[input.name] ?? input.value ?? "");
  });
  Object.entries(overrides).forEach(([key, value]) => {
    if (value == null) return;
    body.set(key, value);
  });
  return body;
}

function formToMultipart(form, overrides, fileName, buffer) {
  const body = new FormData();
  form.inputs.forEach((input) => {
    if (input.type === "file") return;
    if (input.type === "submit" && overrides[input.name] == null) return;
    body.set(input.name, overrides[input.name] ?? input.value ?? "");
  });
  Object.entries(overrides).forEach(([key, value]) => {
    if (value == null) return;
    body.set(key, value);
  });
  body.set(form.fileInputName || "user_file", new File([buffer], fileName, { type: "application/zip" }));
  return body;
}

function createCookieJar() {
  const jar = new Map();
  return {
    addFromResponse(response) {
      const cookies =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [];
      cookies.forEach((cookie) => {
        const firstPart = cookie.split(";")[0];
        const separatorIndex = firstPart.indexOf("=");
        if (separatorIndex > 0) {
          jar.set(firstPart.slice(0, separatorIndex), firstPart.slice(separatorIndex + 1));
        }
      });
    },
    header() {
      return Array.from(jar.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
    }
  };
}

function buildUploadUrl(profile) {
  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  const url = new URL(`${base}/main/upload/index.php`);
  if (profile.courseCode) {
    url.searchParams.set("cidReq", profile.courseCode);
  }
  url.searchParams.set("tool", "learnpath");
  url.searchParams.set("curdirpath", "/");
  return url.toString();
}

function buildLoginUrl(profile) {
  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  const path = trimText(profile.loginPath || "index.php").replace(/^\//, "");
  return `${base}/${path}`;
}

function buildRequestHeaders(cookieJar) {
  const cookie = cookieJar.header();
  return cookie ? { Cookie: cookie } : {};
}

async function followRedirects(url, cookieJar, maxHops = 8) {
  let currentUrl = url;
  let response;
  for (let hop = 0; hop < maxHops; hop += 1) {
    response = await fetch(currentUrl, {
      headers: buildRequestHeaders(cookieJar),
      redirect: "manual"
    });
    cookieJar.addFromResponse(response);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }
  return { response, url: currentUrl };
}

/* ─── Shared login helper ─── */

function findLoginForm(html, pageUrl) {
  // Try normal form parsing first
  const forms = parseForms(html, pageUrl);
  const formWithPw = forms.find((f) => f.hasPassword);
  if (formWithPw) return formWithPw;

  // Fallback: if page has a password input but no <form> wraps it,
  // build a synthetic form from ALL inputs on the page
  const inputs = parseInputs(html);
  if (inputs.some((i) => i.type === "password")) {
    return {
      action: pageUrl,
      method: "POST",
      inputs,
      hasPassword: true,
      hasFileInput: false,
      fileInputName: ""
    };
  }
  return null;
}

async function chamiloLogin(profile) {
  const cookieJar = createCookieJar();
  const loginUrl = buildLoginUrl(profile);

  const loginPage = await followRedirects(loginUrl, cookieJar);
  const loginPageHtml = await loginPage.response.text();
  const loginForm = findLoginForm(loginPageHtml, loginPage.url);

  if (!loginForm) {
    const htmlSnippet = loginPageHtml.slice(0, 300).replace(/\n/g, " ");
    throw new Error(
      `Логин-форма не найдена. URL: ${loginPage.url}, HTTP ${loginPage.response.status}, ` +
      `HTML: ${loginPageHtml.length} байт. Snippet: ${htmlSnippet}`
    );
  }

  const loginName =
    loginForm.inputs.find((i) =>
      ["login", "username", "user", "email"].includes(i.name.toLowerCase())
    )?.name ?? "login";
  const passwordName =
    loginForm.inputs.find((i) => i.type === "password")?.name ?? "password";
  const submitBtn = loginForm.inputs.find((i) => i.type === "submit");

  const overrides = {
    [loginName]: profile.username,
    [passwordName]: profile.password
  };
  if (submitBtn) overrides[submitBtn.name] = submitBtn.value || "Login";

  const loginResp = await fetch(loginForm.action, {
    method: loginForm.method,
    headers: {
      ...buildRequestHeaders(cookieJar),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formToUrlEncoded(loginForm, overrides),
    redirect: "manual"
  });
  cookieJar.addFromResponse(loginResp);

  // Follow post-login redirects to collect session cookies
  if (loginResp.status >= 300 && loginResp.status < 400) {
    const loc = loginResp.headers.get("location");
    if (loc) {
      await followRedirects(new URL(loc, loginForm.action).toString(), cookieJar);
    }
  }

  return cookieJar;
}

/* ─── Public API ─── */

export async function checkChamiloConnection(profile) {
  if (!trimText(profile?.baseUrl) || !trimText(profile?.username) || !trimText(profile?.password)) {
    return { ok: false, error: "Заполните Portal URL, Username и Password." };
  }

  let cookieJar;
  try {
    cookieJar = await chamiloLogin(profile);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (profile.courseCode) {
    try {
      const uploadPageUrl = buildUploadUrl(profile);
      const { response: upResp } = await followRedirects(uploadPageUrl, cookieJar);
      const upHtml = await upResp.text();
      const upForms = parseForms(upHtml, uploadPageUrl);
      const hasUpload = upForms.some((f) => f.hasFileInput) || /<input[^>]*type\s*=\s*["']file["']/i.test(upHtml);

      return {
        ok: true,
        login: true,
        uploadPage: hasUpload,
        message: hasUpload
          ? "Подключение успешно. Страница импорта SCORM доступна."
          : "Логин успешен, но форма импорта не найдена."
      };
    } catch (err) {
      return { ok: true, login: true, uploadPage: false, message: `Логин успешен. Ошибка страницы импорта: ${err.message}` };
    }
  }

  return { ok: true, login: true, uploadPage: false, message: "Логин в Chamilo успешен." };
}

function extractCourses(html) {
  const courses = [];
  const seen = new Set();

  const cidRegex = /cidReq=([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = cidRegex.exec(html))) {
    const code = m[1];
    if (seen.has(code)) continue;
    seen.add(code);
    let title = code;
    const linkIdx = html.lastIndexOf("<a", m.index);
    if (linkIdx >= 0 && m.index - linkIdx < 500) {
      const linkEnd = html.indexOf("</a>", m.index);
      if (linkEnd > 0) {
        const textMatch = html.slice(m.index, linkEnd).match(/>([^<]+)</);
        if (textMatch) title = decodeHtml(textMatch[1].trim()) || code;
      }
    }
    courses.push({ code, title });
  }

  const aboutRegex = /href="[^"]*\/course\/\d+\/about"[^>]*>\s*([^<]+)</gi;
  while ((m = aboutRegex.exec(html))) {
    const title = decodeHtml(m[1].trim());
    if (title && !courses.some((c) => c.title === title)) {
      courses.push({ code: title.toUpperCase().replace(/\s+/g, "_"), title });
    }
  }
  return courses;
}

export async function listChamiloCourses(profile) {
  if (!trimText(profile?.baseUrl) || !trimText(profile?.username) || !trimText(profile?.password)) {
    return { ok: false, error: "Заполните Portal URL, Username и Password.", courses: [] };
  }

  let cookieJar;
  try {
    cookieJar = await chamiloLogin(profile);
  } catch (err) {
    return { ok: false, error: err.message, courses: [] };
  }

  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  const { response: portalResp } = await followRedirects(`${base}/user_portal.php`, cookieJar);
  const portalHtml = await portalResp.text();
  let courses = extractCourses(portalHtml);

  if (courses.length === 0) {
    try {
      const { response: adminResp } = await followRedirects(`${base}/main/admin/course_list.php`, cookieJar);
      courses = extractCourses(await adminResp.text());
    } catch { /* ignore */ }
  }

  return { ok: true, courses };
}

export async function uploadScormToChamilo({ zipBuffer, fileName, profile }) {
  if (!trimText(profile?.baseUrl) || !trimText(profile?.username) || !trimText(profile?.password)) {
    throw new Error("Заполните URL, логин и пароль Chamilo.");
  }
  if (!trimText(profile?.courseCode)) {
    throw new Error("Укажите код курса Chamilo (поле 'Курс'). Нажмите '📋 Курсы' чтобы загрузить список.");
  }

  const cookieJar = await chamiloLogin(profile);

  const uploadPageUrl = buildUploadUrl(profile);
  const { response: uploadPageResponse, url: resolvedUploadUrl } =
    await followRedirects(uploadPageUrl, cookieJar);
  const uploadPageHtml = await uploadPageResponse.text();

  let uploadForm = parseForms(uploadPageHtml, resolvedUploadUrl).find((f) => f.hasFileInput);

  // Fallback: build from raw page inputs
  if (!uploadForm) {
    const inputs = parseInputs(uploadPageHtml);
    const fileInput = inputs.find((i) => i.type === "file");
    if (fileInput) {
      uploadForm = {
        action: resolvedUploadUrl,
        method: "POST",
        inputs,
        hasFileInput: true,
        fileInputName: fileInput.name
      };
    }
  }

  if (!uploadForm) {
    throw new Error(
      `Upload-форма не найдена. URL: ${resolvedUploadUrl}, HTTP ${uploadPageResponse.status}`
    );
  }

  const uploadOverrides = {};
  const uploadSubmitBtn = uploadForm.inputs.find((i) => i.type === "submit");
  if (uploadSubmitBtn) uploadOverrides[uploadSubmitBtn.name] = uploadSubmitBtn.value || "Upload";

  const uploadBody = formToMultipart(uploadForm, uploadOverrides, fileName, zipBuffer);
  const uploadResponse = await fetch(uploadForm.action, {
    method: uploadForm.method,
    headers: buildRequestHeaders(cookieJar),
    body: uploadBody,
    redirect: "manual"
  });
  cookieJar.addFromResponse(uploadResponse);
  const responseText = await uploadResponse.text();

  return {
    ok: uploadResponse.ok || (uploadResponse.status >= 300 && uploadResponse.status < 400),
    status: uploadResponse.status,
    uploadUrl: uploadForm.action,
    responseUrl: uploadResponse.url || uploadForm.action,
    responseSnippet: responseText.slice(0, 400)
  };
}

/* ─── Create native Chamilo exercise ─── */

export async function createChamiloExercise({ profile, exercise }) {
  if (!trimText(profile?.baseUrl) || !trimText(profile?.username) || !trimText(profile?.password)) {
    throw new Error("Заполните URL, логин и пароль Chamilo.");
  }
  if (!trimText(profile?.courseCode)) {
    throw new Error("Укажите код курса Chamilo.");
  }

  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  const cookieJar = await chamiloLogin(profile);
  const cidReq = trimText(profile.courseCode);

  // Step 1: GET the exercise creation form to extract hidden fields and CSRF token
  const exerciseFormUrl = `${base}/main/exercise/exercise_admin.php?cidReq=${cidReq}`;
  const { response: formResp, url: formUrl } = await followRedirects(exerciseFormUrl, cookieJar);
  const formHtml = await formResp.text();

  // Extract protect_token from the page HTML
  const tokenMatch = formHtml.match(/name\s*=\s*["']protect_token["'][^>]*value\s*=\s*["']([^"']*)["']/i)
    || formHtml.match(/value\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']protect_token["']/i);
  const protectToken = tokenMatch ? tokenMatch[1] : "";

  // Build the form action URL
  const actionMatch = formHtml.match(/<form[^>]*id\s*=\s*["']exercise_admin["'][^>]*action\s*=\s*["']([^"']*)["']/i)
    || formHtml.match(/<form[^>]*action\s*=\s*["']([^"']*exercise_admin[^"']*)["']/i);
  const formAction = actionMatch
    ? new URL(decodeHtml(actionMatch[1]), formUrl).toString()
    : formUrl;

  // Step 2: POST to create the exercise shell
  const exBody = new URLSearchParams();
  exBody.set("_qf__exercise_admin", "");
  if (protectToken) exBody.set("protect_token", protectToken);
  exBody.set("exerciseTitle", exercise.title || "Итоговый тест");
  exBody.set("exerciseDescription", "");
  exBody.set("exerciseFeedbackType", "0");
  exBody.set("results_disabled", "0");
  exBody.set("exerciseType", "2");
  exBody.set("question_selection_type", "1");
  exBody.set("randomQuestions", "0");
  exBody.set("randomAnswers", "0");
  exBody.set("display_category_name", "1");
  exBody.set("hide_question_title", "0");
  exBody.set("exerciseAttempts", String(exercise.attemptsLimit || 3));
  exBody.set("pass_percentage", String(exercise.passingScore || 80));
  exBody.set("edit", "false");
  exBody.set("item_id", "0");
  if (exercise.maxTimeMinutes) {
    exBody.set("enabletimercontroltotalminutes", String(exercise.maxTimeMinutes));
    exBody.set("enabletimercontrol", "1");
  }
  exBody.set("submitExercise", "");

  const exResp = await fetch(formAction, {
    method: "POST",
    headers: {
      ...buildRequestHeaders(cookieJar),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: exBody,
    redirect: "manual"
  });
  cookieJar.addFromResponse(exResp);

  // Follow redirects after exercise creation and extract exerciseId
  let exerciseId = null;
  if (exResp.status >= 300 && exResp.status < 400) {
    const loc = exResp.headers.get("location");
    if (loc) {
      const fullLoc = new URL(loc, formAction).toString();
      const exIdMatch = fullLoc.match(/exerciseId=(\d+)/i);
      if (exIdMatch) exerciseId = exIdMatch[1];
      await followRedirects(fullLoc, cookieJar);
    }
  }
  // Fallback: parse exerciseId from response body
  if (!exerciseId) {
    const respText = await exResp.text().catch(() => "");
    const m = respText.match(/exerciseId=(\d+)/i);
    if (m) exerciseId = m[1];
  }

  // Step 3: Add each question
  const questions = exercise.questions || [];
  const results = [];

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx];
    const options = q.options || [];

    try {
      // ── Step A: GET the "new question" form ──
      const qFormUrl = `${base}/main/exercise/admin.php?cidReq=${cidReq}&newQuestion=yes&answerType=1`;
      const { response: qFormResp, url: qUrl } = await followRedirects(qFormUrl, cookieJar);
      const qFormHtml = await qFormResp.text();

      // Extract hidden fields from the page
      const hiddenFields = {};
      const hiddenRegex = /<input[^>]*type\s*=\s*["']hidden["'][^>]*name\s*=\s*["']([^"']*)["'][^>]*value\s*=\s*["']([^"']*)["']/gi;
      let hm;
      while ((hm = hiddenRegex.exec(qFormHtml))) hiddenFields[hm[1]] = hm[2];
      // Also check value-before-name order
      const hiddenRegex2 = /<input[^>]*value\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']([^"']*)["'][^>]*type\s*=\s*["']hidden["']/gi;
      while ((hm = hiddenRegex2.exec(qFormHtml))) hiddenFields[hm[2]] = hm[1];

      // ── Step B: POST the question name ──
      const qBody = new URLSearchParams();
      for (const [k, v] of Object.entries(hiddenFields)) qBody.set(k, v);
      qBody.set("questionName", q.prompt || `Вопрос ${qIdx + 1}`);
      qBody.set("questionDescription", "");
      qBody.set("questionLevel", "1");
      qBody.set("questionCategory", "");
      qBody.set("submitQuestion", "");

      const qResp = await fetch(qUrl, {
        method: "POST",
        headers: { ...buildRequestHeaders(cookieJar), "Content-Type": "application/x-www-form-urlencoded" },
        body: qBody,
        redirect: "manual"
      });
      cookieJar.addFromResponse(qResp);

      // Follow redirect to the answer form
      let answerPageUrl = qUrl;
      let answerHtml = "";
      if (qResp.status >= 300 && qResp.status < 400) {
        const loc = qResp.headers.get("location");
        if (loc) {
          answerPageUrl = new URL(loc, qUrl).toString();
          const { response: ansResp, url: ansUrl } = await followRedirects(answerPageUrl, cookieJar);
          answerPageUrl = ansUrl;
          answerHtml = await ansResp.text();
        }
      } else {
        answerHtml = await qResp.text();
      }

      // ── Step C: POST the answers ──
      // Extract hidden fields from the answer page
      const ansHiddenFields = {};
      const ansHiddenRegex = /<input[^>]*type\s*=\s*["']hidden["'][^>]*name\s*=\s*["']([^"']*)["'][^>]*value\s*=\s*["']([^"']*)["']/gi;
      while ((hm = ansHiddenRegex.exec(answerHtml))) ansHiddenFields[hm[1]] = hm[2];
      const ansHiddenRegex2 = /<input[^>]*value\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']([^"']*)["'][^>]*type\s*=\s*["']hidden["']/gi;
      while ((hm = ansHiddenRegex2.exec(answerHtml))) ansHiddenFields[hm[2]] = hm[1];

      const correctIdx = options.findIndex((opt) => opt.id === q.correctOptionId);
      const correctNum = correctIdx >= 0 ? correctIdx + 1 : 1;

      const ansBody = new URLSearchParams();
      for (const [k, v] of Object.entries(ansHiddenFields)) ansBody.set(k, v);
      ansBody.set("nb_answers", String(options.length || 4));
      ansBody.set("correct", String(correctNum));

      options.forEach((opt, optIdx) => {
        const num = optIdx + 1;
        ansBody.set(`answer[${num}]`, `<p>${opt.text || `Вариант ${num}`}</p>`);
        ansBody.set(`counter[${num}]`, String(num));
        ansBody.set(`weighting[${num}]`, num === correctNum ? "10" : "0");
        ansBody.set(`comment[${num}]`, "");
      });
      ansBody.set("submitAnswers", "");

      const ansResp = await fetch(answerPageUrl, {
        method: "POST",
        headers: { ...buildRequestHeaders(cookieJar), "Content-Type": "application/x-www-form-urlencoded" },
        body: ansBody,
        redirect: "manual"
      });
      cookieJar.addFromResponse(ansResp);

      if (ansResp.status >= 300 && ansResp.status < 400) {
        const loc = ansResp.headers.get("location");
        if (loc) await followRedirects(new URL(loc, answerPageUrl).toString(), cookieJar);
      }

      results.push({ question: qIdx + 1, ok: true, status: ansResp.status });
    } catch (qErr) {
      results.push({ question: qIdx + 1, ok: false, error: qErr.message });
    }
  }

  return {
    ok: true,
    exerciseId,
    exerciseTitle: exercise.title,
    questionsCreated: results.filter((r) => r.ok).length,
    totalQuestions: questions.length,
    results,
    _cookieJar: cookieJar
  };
}

/* ─── Add exercise to learning path ─── */

export async function addExerciseToLearningPath({ profile, lpId, exerciseId, exerciseTitle, cookieJar: existingJar }) {
  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  const cidReq = trimText(profile.courseCode);
  const jar = existingJar || await chamiloLogin(profile);

  // Find the last item in the LP to set as "previous" (must be at end)
  const lpUrl = `${base}/main/lp/lp_controller.php?cidReq=${cidReq}&action=build&lp_id=${lpId}`;
  const { response: lpResp } = await followRedirects(lpUrl, jar);
  const lpHtml = await lpResp.text();

  // Try multiple patterns to find item IDs
  let itemIds = [...lpHtml.matchAll(/id\s*=\s*["']lp_item_(\d+)["']/gi)].map(m => m[1]);
  if (itemIds.length === 0) {
    itemIds = [...lpHtml.matchAll(/data-id\s*=\s*["'](\d+)["']/gi)].map(m => m[1]);
  }
  // Also try the "previous" select options
  if (itemIds.length === 0) {
    const selectMatch = lpHtml.match(/<select[^>]*name\s*=\s*["']previous["'][^>]*>([\s\S]*?)<\/select>/i);
    if (selectMatch) {
      itemIds = [...selectMatch[1].matchAll(/value\s*=\s*["'](\d+)["']/gi)].map(m => m[1]);
    }
  }
  const lastItemId = itemIds.length > 0 ? itemIds[itemIds.length - 1] : "0";

  // POST to add exercise to LP
  const addUrl = `${base}/main/lp/lp_controller.php?cidReq=${cidReq}&id_session=0&gidReq=0&gradebook=0&origin=&action=add_item&lp_id=${lpId}`;
  const body = new URLSearchParams();
  body.set("title", exerciseTitle || "Итоговый тест");
  body.set("parent", "0");
  body.set("previous", lastItemId);
  body.set("submit_button", "");
  body.set("_qf__quiz_form", "");
  body.set("path", String(exerciseId));
  body.set("type", "quiz");
  body.set("post_time", String(Math.floor(Date.now() / 1000)));

  const resp = await fetch(addUrl, {
    method: "POST",
    headers: {
      ...buildRequestHeaders(jar),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    redirect: "manual"
  });
  jar.addFromResponse(resp);

  return {
    ok: resp.ok || (resp.status >= 300 && resp.status < 400),
    status: resp.status
  };
}

/* ─── Find LP ID from course page ─── */

export async function findLatestLpId({ profile, cookieJar: existingJar }) {
  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  const cidReq = trimText(profile.courseCode);
  const jar = existingJar || await chamiloLogin(profile);

  const lpListUrl = `${base}/main/lp/lp_controller.php?cidReq=${cidReq}`;
  const { response: resp } = await followRedirects(lpListUrl, jar);
  const html = await resp.text();

  // Find all lp_id= values and return the highest (latest)
  const ids = [...html.matchAll(/lp_id=(\d+)/gi)].map(m => Number(m[1]));
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.length > 0 ? Math.max(...uniqueIds) : null;
}
