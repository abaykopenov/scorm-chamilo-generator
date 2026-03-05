function trimText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function normalizeChamiloProfile(profile) {
  const baseUrl = trimText(profile?.baseUrl).replace(/\/$/, "");
  const uploadPagePath = trimText(profile?.uploadPagePath || "/main/newscorm/lp_controller.php?action=import") || "/main/newscorm/lp_controller.php?action=import";
  const loginPath = trimText(profile?.loginPath || "/index.php") || "/index.php";

  return {
    ...profile,
    name: trimText(profile?.name || "My Chamilo") || "My Chamilo",
    baseUrl,
    username: trimText(profile?.username),
    password: trimText(profile?.password),
    courseCode: trimText(profile?.courseCode),
    uploadPagePath: uploadPagePath.startsWith("/") ? uploadPagePath : `/${uploadPagePath}`,
    loginPath: loginPath.startsWith("/") ? loginPath : `/${loginPath}`
  };
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

function decodeMaybeEncodedUrl(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseInputs(formHtml) {
  const inputs = [];
  const inputRegex = /<input\b([^>]*)>/gi;
  let inputMatch;

  while ((inputMatch = inputRegex.exec(formHtml))) {
    const attrs = inputMatch[1] ?? "";
    const name = getAttr(attrs, "name");
    if (!name) {
      continue;
    }

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
    if (!name) {
      continue;
    }

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
    if (!name) {
      continue;
    }

    const optionMatch = inner.match(/<option\b[^>]*selected[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
      || inner.match(/<option\b[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
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
  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match;

  while ((match = formRegex.exec(html))) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
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

export function parseCoursesFromHtml(html, baseUrl) {
  const courses = new Map();
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html))) {
    const attrs = match[1] ?? "";
    const href = getAttr(attrs, "href");
    const dataCidReq = getAttr(attrs, "data-cidreq");
    const dataCode = getAttr(attrs, "data-code");
    const decodedHref = href ? decodeMaybeEncodedUrl(href) : "";
    const resolved = href ? resolveUrl(baseUrl, decodedHref) : "";
    let code = dataCidReq || dataCode;

    if (!code && href && decodedHref.includes("cidReq=")) {
      const url = new URL(resolved);
      code = url.searchParams.get("cidReq");
    }

    if (!code && href) {
      const inlineCodeMatch = decodedHref.match(/[?&](?:cidReq|course_code|code)=([^&]+)/i);
      code = inlineCodeMatch?.[1] ?? "";
    }

    if (!code) {
      continue;
    }

    const title = decodeHtml(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || code;
    if (!courses.has(code)) {
      courses.set(code, {
        code,
        title,
        url: resolved || baseUrl
      });
    }
  }

  const datasetRegex = /\bdata-cidreq\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let datasetMatch;

  while ((datasetMatch = datasetRegex.exec(html))) {
    const code = stripQuotes(datasetMatch[1] ?? "");
    if (!code || courses.has(code)) {
      continue;
    }

    courses.set(code, {
      code,
      title: code,
      url: baseUrl
    });
  }

  return Array.from(courses.values()).sort((left, right) => left.title.localeCompare(right.title));
}

function pickForm(forms, predicate, fallbackMessage) {
  const form = forms.find(predicate);
  if (!form) {
    throw new Error(fallbackMessage);
  }
  return form;
}

function formToUrlEncoded(form, overrides) {
  const body = new URLSearchParams();
  form.inputs.forEach((input) => {
    if (input.type === "file") {
      return;
    }
    if (input.type === "submit" && overrides[input.name] == null) {
      return;
    }
    body.set(input.name, overrides[input.name] ?? input.value ?? "");
  });

  Object.entries(overrides).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    body.set(key, value);
  });

  return body;
}

function formToMultipart(form, overrides, fileName, buffer) {
  const body = new FormData();
  form.inputs.forEach((input) => {
    if (input.type === "file") {
      return;
    }
    if (input.type === "submit" && overrides[input.name] == null) {
      return;
    }
    body.set(input.name, overrides[input.name] ?? input.value ?? "");
  });

  Object.entries(overrides).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    body.set(key, value);
  });

  body.set(form.fileInputName, new File([buffer], fileName, { type: "application/zip" }));
  return body;
}

function createCookieJar() {
  const jar = new Map();

  return {
    addFromResponse(response) {
      const cookies = typeof response.headers.getSetCookie === "function"
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
  const path = trimText(profile.uploadPagePath || "/main/newscorm/lp_controller.php?action=import");
  const url = new URL(path, `${base}/`);
  if (profile.courseCode && !url.searchParams.has("cidReq")) {
    url.searchParams.set("cidReq", profile.courseCode);
  }
  return url.toString();
}

function buildLoginUrl(profile) {
  const base = trimText(profile.baseUrl).replace(/\/$/, "");
  return new URL(trimText(profile.loginPath || "/index.php"), `${base}/`).toString();
}

function buildRequestHeaders(cookieJar) {
  const cookie = cookieJar.header();
  return cookie ? { Cookie: cookie } : {};
}

async function fetchDashboard(normalized, cookieJar) {
  const dashboardUrl = new URL("/userportal.php", `${normalized.baseUrl}/`).toString();
  const dashboardResponse = await fetch(dashboardUrl, {
    headers: buildRequestHeaders(cookieJar),
    redirect: "manual"
  });
  cookieJar.addFromResponse(dashboardResponse);
  const dashboardHtml = await dashboardResponse.text();
  const courses = parseCoursesFromHtml(dashboardHtml, dashboardResponse.url || dashboardUrl);

  return {
    dashboardUrl,
    dashboardResponse,
    dashboardHtml,
    courses
  };
}

async function fetchCourseCatalog(normalized, cookieJar) {
  const candidateUrls = [
    new URL("/main/auth/courses.php?action=subscribe", `${normalized.baseUrl}/`).toString(),
    new URL("/main/auth/courses.php", `${normalized.baseUrl}/`).toString(),
    new URL("/main/course_info/course_home.php", `${normalized.baseUrl}/`).toString()
  ];

  const courseMap = new Map();

  for (const url of candidateUrls) {
    const response = await fetch(url, {
      headers: buildRequestHeaders(cookieJar),
      redirect: "manual"
    });
    cookieJar.addFromResponse(response);
    const html = await response.text();
    const parsedCourses = parseCoursesFromHtml(html, response.url || url);

    for (const course of parsedCourses) {
      if (!courseMap.has(course.code)) {
        courseMap.set(course.code, course);
      }
    }
  }

  return Array.from(courseMap.values()).sort((left, right) => left.title.localeCompare(right.title));
}

async function tryDirectChamiloLogin(normalized, cookieJar, loginUrl) {
  const attempts = [
    {
      login: normalized.username,
      password: normalized.password,
      submitAuth: "Login"
    },
    {
      login: normalized.username,
      password: normalized.password,
      submitAuth: "1"
    },
    {
      username: normalized.username,
      password: normalized.password,
      submitAuth: "Login"
    }
  ];

  for (const attempt of attempts) {
    const response = await fetch(loginUrl, {
      method: "POST",
      headers: {
        ...buildRequestHeaders(cookieJar),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(attempt),
      redirect: "manual"
    });
    cookieJar.addFromResponse(response);

    const dashboard = await fetchDashboard(normalized, cookieJar);
    if (dashboard.courses.length > 0 || !dashboard.dashboardHtml.includes("password")) {
      return dashboard;
    }
  }

  throw new Error("Chamilo login failed. Login form was not detected and direct login fallback did not work.");
}

export async function uploadScormToChamilo({ zipBuffer, fileName, profile }) {
  const normalized = normalizeChamiloProfile(profile);
  if (!normalized.baseUrl || !normalized.username || !normalized.password) {
    throw new Error("Chamilo base URL, username and password are required.");
  }
  if (!normalized.courseCode) {
    throw new Error("Chamilo course must be selected before publishing.");
  }

  const connection = await connectToChamilo({ profile: normalized });
  const uploadForm = connection.uploadForm;
  const cookieJar = connection.cookieJar;
  const uploadBody = formToMultipart(uploadForm, {}, fileName, zipBuffer);
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

export async function connectToChamilo({ profile }) {
  const normalized = normalizeChamiloProfile(profile);
  if (!normalized.baseUrl || !normalized.username || !normalized.password) {
    throw new Error("Chamilo base URL, username and password are required.");
  }

  const cookieJar = createCookieJar();
  const loginUrl = buildLoginUrl(normalized);
  const loginPageResponse = await fetch(loginUrl, {
    headers: buildRequestHeaders(cookieJar),
    redirect: "manual"
  });
  cookieJar.addFromResponse(loginPageResponse);
  const loginPageHtml = await loginPageResponse.text();
  const loginForms = parseForms(loginPageHtml, loginPageResponse.url || loginUrl);
  const loginForm = loginForms.find((form) => form.hasPassword);
  let dashboardResult;

  if (loginForm) {
    const loginName = loginForm.inputs.find((input) => ["login", "username", "user", "email"].includes(input.name.toLowerCase()))?.name ?? "login";
    const passwordName = loginForm.inputs.find((input) => input.type === "password")?.name ?? "password";
    const loginBody = formToUrlEncoded(loginForm, {
      [loginName]: normalized.username,
      [passwordName]: normalized.password
    });

    const loginResponse = await fetch(loginForm.action, {
      method: loginForm.method,
      headers: {
        ...buildRequestHeaders(cookieJar),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: loginBody,
      redirect: "manual"
    });
    cookieJar.addFromResponse(loginResponse);
    dashboardResult = await fetchDashboard(normalized, cookieJar);
  } else {
    dashboardResult = await tryDirectChamiloLogin(normalized, cookieJar, loginUrl);
  }

  let courses = dashboardResult.courses;
  if (courses.length === 0) {
    courses = await fetchCourseCatalog(normalized, cookieJar);
  }

  if (!normalized.courseCode) {
    return {
      ok: true,
      profile: normalized,
      cookieJar,
      loginUrl,
      uploadUrl: "",
      uploadForm: null,
      uploadPageTitle: "",
      courses
    };
  }

  const uploadPageUrl = buildUploadUrl(normalized);
  const uploadPageResponse = await fetch(uploadPageUrl, {
    headers: buildRequestHeaders(cookieJar),
    redirect: "manual"
  });
  cookieJar.addFromResponse(uploadPageResponse);
  const uploadPageHtml = await uploadPageResponse.text();
  const uploadForms = parseForms(uploadPageHtml, uploadPageResponse.url || uploadPageUrl);
  const uploadForm = pickForm(
    uploadForms,
    (form) => form.hasFileInput,
    "Chamilo SCORM upload form with file input was not found."
  );

  return {
    ok: true,
    profile: normalized,
    cookieJar,
    loginUrl,
    uploadUrl: uploadPageUrl,
    uploadForm,
    uploadPageTitle: uploadPageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "",
    courses
  };
}
