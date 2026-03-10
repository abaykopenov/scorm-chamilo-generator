function trimText(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

export function normalizeChamiloProfile(profile) {
    const baseUrl = trimText(profile?.baseUrl).replace(/\/$/, "");
    const uploadPagePath = trimText(profile?.uploadPagePath || "/main/newscorm/lp_controller.php?action=upload") || "/main/newscorm/lp_controller.php?action=upload";
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
    return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function resolveUrl(baseUrl, maybeRelative) {
    return new URL(maybeRelative || "", baseUrl).toString();
}

function buildChamiloUrl(baseUrl, maybePath) {
    const base = `${baseUrl || ""}`.trim().replace(/\/$/, "");
    const input = `${maybePath || ""}`.trim();
    if (!base) {
        return input;
    }
    if (!input) {
        return `${base}/`;
    }
    if (/^https?:\/\//i.test(input)) {
        return input;
    }
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    const normalizedPath = input.replace(/^\/+/, "");
    return new URL(normalizedPath, normalizedBase).toString();
}

function decodeMaybeEncodedUrl(value) {
    let current = `${value || ""}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const decoded = decodeURIComponent(current);
            if (decoded === current) {
                break;
            }
            current = decoded;
        } catch {
            break;
        }
    }
    return current;
}

function parseInputs(formHtml) {
    const inputs = [];
    const inputRegex = /<input\b([^>]*)>/gi;
    let inputMatch;
    while (inputMatch = inputRegex.exec(formHtml)) {
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
    while (textAreaMatch = textAreaRegex.exec(formHtml)) {
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
    while (match = selectRegex.exec(formHtml)) {
        const attrs = match[1] ?? "";
        const inner = match[2] ?? "";
        const name = getAttr(attrs, "name");
        if (!name) {
            continue;
        }
        const optionMatch = inner.match(/<option\b[^>]*selected[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || inner.match(/<option\b[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        inputs.push({
            tagName: "select",
            name,
            type: "select",
            value: stripQuotes(optionMatch?.[1] ?? "")
        });
    }
    return inputs;
}

function looksLikeFileField(input) {
    const type = String(input?.type || "").toLowerCase();
    if (type === "file") {
        return true;
    }
    if (type && ![ "text", "hidden" ].includes(type)) {
        return false;
    }
    const name = String(input?.name || "").toLowerCase();
    if (!name) {
        return false;
    }
    if (/(password|login|username|token|csrf|session)/.test(name)) {
        return false;
    }
 /* Some Chamilo pages omit type="file" in custom upload widgets, so keep a tight fallback by name. */    if (/\b(user_?file|file_upload|upload_file|uploaded_file|zip_file|package_file|scorm_file)\b/.test(name)) {
        return true;
    }
    return type === "text" && /^(file|upload|user_file)$/.test(name);
}

export function parseForms(html, baseUrl) {
    const forms = [];
    const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let match;
    while (match = formRegex.exec(html)) {
        const attrs = match[1] ?? "";
        const body = match[2] ?? "";
        const inputs = parseInputs(body);
        const action = resolveUrl(baseUrl, decodeHtml(getAttr(attrs, "action")) || baseUrl);
        const method = (getAttr(attrs, "method") || "GET").toUpperCase();
        const fileInput = inputs.find((input => looksLikeFileField(input)));
        const hasPassword = inputs.some((input => input.type === "password"));
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

function isLikelyCourseCode(value) {
    const normalized = String(value ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{2,64}$/.test(normalized)) {
        return false;
    }
    const blacklist = new Set([ "true", "false", "null", "undefined", "none", "course", "courses", "home", "index", "profile", "upload", "import", "list", "edit", "delete" ]);
    return !blacklist.has(normalized.toLowerCase());
}

function extractCourseCode(rawValue, baseUrl) {
    const raw = decodeMaybeEncodedUrl(stripQuotes(String(rawValue ?? ""))).trim();
    if (!raw) {
        return "";
    }
    const directMatch = raw.match(/^[A-Za-z0-9_.-]{2,64}$/);
    if (directMatch) {
        return directMatch[0];
    }
    try {
        const resolved = new URL(raw, baseUrl);
        const paramCode = resolved.searchParams.get("cidReq") || resolved.searchParams.get("course_code") || resolved.searchParams.get("code");
        if (paramCode && isLikelyCourseCode(paramCode)) {
            return paramCode;
        }
        const pathCode = resolved.pathname.match(/\/courses\/([^/?#]+)/i)?.[1];
        if (pathCode && isLikelyCourseCode(pathCode)) {
            return pathCode;
        }
    } catch {/* ignore invalid URL, continue with regex parsing */}
    const inlineMatch = raw.match(/[?&](?:cidReq|course_code|code)=([^&]+)/i);
    if (inlineMatch?.[1]) {
        const decoded = decodeMaybeEncodedUrl(inlineMatch[1]);
        if (isLikelyCourseCode(decoded)) {
            return decoded;
        }
    }
    const pathInlineMatch = raw.match(/\/courses\/([^/?#]+)/i);
    if (pathInlineMatch?.[1] && isLikelyCourseCode(pathInlineMatch[1])) {
        return pathInlineMatch[1];
    }
    return "";
}

function upsertCourse(courses, code, title, url, baseUrl) {
    const normalizedCode = String(code ?? "").trim();
    if (!isLikelyCourseCode(normalizedCode)) {
        return;
    }
    const normalizedTitle = decodeHtml(String(title ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || normalizedCode;
    if (!courses.has(normalizedCode)) {
        courses.set(normalizedCode, {
            code: normalizedCode,
            title: normalizedTitle,
            url: url || baseUrl
        });
    }
}

function isLikelyCourseTitle(value) {
    const normalized = decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (normalized.length < 2) {
        return false;
    }
    const blacklist = new Set([ "import", "upload", "delete", "edit", "profile", "dashboard", "settings", "home", "next", "previous" ]);
    return !blacklist.has(normalized.toLowerCase());
}

function isCourseRelatedPath(pathname) {
    return /\/(?:main\/)?(?:course_home|course_info|auth\/courses\.php|newscorm|lp|learnpath|myspace|session\/\d+\/course)/i.test(pathname) || /\/courses\/[^/?#]+/i.test(pathname);
}

function isLikelyCourseHref(href, baseUrl, depth = 0) {
    const decodedHref = decodeMaybeEncodedUrl(String(href ?? ""));
    if (!decodedHref || /^javascript:/i.test(decodedHref)) {
        return false;
    }
    if (/(?:cidReq|course_code|code)=/i.test(decodedHref) && /(course_home|course_info|courses\.php|newscorm|lp_controller|learnpath|myspace|session\/\d+\/course)/i.test(decodedHref)) {
        return true;
    }
    try {
        const resolved = new URL(decodedHref, baseUrl);
        const hasCourseParam = Boolean(resolved.searchParams.get("cidReq") || resolved.searchParams.get("course_code") || resolved.searchParams.get("code"));
        if (hasCourseParam && isCourseRelatedPath(resolved.pathname)) {
            return true;
        }
        if (/\/courses\/[^/?#]+/i.test(resolved.pathname)) {
            return true;
        }
        if (depth < 1) {
            for (const paramName of [ "next", "url", "target", "redirect", "return_to" ]) {
                const nested = resolved.searchParams.get(paramName);
                if (nested && isLikelyCourseHref(nested, baseUrl, depth + 1)) {
                    return true;
                }
            }
        }
    } catch {
        return false;
    }
    return false;
}

function isLikelyCourseSelect(attrs) {
    const marker = [ getAttr(attrs, "name"), getAttr(attrs, "id"), getAttr(attrs, "class"), getAttr(attrs, "data-role"), getAttr(attrs, "data-purpose") ].filter(Boolean).join(" ").toLowerCase();
    if (!marker) {
        return false;
    }
    if (!/(course|cidreq|course_code|coursecode|training)/.test(marker)) {
        return false;
    }
    if (/(lang|language|theme|timezone|currency|country)/.test(marker)) {
        return false;
    }
    return true;
}

function isLikelyCourseContainer(attrs) {
    const marker = [ getAttr(attrs, "class"), getAttr(attrs, "id"), getAttr(attrs, "data-role"), getAttr(attrs, "data-purpose") ].filter(Boolean).join(" ").toLowerCase();
    return /(course|my-course|course-card|course-item|course-list)/.test(marker);
}

export function parseCoursesFromHtml(html, baseUrl) {
    const courses = new Map;
    const htmlText = String(html ?? "");
    const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while (match = anchorRegex.exec(htmlText)) {
        const attrs = match[1] ?? "";
        const href = getAttr(attrs, "href");
        const dataCidReq = getAttr(attrs, "data-cidreq");
        const dataCode = getAttr(attrs, "data-code");
        const dataCourseCode = getAttr(attrs, "data-course-code");
        const dataCourseCodeAlt = getAttr(attrs, "data-coursecode");
        const code = extractCourseCode(dataCidReq || dataCode || dataCourseCode || dataCourseCodeAlt || href, baseUrl);
        if (!code) {
            continue;
        }
        const hasCourseData = Boolean(dataCidReq || dataCode || dataCourseCode || dataCourseCodeAlt);
        if (!hasCourseData && !isLikelyCourseHref(href, baseUrl)) {
            continue;
        }
        const resolved = href ? resolveUrl(baseUrl, decodeMaybeEncodedUrl(href)) : baseUrl;
        const title = match[2];
        if (!hasCourseData && !isLikelyCourseTitle(title)) {
            continue;
        }
        upsertCourse(courses, code, title, resolved, baseUrl);
    }
    const containerRegex = /<(?:div|article|li|tr)\b([^>]*)>/gi;
    let containerMatch;
    while (containerMatch = containerRegex.exec(htmlText)) {
        const attrs = containerMatch[1] ?? "";
        if (!isLikelyCourseContainer(attrs)) {
            continue;
        }
        const code = extractCourseCode(getAttr(attrs, "data-cidreq") || getAttr(attrs, "data-course-code") || getAttr(attrs, "data-coursecode") || getAttr(attrs, "data-code") || getAttr(attrs, "data-course"), baseUrl);
        if (!code) {
            continue;
        }
        const title = getAttr(attrs, "data-title") || getAttr(attrs, "title") || code;
        upsertCourse(courses, code, title, baseUrl, baseUrl);
    }
    const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let selectMatch;
    while (selectMatch = selectRegex.exec(htmlText)) {
        const selectAttrs = selectMatch[1] ?? "";
        if (!isLikelyCourseSelect(selectAttrs)) {
            continue;
        }
        const optionsHtml = selectMatch[2] ?? "";
        const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
        let optionMatch;
        while (optionMatch = optionRegex.exec(optionsHtml)) {
            const optionAttrs = optionMatch[1] ?? "";
            const code = extractCourseCode(getAttr(optionAttrs, "data-cidreq") || getAttr(optionAttrs, "data-code") || getAttr(optionAttrs, "value"), baseUrl);
            if (!code) {
                continue;
            }
            upsertCourse(courses, code, optionMatch[2], baseUrl, baseUrl);
        }
    }
    const decodedHtml = decodeHtml(decodeMaybeEncodedUrl(htmlText));
    const courseObjectRegexes = [ /"(?:cidReq|course_code|code)"\s*:\s*"([A-Za-z0-9_.-]{2,64})"[\s\S]{0,220}?"(?:title|name|course_title)"\s*:\s*"([^"]{2,180})"/gi, /"(?:title|name|course_title)"\s*:\s*"([^"]{2,180})"[\s\S]{0,220}?"(?:cidReq|course_code|code)"\s*:\s*"([A-Za-z0-9_.-]{2,64})"/gi ];
    for (const regex of courseObjectRegexes) {
        let objectMatch;
        while (objectMatch = regex.exec(decodedHtml)) {
            if (regex === courseObjectRegexes[0]) {
                upsertCourse(courses, objectMatch[1], objectMatch[2], baseUrl, baseUrl);
            } else {
                upsertCourse(courses, objectMatch[2], objectMatch[1], baseUrl, baseUrl);
            }
        }
    }
    return Array.from(courses.values()).sort(((left, right) => left.title.localeCompare(right.title)));
}

function pickForm(forms, predicate, fallbackMessage) {
    const form = forms.find(predicate);
    if (!form) {
        throw new Error(fallbackMessage);
    }
    return form;
}

function buildSubmitOverrides(form) {
    const submitInput = form.inputs.find((input => input.type === "submit" && input.name));
    if (!submitInput) {
        return {};
    }
    return {
        [submitInput.name]: submitInput.value || "1"
    };
}

function isRedirectStatus(status) {
    return status >= 300 && status < 400;
}

async function fetchWithRedirectChain({url, method = "GET", headers = {}, body, cookieJar, maxRedirects = 5}) {
    const history = [];
    let currentUrl = url;
    let currentMethod = method.toUpperCase();
    let currentBody = body;
    let response = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        response = await fetch(currentUrl, {
            method: currentMethod,
            headers,
            body: currentBody,
            redirect: "manual"
        });
        cookieJar.addFromResponse(response);
        history.push({
            status: response.status,
            url: response.url || currentUrl,
            location: response.headers.get("location") || ""
        });
        if (!isRedirectStatus(response.status)) {
            break;
        }
        const location = response.headers.get("location");
        if (!location) {
            break;
        }
        currentUrl = resolveUrl(response.url || currentUrl, location);
 /* Browser-like behavior for POST redirects */        if ((response.status === 301 || response.status === 302 || response.status === 303) && currentMethod !== "GET") {
            currentMethod = "GET";
            currentBody = undefined;
        }
        if (response.status === 307 || response.status === 308) {
            /* Cannot safely replay multipart body in this flow. */ break;
        }
    }
    return {
        response,
        history
    };
}

function hasLoginForm(html) {
    const text = String(html || "").toLowerCase();
    return /<input\b[^>]*type\s*=\s*["']password["']/i.test(text) && (text.includes('name="login"') || text.includes('name="username"') || text.includes("submitauth"));
}

function isStrictUploadConfirmationEnabled() {
    const value = String(process.env.CHAMILO_UPLOAD_STRICT_CONFIRMATION || "").toLowerCase();
    if (!value) {
        return true;
    }
    return !(value === "0" || value === "false" || value === "no" || value === "off" || value === "compat");
}

function extractLpIdFromUrl(value) {
    const source = String(value || "");
    if (!source) {
        return "";
    }
    try {
        const parsed = new URL(source, "http://localhost/");
        const fromParams = parsed.searchParams.get("lp_id") || parsed.searchParams.get("learnpath_id") || "";
        if (/^\d+$/.test(fromParams)) {
            return fromParams;
        }
    } catch {
        /* ignore malformed URLs */
    }
    const inline = source.match(/(?:[?&]|\/)(?:lp_id|learnpath_id)=(\d+)/i)?.[1] || "";
    return /^\d+$/.test(inline) ? inline : "";
}

function extractLpIdFromUploadResult({responseUrl, redirectHistory, responseSnippet}) {
    const candidates = [
        responseUrl,
        ...((Array.isArray(redirectHistory) ? redirectHistory : []).flatMap((hop) => [ hop?.url, hop?.location ])),
        String(responseSnippet || "")
    ];
    for (const candidate of candidates) {
        const id = extractLpIdFromUrl(candidate);
        if (id) {
            return id;
        }
        const fromBody = String(candidate || "").match(/(?:lp_id|learnpath_id)\s*=\s*["']?(\d+)/i)?.[1] || "";
        if (/^\d+$/.test(fromBody)) {
            return fromBody;
        }
    }
    return "";
}

function detectUploadOutcome({status, finalUrl, bodyText, history}) {
    const rawText = String(bodyText || "");
    const text = decodeHtml(rawText);
    const lower = text.toLowerCase();
    const lastHop = history.at(-1);
    const strict = isStrictUploadConfirmationEnabled();
    if (status >= 400) {
        return {
            ok: false,
            message: `Chamilo returned HTTP ${status} on upload.`
        };
    }
    if (isRedirectStatus(status)) {
        return {
            ok: false,
            message: `Chamilo returned unresolved redirect (${status}) during upload.`
        };
    }
    if (hasLoginForm(text) || /\/(index\.php|login|auth)\b/i.test(String(finalUrl || ""))) {
        return {
            ok: false,
            message: "Chamilo returned login page after upload. Session/auth was not accepted."
        };
    }
    const failurePatterns = [ /upload failed/i, /failed to upload/i, /fatal error/i, /exception/i, /not allowed/i, /forbidden/i, /invalid file/i, /file is too large/i, /scorm.*error/i, /import.*error/i, /\berror\b/i ];
    if (failurePatterns.some((pattern => pattern.test(lower)))) {
        return {
            ok: false,
            message: "Chamilo reported an upload/import error."
        };
    }
    const successPatterns = [ /imported successfully/i, /has been imported/i, /uploaded successfully/i, /learnpath has been created/i, /learning path has been imported/i, /lp_controller\.php\?action=(list|view|build|home|edit)/i, /\u0443\u0441\u043f\u0435\u0448\u043d\u043e\s+\u0438\u043c\u043f\u043e\u0440\u0442/i, /\u0443\u0441\u043f\u0435\u0448\u043d\u043e\s+\u0437\u0430\u0433\u0440\u0443\u0436/i, /\u0438\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u043d\s+\u0443\u0441\u043f\u0435\u0448\u043d\u043e/i ];
    if (successPatterns.some((pattern => pattern.test(lower)))) {
        return {
            ok: true,
            message: "SCORM upload/import is confirmed by Chamilo response."
        };
    }
    const responseForms = parseForms(rawText, finalUrl || lastHop?.url || "http://localhost/");
    if (responseForms.some((form => form.hasFileInput))) {
        if (!strict) {
            return {
                ok: true,
                message: "Chamilo returned the upload form again; treating as success in compatibility mode."
            };
        }
        return {
            ok: false,
            message: "Upload form is still displayed; SCORM import was not completed."
        };
    }
    const pendingPatterns = [ /scorm or aicc files for upload/i, /upload.*scorm/i, /file is uploaded/i, /\u0444\u0430\u0439\u043b\s+\u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044f/i ];
    if (pendingPatterns.some((pattern => pattern.test(lower)))) {
        if (!strict) {
            return {
                ok: true,
                message: "Chamilo is processing/uploading the SCORM package; treating as success in compatibility mode."
            };
        }
        return {
            ok: false,
            message: "Chamilo is still on upload page; no final import confirmation."
        };
    }
    if (/lp_controller|newscorm|learnpath|scorm|upload\/index\.php/i.test(String(lastHop?.url || finalUrl || "")) && !hasLoginForm(text)) {
        if (!strict) {
            return {
                ok: true,
                message: "Reached Chamilo SCORM area without explicit marker; treating upload as successful in compatibility mode."
            };
        }
        return {
            ok: false,
            message: "Reached Chamilo SCORM area, but explicit import success marker was not found."
        };
    }
    return {
        ok: false,
        message: "Chamilo did not confirm SCORM import in response page."
    };
}

function findFollowupImportForm(html, baseUrl) {
    const forms = parseForms(html, baseUrl);
    return forms.find((form => {
        if (form.hasFileInput) {
            return false;
        }
        const actionLooksRight = /newscorm|lp_controller|learnpath|scorm/i.test(form.action);
        if (!actionLooksRight || form.method !== "POST") {
            return false;
        }
        const hasSubmit = form.inputs.some((input => input.type === "submit" || /submit|import|upload|add/i.test(input.name)));
        const hasUsefulFields = form.inputs.some((input => input.type === "hidden" || input.type === "text" || input.type === "select"));
        return hasSubmit && hasUsefulFields;
    })) || null;
}

function formToUrlEncoded(form, overrides) {
    const body = new URLSearchParams;
    form.inputs.forEach((input => {
        if (input.type === "file") {
            return;
        }
        if (input.type === "submit" && overrides[input.name] == null) {
            return;
        }
        body.set(input.name, overrides[input.name] ?? input.value ?? "");
    }));
    Object.entries(overrides).forEach((([key, value]) => {
        if (value == null) {
            return;
        }
        body.set(key, value);
    }));
    return body;
}

function formToMultipart(form, overrides, fileName, buffer) {
    const body = new FormData;
    form.inputs.forEach((input => {
        if (input.type === "file") {
            return;
        }
        if (input.type === "submit" && overrides[input.name] == null) {
            return;
        }
        body.set(input.name, overrides[input.name] ?? input.value ?? "");
    }));
    Object.entries(overrides).forEach((([key, value]) => {
        if (value == null) {
            return;
        }
        body.set(key, value);
    }));
    body.set(form.fileInputName, new File([ buffer ], fileName, {
        type: "application/zip"
    }));
    return body;
}

function createCookieJar() {
    const jar = new Map;
    return {
        addFromResponse(response) {
            const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
            cookies.forEach((cookie => {
                const firstPart = cookie.split(";")[0];
                const separatorIndex = firstPart.indexOf("=");
                if (separatorIndex > 0) {
                    jar.set(firstPart.slice(0, separatorIndex), firstPart.slice(separatorIndex + 1));
                }
            }));
        },
        header() {
            return Array.from(jar.entries()).map((([key, value]) => `${key}=${value}`)).join("; ");
        }
    };
}

function buildUploadUrl(profile) {
    const base = trimText(profile.baseUrl).replace(/\/$/, "");
    const path = trimText(profile.uploadPagePath || "/main/newscorm/lp_controller.php?action=upload");
    const url = new URL(buildChamiloUrl(base, path));
    if (profile.courseCode && !url.searchParams.has("cidReq")) {
        url.searchParams.set("cidReq", profile.courseCode);
    }
    return url.toString();
}

function buildUploadCandidateUrls(profile, courses) {
    const candidates = [ buildUploadUrl(profile), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=upload"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=import"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=add_lp"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_upload.php"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=upload"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=import"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=add_lp"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_upload.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/upload.scorm.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/upload.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/index.php?tool=learnpath&curdirpath=%2F"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/upload.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/") ];
    if (profile.courseCode) {
        for (const candidate of [ ...candidates ]) {
            try {
                const url = new URL(candidate);
                if (!url.searchParams.has("cidReq")) {
                    url.searchParams.set("cidReq", profile.courseCode);
                }
                candidates.push(url.toString());
            } catch {/* ignore malformed candidate URL */}
        }
        candidates.push(buildChamiloUrl(profile.baseUrl, "/course_home/course_home.php?cidReq=" + encodeURIComponent(profile.courseCode)));
    }
    const selectedCourse = Array.isArray(courses) ? courses.find((course => String(course?.code ?? "").trim() === profile.courseCode)) : null;
    if (selectedCourse?.url) {
        candidates.push(selectedCourse.url);
    }
    return Array.from(new Set(candidates.filter(Boolean)));
}

function createSyntheticUploadForm(action, courseCode, fileInputName = "user_file") {
    const inputs = [];
    if (courseCode) {
        inputs.push({
            tagName: "input",
            name: "cidReq",
            type: "hidden",
            value: courseCode
        });
    }
    try {
        const parsed = new URL(action);
        const tool = parsed.searchParams.get("tool");
        const curdirpath = parsed.searchParams.get("curdirpath");
        if (tool) {
            inputs.push({
                tagName: "input",
                name: "tool",
                type: "hidden",
                value: tool
            });
        } else if (/\/main\/upload\/index\.php$/i.test(parsed.pathname)) {
            inputs.push({
                tagName: "input",
                name: "tool",
                type: "hidden",
                value: "learnpath"
            });
        }
        if (curdirpath) {
            inputs.push({
                tagName: "input",
                name: "curdirpath",
                type: "hidden",
                value: curdirpath
            });
        }
    } catch {/* ignore malformed URL */}
    return {
        action,
        method: "POST",
        inputs,
        html: "",
        hasPassword: false,
        hasFileInput: true,
        fileInputName
    };
}

function buildDirectUploadForms(profile) {
    const baseUrls = [ buildUploadUrl(profile), buildChamiloUrl(profile.baseUrl, "/main/upload/upload.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/index.php?tool=learnpath&curdirpath=%2F"), buildChamiloUrl(profile.baseUrl, "/main/upload/upload.scorm.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_upload.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/upload.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=upload"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=import"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=upload") ].filter(Boolean);
    const uniqueUrls = Array.from(new Set(baseUrls));
    const fieldNames = [ "user_file" ];
    const forms = [];
    for (const url of uniqueUrls) {
        for (const fieldName of fieldNames) {
            forms.push(createSyntheticUploadForm(url, profile.courseCode, fieldName));
        }
    }
    return forms;
}

function extractLikelyUploadLinks(html, pageUrl, courseCode) {
    const links = [];
    const anchorRegex = /<a\b([^>]*)>/gi;
    let match;
    while (match = anchorRegex.exec(String(html ?? ""))) {
        const attrs = match[1] ?? "";
        const href = decodeMaybeEncodedUrl(getAttr(attrs, "href"));
        if (!href) {
            continue;
        }
        if (!/(newscorm|scorm|lp_controller|learnpath|import|upload\.php|upload\/index\.php|tool=learnpath|curdirpath)/i.test(href)) {
            continue;
        }
        let resolved;
        try {
            resolved = resolveUrl(pageUrl, href);
        } catch {
            continue;
        }
        if (courseCode) {
            const linkCourseCode = extractCourseCode(resolved, pageUrl);
            if (linkCourseCode && linkCourseCode !== courseCode) {
                continue;
            }
        }
        links.push(resolved);
    }
    return Array.from(new Set(links)).slice(0, 25);
}

function extractPageTitle(html) {
    return String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
}

function isLikelyScormUploadAction(actionUrl) {
    const raw = String(actionUrl || "").trim();
    if (!raw) {
        return false;
    }
    try {
        const parsed = new URL(raw);
        const path = parsed.pathname.toLowerCase();
        const action = (parsed.searchParams.get("action") || "").toLowerCase();
        const tool = (parsed.searchParams.get("tool") || "").toLowerCase();
        if (/\/main\/(newscorm|lp)\/lp_upload\.php$/.test(path)) {
            return true;
        }
        if (/\/main\/upload\/upload\.scorm\.php$/.test(path)) {
            return true;
        }
        if (/\/main\/(newscorm|lp)\/lp_controller\.php$/.test(path)) {
            return action === "upload" || action === "import" || action === "add_lp" || action === "";
        }
        if (/\/main\/upload\/upload\.php$/.test(path)) {
            return /scorm|learnpath|lp/.test(tool) || /scorm|learnpath|lp/.test(action);
        }
        return /newscorm|lp_upload|learnpath|scorm/.test(path) && !/\/main\/upload\/upload\.php$/.test(path);
    } catch {
        return /lp_controller\.php.*action=(upload|import|add_lp)|lp_upload\.php|upload\.scorm\.php/i.test(raw);
    }
}

function hasScormUploadHints(form) {
    if (!form?.hasFileInput) {
        return false;
    }
    const fileName = String(form.fileInputName || "").toLowerCase();
    const looksLikeUploadInput = /file|upload|package|zip|user_file/.test(fileName);
    if (!looksLikeUploadInput) {
        return false;
    }
    const joined = [ String(form.action || ""), ...form.inputs.map((input => `${input?.name || ""}=${input?.value || ""}`)) ].join(" ").toLowerCase();
    const topicHint = /newscorm|learnpath|lp_controller|lp_upload|scorm|imsmanifest/.test(joined);
    if (topicHint) {
        return true;
    }
    const hasCourseHint = /cidreq|course|curdirpath|curdirpathurl|lp_id|learnpath_id|newscorm/.test(joined);
    const hasSubmitHint = form.inputs.some((input => input?.type === "submit" || /import|upload|send|submit|save/i.test(input?.name || "")));
    return hasCourseHint && hasSubmitHint;
}

function isLikelyScormStepForm(form) {
    if (!form || form.hasFileInput) {
        return false;
    }
    const action = String(form.action || "").toLowerCase();
    if (!/(newscorm|lp_controller|learnpath|scorm|lp_upload|upload\.php)/.test(action)) {
        return false;
    }
    const joined = [ action, ...form.inputs.map((input => `${input?.name || ""}=${input?.value || ""}`)) ].join(" ").toLowerCase();
    const hasHints = /upload|import|add_lp|newscorm|learnpath|scorm|cidreq|lp_id|curdirpath/.test(joined);
    if (!hasHints) {
        return false;
    }
    const hasSubmit = form.inputs.some((input => input.type === "submit" || /submit|import|upload|add|next|continue|save/i.test(input.name)));
    return hasSubmit || form.method === "GET";
}

async function submitScormStepForm(form, cookieJar) {
    const method = (form.method || "GET").toUpperCase();
    const overrides = {
        ...buildSubmitOverrides(form)
    };
    if (method === "GET") {
        const params = formToUrlEncoded(form, overrides);
        const target = new URL(form.action);
        params.forEach(((value, key) => {
            if (value !== "") {
                target.searchParams.set(key, value);
            }
        }));
        return fetchWithRedirectChain({
            url: target.toString(),
            method: "GET",
            headers: buildRequestHeaders(cookieJar),
            cookieJar,
            maxRedirects: 6
        });
    }
    const body = formToUrlEncoded(form, overrides);
    return fetchWithRedirectChain({
        url: form.action,
        method,
        headers: {
            ...buildRequestHeaders(cookieJar),
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body,
        cookieJar,
        maxRedirects: 6
    });
}

async function findUploadForm(normalized, cookieJar, courses) {
    const queue = buildUploadCandidateUrls(normalized, courses);
    const visited = new Set;
    const attempts = [];
    while (queue.length > 0 && attempts.length < 30) {
        const nextUrl = queue.shift();
        if (!nextUrl || visited.has(nextUrl)) {
            continue;
        }
        visited.add(nextUrl);
        let response;
        let history = [];
        try {
            const request = await fetchWithRedirectChain({
                url: nextUrl,
                method: "GET",
                headers: buildRequestHeaders(cookieJar),
                cookieJar,
                maxRedirects: 6
            });
            response = request.response;
            history = request.history;
        } catch {
            attempts.push({
                start: nextUrl,
                finalUrl: nextUrl,
                status: "network-error"
            });
            continue;
        }
        const resolvedUrl = response?.url || history.at(-1)?.url || nextUrl;
        const status = response?.status ?? 0;
        attempts.push({
            start: nextUrl,
            finalUrl: resolvedUrl,
            status
        });
        const html = await response.text();
        const forms = parseForms(html, resolvedUrl);
        const uploadForm = forms.find((form => form.hasFileInput && isLikelyScormUploadAction(form.action))) || forms.find((form => hasScormUploadHints(form)));
        if (uploadForm) {
            return {
                uploadUrl: resolvedUrl,
                uploadForm,
                uploadPageTitle: extractPageTitle(html)
            };
        }
        const stepForms = forms.filter((form => isLikelyScormStepForm(form))).slice(0, 3);
        for (const stepForm of stepForms) {
            let stepResponse;
            let stepHistory = [];
            try {
                const stepRequest = await submitScormStepForm(stepForm, cookieJar);
                stepResponse = stepRequest.response;
                stepHistory = stepRequest.history;
            } catch {
                attempts.push({
                    start: `form:${resolvedUrl}`,
                    finalUrl: stepForm.action,
                    status: "form-step-error"
                });
                continue;
            }
            const stepResolvedUrl = stepResponse?.url || stepHistory.at(-1)?.url || stepForm.action;
            const stepStatus = stepResponse?.status ?? 0;
            attempts.push({
                start: `form:${resolvedUrl}`,
                finalUrl: stepResolvedUrl,
                status: stepStatus
            });
            const stepHtml = await stepResponse.text();
            const stepParsedForms = parseForms(stepHtml, stepResolvedUrl);
            const stepUploadForm = stepParsedForms.find((form => form.hasFileInput && isLikelyScormUploadAction(form.action))) || stepParsedForms.find((form => hasScormUploadHints(form)));
            if (stepUploadForm) {
                return {
                    uploadUrl: stepResolvedUrl,
                    uploadForm: stepUploadForm,
                    uploadPageTitle: extractPageTitle(stepHtml)
                };
            }
            const stepLinks = extractLikelyUploadLinks(stepHtml, stepResolvedUrl, normalized.courseCode);
            for (const link of stepLinks) {
                if (!visited.has(link) && !queue.includes(link)) {
                    queue.push(link);
                }
            }
        }
        const nestedLinks = extractLikelyUploadLinks(html, resolvedUrl, normalized.courseCode);
        for (const link of nestedLinks) {
            if (!visited.has(link) && !queue.includes(link)) {
                queue.push(link);
            }
        }
    }
    const checkedPreview = attempts.slice(0, 8).map((attempt => {
        const prefix = attempt?.status ? `[${attempt.status}] ` : "";
        const tail = attempt?.finalUrl && attempt.finalUrl !== attempt.start ? ` -> ${attempt.finalUrl}` : "";
        return `${prefix}${attempt.start}${tail}`;
    })).join(" | ");
    throw new Error("Chamilo SCORM upload form with file input was not found. Checked: " + checkedPreview);
}

function buildLoginUrl(profile) {
    const base = trimText(profile.baseUrl).replace(/\/$/, "");
    return buildChamiloUrl(base, trimText(profile.loginPath || "/index.php"));
}

function buildRequestHeaders(cookieJar) {
    const cookie = cookieJar.header();
    return cookie ? {
        Cookie: cookie
    } : {};
}

async function fetchDashboard(normalized, cookieJar) {
    const dashboardUrl = buildChamiloUrl(normalized.baseUrl, "/userportal.php");
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
    const candidateUrls = [ buildChamiloUrl(normalized.baseUrl, "/main/auth/courses.php?action=subscribe"), buildChamiloUrl(normalized.baseUrl, "/main/auth/courses.php"), buildChamiloUrl(normalized.baseUrl, "/main/auth/my_space.php"), buildChamiloUrl(normalized.baseUrl, "/main/mySpace/index.php"), buildChamiloUrl(normalized.baseUrl, "/main/mySpace/"), buildChamiloUrl(normalized.baseUrl, "/main/course_info/course_home.php"), buildChamiloUrl(normalized.baseUrl, "/main/course_info/catalog.php"), buildChamiloUrl(normalized.baseUrl, "/main/course_info/my_course.php") ];
    const uniqueUrls = Array.from(new Set(candidateUrls));
    const courseMap = new Map;
    for (const url of uniqueUrls) {
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
    return Array.from(courseMap.values()).sort(((left, right) => left.title.localeCompare(right.title)));
}

async function fetchCoursesFromUploadPage(normalized, cookieJar) {
    try {
        const uploadUrl = buildUploadUrl({
            ...normalized,
            courseCode: ""
        });
        const response = await fetch(uploadUrl, {
            headers: buildRequestHeaders(cookieJar),
            redirect: "manual"
        });
        cookieJar.addFromResponse(response);
        const html = await response.text();
        return parseCoursesFromHtml(html, response.url || uploadUrl);
    } catch {
        return [];
    }
}

async function tryDirectChamiloLogin(normalized, cookieJar, loginUrl) {
    const attempts = [ {
        login: normalized.username,
        password: normalized.password,
        submitAuth: "Login"
    }, {
        login: normalized.username,
        password: normalized.password,
        submitAuth: "1"
    }, {
        username: normalized.username,
        password: normalized.password,
        submitAuth: "Login"
    } ];
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

async function uploadScormWithForm({uploadForm, cookieJar, fileName, zipBuffer}) {
    const multipartOverrides = {
        ...buildSubmitOverrides(uploadForm)
    };
    const uploadBody = formToMultipart(uploadForm, multipartOverrides, fileName, zipBuffer);
    const firstAttempt = await fetchWithRedirectChain({
        url: uploadForm.action,
        method: uploadForm.method,
        headers: buildRequestHeaders(cookieJar),
        body: uploadBody,
        cookieJar,
        maxRedirects: 5
    });
    const firstResponse = firstAttempt.response;
    const firstText = await firstResponse.text();
    let finalStatus = firstResponse.status;
    let finalUrl = firstResponse.url || uploadForm.action;
    let finalText = firstText;
    let finalHistory = firstAttempt.history;
    const followupForm = findFollowupImportForm(firstText, finalUrl);
    if (followupForm) {
        const followupBody = formToUrlEncoded(followupForm, {
            ...buildSubmitOverrides(followupForm)
        });
        const secondAttempt = await fetchWithRedirectChain({
            url: followupForm.action,
            method: followupForm.method,
            headers: {
                ...buildRequestHeaders(cookieJar),
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: followupBody,
            cookieJar,
            maxRedirects: 5
        });
        const secondResponse = secondAttempt.response;
        finalStatus = secondResponse.status;
        finalUrl = secondResponse.url || followupForm.action;
        finalText = await secondResponse.text();
        finalHistory = [ ...firstAttempt.history, ...secondAttempt.history ];
    }
    const outcome = detectUploadOutcome({
        status: finalStatus,
        finalUrl,
        bodyText: finalText,
        history: finalHistory
    });
    return {
        ok: outcome.ok,
        status: finalStatus,
        uploadUrl: uploadForm.action,
        responseUrl: finalUrl,
        message: outcome.message,
        redirectHistory: finalHistory,
        responseSnippet: finalText.slice(0, 700),
        lpId: extractLpIdFromUploadResult({
            responseUrl: finalUrl,
            redirectHistory: finalHistory,
            responseSnippet: finalText
        })
    };
}

export async function uploadScormToChamilo({zipBuffer, fileName, profile}) {
    const normalized = normalizeChamiloProfile(profile);
    if (!normalized.baseUrl || !normalized.username || !normalized.password) {
        throw new Error("Chamilo base URL, username and password are required.");
    }
    if (!normalized.courseCode) {
        throw new Error("Chamilo course must be selected before publishing.");
    }
    const connection = await connectToChamilo({
        profile: normalized
    });
    const cookieJar = connection.cookieJar;
    const candidates = [];
    const seen = new Set;
    const register = form => {
        if (!form?.action || !form?.fileInputName) {
            return;
        }
        const key = `${form.action}|${form.fileInputName}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push(form);
    };
    register(connection.uploadForm);
    if (candidates.length === 0) {
        for (const fallbackForm of buildDirectUploadForms(normalized)) {
            register(fallbackForm);
        }
    }
    let lastResult = null;
    const attemptErrors = [];
    const maxUploadAttempts = 1;
    let attemptCount = 0;
    for (const candidateForm of candidates.slice(0, maxUploadAttempts)) {
        attemptCount += 1;
        try {
            const result = await uploadScormWithForm({
                uploadForm: candidateForm,
                cookieJar,
                fileName,
                zipBuffer
            });
            if (result.ok) {
                return {
                    ...result,
                    attemptCount
                };
            }
            lastResult = result;
            attemptErrors.push(`[${result.status}] ${candidateForm.action} (${candidateForm.fileInputName}) -> ${result.message}`);
            if (result.status > 0 && result.status < 500) {
                return {
                    ...result,
                    attemptCount,
                    message: `${result.message} Upload stopped after first HTTP attempt to avoid duplicate imports.`
                };
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : "unknown upload error";
            attemptErrors.push(`[request-error] ${candidateForm.action} (${candidateForm.fileInputName}) -> ${reason}`);
        }
    }
    if (lastResult) {
        return {
            ...lastResult,
            attemptCount,
            message: `${lastResult.message} Attempts: ${attemptErrors.join(" | ")}`
        };
    }
    const fallbackUrl = connection.uploadUrl || buildUploadUrl(normalized);
    return {
        ok: false,
        status: 0,
        attemptCount,
        uploadUrl: fallbackUrl,
        responseUrl: fallbackUrl,
        message: `Chamilo upload failed before HTTP response. Attempts: ${attemptErrors.join(" | ")}`,
        redirectHistory: [],
        responseSnippet: ""
    };
}

function extractProtectToken(html) {
    const source = String(html || "");
    const direct = source.match(/name=["']protect_token["'][^>]*value=["']([^"']*)["']/i);
    if (direct?.[1]) {
        return decodeHtml(direct[1]);
    }
    const reverse = source.match(/value=["']([^"']*)["'][^>]*name=["']protect_token["']/i);
    return decodeHtml(reverse?.[1] || "");
}

function extractExerciseIdFromResponse(locationHeader, htmlBody) {
    const fromLocation = String(locationHeader || "").match(/exerciseId=(\d+)/i)?.[1];
    if (fromLocation) {
        return fromLocation;
    }
    return String(htmlBody || "").match(/exerciseId=(\d+)/i)?.[1] || "";
}

function normalizeExerciseQuestion(question, questionIndex) {
    const prompt = trimText(question?.prompt || question?.text || `Question ${questionIndex + 1}`);
    const sourceOptions = Array.isArray(question?.options) ? question.options : [];
    const options = sourceOptions.map(((option, optionIndex) => {
        const text = typeof option === "string" ? trimText(option) : trimText(option?.text || option?.label || option?.value || "");
        return {
            id: trimText(typeof option === "object" ? option?.id || `${optionIndex + 1}` : `${optionIndex + 1}`),
            text: text || `Option ${optionIndex + 1}`
        };
    })).filter((option => option.text)).slice(0, 12);
    while (options.length < 2) {
        options.push({
            id: `fallback_${questionIndex}_${options.length + 1}`,
            text: `Option ${options.length + 1}`
        });
    }
    const requestedCorrectId = trimText(question?.correctOptionId);
    const numericCorrect = Number.isFinite(Number(question?.correctIndex)) ? Math.trunc(Number(question?.correctIndex)) : -1;
    let correctIndex = numericCorrect >= 0 && numericCorrect < options.length ? numericCorrect : -1;
    if (correctIndex < 0) {
        const byId = options.findIndex((option => option.id === requestedCorrectId));
        correctIndex = byId >= 0 ? byId : 0;
    }
    return {
        prompt: prompt || `Question ${questionIndex + 1}`,
        options,
        correctIndex
    };
}

function buildExerciseCreateRequestBody({
    title,
    attemptsLimit = 3,
    passPercentage = 80,
    protectToken = ""
}) {
    const bodyParts = [];
    bodyParts.push(`exerciseTitle=${encodeURIComponent(trimText(title) || "New test")}`);
    bodyParts.push(`exerciseAttempts=${encodeURIComponent(String(Math.max(1, Math.trunc(Number(attemptsLimit) || 1))))}`);
    bodyParts.push(`pass_percentage=${encodeURIComponent(String(Math.max(0, Math.min(100, Math.trunc(Number(passPercentage) || 80)))))}`);
    if (protectToken) {
        bodyParts.push(`protect_token=${encodeURIComponent(protectToken)}`);
    }
    bodyParts.push("submitExercise=1");
    return bodyParts.join("&");
}

function buildExerciseQuestionRequestBody(questionPayload, protectToken, formInputs = []) {
    const bodyParts = [];
    const skipNames = new Set([
        "questionName",
        "nb_answers",
        "correct",
        "submitQuestion",
        "protect_token"
    ]);

    for (const input of Array.isArray(formInputs) ? formInputs : []) {
        const name = `${input?.name || ""}`.trim();
        if (!name || skipNames.has(name)) {
            continue;
        }
        if (/^answer\[\d+\]$/i.test(name) || /^weighting\[\d+\]$/i.test(name)) {
            continue;
        }
        const type = `${input?.type || ""}`.toLowerCase();
        if (type === "file" || type === "submit") {
            continue;
        }
        bodyParts.push(`${encodeURIComponent(name)}=${encodeURIComponent(input?.value ?? "")}`);
    }

    bodyParts.push(`questionName=${encodeURIComponent(questionPayload.prompt)}`);
    bodyParts.push(`nb_answers=${questionPayload.options.length}`);
    bodyParts.push(`correct=${questionPayload.correctIndex + 1}`);
    if (protectToken) {
        bodyParts.push(`protect_token=${encodeURIComponent(protectToken)}`);
    }
    bodyParts.push("submitQuestion=1");

    questionPayload.options.forEach(((option, optionIndex) => {
        const num = optionIndex + 1;
        bodyParts.push(`answer[${num}]=${encodeURIComponent(option.text)}`);
        bodyParts.push(`weighting[${num}]=${num === questionPayload.correctIndex + 1 ? "10" : "0"}`);
    }));

    return bodyParts.join("&");
}

async function requestWithCookieJar(cookieJar, url, options = {}) {
    const headers = {
        ...options.headers,
        ...buildRequestHeaders(cookieJar)
    };
    const response = await fetch(url, {
        ...options,
        headers,
        redirect: options.redirect || "manual"
    });
    cookieJar.addFromResponse(response);
    return response;
}

async function addQuestionToExercise({
    baseUrl,
    cidReq,
    exerciseId,
    question,
    questionIndex,
    cookieJar
}) {
    const qUrl = buildChamiloUrl(baseUrl, `/main/exercise/admin.php?cidReq=${encodeURIComponent(cidReq)}&exerciseId=${encodeURIComponent(exerciseId)}&newQuestion=yes&answerType=1`);
    const openFormResponse = await requestWithCookieJar(cookieJar, qUrl, {
        method: "GET"
    });
    const formHtml = await openFormResponse.text();
    const parsedForms = parseForms(formHtml, openFormResponse.url || qUrl);
    const questionForm = parsedForms.find((form => form.method === "POST" && /\/main\/exercise\/admin\.php/i.test(form.action))) || parsedForms[0] || null;
    const formInputs = Array.isArray(questionForm?.inputs) ? questionForm.inputs : [];
    const protectToken = extractProtectToken(formHtml);
    const normalizedQuestion = normalizeExerciseQuestion(question, questionIndex);
    const body = buildExerciseQuestionRequestBody(normalizedQuestion, protectToken, formInputs);
    const response = await requestWithCookieJar(cookieJar, questionForm?.action || qUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body
    });
    if (response.status >= 400) {
        throw new Error(`Chamilo rejected question ${questionIndex + 1} with HTTP ${response.status}.`);
    }
}

export async function createChamiloTest(profile, test) {
    const normalized = normalizeChamiloProfile(profile);
    if (!normalized.baseUrl || !normalized.username || !normalized.password) {
        throw new Error("Chamilo base URL, username and password are required.");
    }
    if (!normalized.courseCode) {
        throw new Error("Chamilo course must be selected before creating a test.");
    }
    const cookieJar = createCookieJar();
    const loginUrl = buildChamiloUrl(normalized.baseUrl, normalized.loginPath || "/index.php");
    const loginBody = `login=${encodeURIComponent(normalized.username)}&password=${encodeURIComponent(normalized.password)}&submitAuth=1`;
    await requestWithCookieJar(cookieJar, loginUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: loginBody
    });
    const exerciseUrl = buildChamiloUrl(normalized.baseUrl, `/main/exercise/exercise_admin.php?cidReq=${encodeURIComponent(normalized.courseCode)}`);
    const formResponse = await requestWithCookieJar(cookieJar, exerciseUrl, {
        method: "GET"
    });
    const formHtml = await formResponse.text();
    const protectToken = extractProtectToken(formHtml);
    const createBody = buildExerciseCreateRequestBody({
        title: test?.title || "New test",
        attemptsLimit: test?.attemptsLimit ?? 3,
        passPercentage: test?.passPercentage ?? 80,
        protectToken
    });
    const createResponse = await requestWithCookieJar(cookieJar, exerciseUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: createBody
    });
    const createHtml = await createResponse.text();
    const locationHeader = createResponse.headers.get("location") || "";
    const exerciseId = extractExerciseIdFromResponse(locationHeader, createHtml);
    if (!exerciseId) {
        throw new Error("Unable to create exercise: exerciseId was not found in response.");
    }
    const questions = Array.isArray(test?.questions) ? test.questions : [];
    for (const [ questionIndex, question ] of questions.entries()) {
        await addQuestionToExercise({
            baseUrl: normalized.baseUrl,
            cidReq: normalized.courseCode,
            exerciseId,
            question,
            questionIndex,
            cookieJar
        });
    }
    return {
        success: true,
        exerciseId,
        questionCount: questions.length,
        _cookieJar: cookieJar
    };
}

export async function createFinalTestExerciseInChamilo({
    profile,
    finalTest,
    courseTitle
}) {
    const normalized = normalizeChamiloProfile(profile);
    const enabled = Boolean(finalTest?.enabled);
    const questions = Array.isArray(finalTest?.questions) ? finalTest.questions : [];
    if (!enabled || questions.length === 0) {
        return {
            ok: false,
            skipped: true,
            message: "Final test is disabled or has no questions."
        };
    }
    const testTitle = trimText(finalTest?.title || `${trimText(courseTitle || "Course")} - Final test`);
    const created = await createChamiloTest(normalized, {
        title: testTitle || "Final test",
        attemptsLimit: finalTest?.attemptsLimit ?? 1,
        passPercentage: finalTest?.passingScore ?? 80,
        questions
    });
    return {
        ok: true,
        exerciseId: created.exerciseId,
        questionCount: created.questionCount,
        message: `Exercise ${created.exerciseId} created with ${created.questionCount} question(s).`,
        _cookieJar: created._cookieJar || null
    };
}

export async function connectToChamilo({profile}) {
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
    const loginForm = loginForms.find((form => form.hasPassword));
    let dashboardResult;
    if (loginForm) {
        const loginName = loginForm.inputs.find((input => [ "login", "username", "user", "email" ].includes(input.name.toLowerCase())))?.name ?? "login";
        const passwordName = loginForm.inputs.find((input => input.type === "password"))?.name ?? "password";
        const loginBody = formToUrlEncoded(loginForm, {
            [loginName]: normalized.username,
            [passwordName]: normalized.password,
            ...buildSubmitOverrides(loginForm)
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
    if (courses.length === 0) {
        courses = await fetchCoursesFromUploadPage(normalized, cookieJar);
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
    let uploadResult;
    try {
        uploadResult = await findUploadForm(normalized, cookieJar, courses);
    } catch (primaryError) {
        if (!normalized.courseCode) {
            throw primaryError;
        }
        const relaxedProfile = {
            ...normalized,
            courseCode: ""
        };
        try {
            uploadResult = await findUploadForm(relaxedProfile, cookieJar, courses);
        } catch {
            const fallbackUrl = buildUploadUrl(normalized);
            uploadResult = {
                uploadUrl: fallbackUrl,
                uploadForm: createSyntheticUploadForm(fallbackUrl, normalized.courseCode, "user_file"),
                uploadPageTitle: ""
            };
        }
    }
    return {
        ok: true,
        profile: normalized,
        cookieJar,
        loginUrl,
        uploadUrl: uploadResult.uploadUrl,
        uploadForm: uploadResult.uploadForm,
        uploadPageTitle: uploadResult.uploadPageTitle,
        courses
    };
}


async function ensureChamiloCookieJar(profile, existingJar) {
    const normalized = normalizeChamiloProfile(profile);
    if (existingJar) {
        return {
            profile: normalized,
            cookieJar: existingJar
        };
    }
    if (!normalized.baseUrl || !normalized.username || !normalized.password) {
        throw new Error("Chamilo base URL, username and password are required.");
    }
    const cookieJar = createCookieJar();
    const loginUrl = buildChamiloUrl(normalized.baseUrl, normalized.loginPath || "/index.php");
    const loginBody = `login=${encodeURIComponent(normalized.username)}&password=${encodeURIComponent(normalized.password)}&submitAuth=1`;
    await requestWithCookieJar(cookieJar, loginUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: loginBody
    });
    return {
        profile: normalized,
        cookieJar
    };
}

export async function findLatestLpId({profile, cookieJar: existingJar}) {
    const prepared = await ensureChamiloCookieJar(profile, existingJar);
    const normalized = prepared.profile;
    const cookieJar = prepared.cookieJar;
    if (!normalized.courseCode) {
        return null;
    }
    const base = normalized.baseUrl.replace(/\/$/, "");
    const cidReq = normalized.courseCode;
    const lpListUrl = `${base}/main/lp/lp_controller.php?cidReq=${encodeURIComponent(cidReq)}`;
    const request = await fetchWithRedirectChain({
        url: lpListUrl,
        method: "GET",
        headers: buildRequestHeaders(cookieJar),
        cookieJar,
        maxRedirects: 6
    });
    const html = await request.response.text();
    const ids = [...html.matchAll(/lp_id=(\d+)/gi)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
    const uniqueIds = [...new Set(ids)];
    return uniqueIds.length > 0 ? Math.max(...uniqueIds) : null;
}

export async function addExerciseToLearningPath({profile, lpId, exerciseId, exerciseTitle, cookieJar: existingJar}) {
    const prepared = await ensureChamiloCookieJar(profile, existingJar);
    const normalized = prepared.profile;
    const cookieJar = prepared.cookieJar;
    if (!normalized.courseCode) {
        throw new Error("Chamilo course code is required to add exercise to learning path.");
    }

    const base = normalized.baseUrl.replace(/\/$/, "");
    const cidReq = normalized.courseCode;
    const buildUrl = `${base}/main/lp/lp_controller.php?cidReq=${encodeURIComponent(cidReq)}&action=build&lp_id=${encodeURIComponent(String(lpId))}`;
    const buildRequest = await fetchWithRedirectChain({
        url: buildUrl,
        method: "GET",
        headers: buildRequestHeaders(cookieJar),
        cookieJar,
        maxRedirects: 6
    });
    const lpHtml = await buildRequest.response.text();

    let itemIds = [...lpHtml.matchAll(/id\s*=\s*["']lp_item_(\d+)["']/gi)].map((match) => match[1]);
    if (itemIds.length === 0) {
        itemIds = [...lpHtml.matchAll(/data-id\s*=\s*["'](\d+)["']/gi)].map((match) => match[1]);
    }
    if (itemIds.length === 0) {
        const selectMatch = lpHtml.match(/<select[^>]*name\s*=\s*["']previous["'][^>]*>([\s\S]*?)<\/select>/i);
        if (selectMatch?.[1]) {
            itemIds = [...selectMatch[1].matchAll(/value\s*=\s*["'](\d+)["']/gi)].map((match) => match[1]);
        }
    }
    const lastItemId = itemIds.length > 0 ? itemIds[itemIds.length - 1] : "0";

    const forms = parseForms(lpHtml, buildRequest.response.url || buildUrl);
    const addItemForm = forms.find((form) => {
        if (form.method !== "POST") {
            return false;
        }
        if (!/lp_controller|learnpath/i.test(form.action)) {
            return false;
        }
        if (/action=add_item/i.test(form.action)) {
            return true;
        }
        return form.inputs.some((input) => /(^|_)(path|type|title|parent|previous|_qf__quiz_form)(_|$)/i.test(String(input?.name || "")));
    }) || null;

    const findInputName = (inputs, patterns, fallback = "") => {
        for (const pattern of patterns) {
            const found = inputs.find((input) => pattern.test(String(input?.name || "")));
            if (found?.name) {
                return found.name;
            }
        }
        return fallback;
    };

    let addUrl = `${base}/main/lp/lp_controller.php?cidReq=${encodeURIComponent(cidReq)}&id_session=0&gidReq=0&gradebook=0&origin=&action=add_item&lp_id=${encodeURIComponent(String(lpId))}`;
    let body = "";

    if (addItemForm) {
        const inputs = Array.isArray(addItemForm.inputs) ? addItemForm.inputs : [];
        const titleField = findInputName(inputs, [/^title$/i, /item.*title/i, /item.*name/i], "title");
        const parentField = findInputName(inputs, [/^parent$/i, /item.*parent/i], "parent");
        const previousField = findInputName(inputs, [/^previous$/i, /item.*previous/i], "previous");
        const pathField = findInputName(inputs, [/^path$/i, /item.*path/i, /lp.*path/i], "path");
        const typeField = findInputName(inputs, [/^type$/i, /item.*type/i], "type");
        const postTimeField = findInputName(inputs, [/^post_time$/i], "");

        const overrides = {
            ...buildSubmitOverrides(addItemForm)
        };
        if (titleField) {
            overrides[titleField] = trimText(exerciseTitle || "Final test") || "Final test";
        }
        if (parentField) {
            overrides[parentField] = "0";
        }
        if (previousField) {
            overrides[previousField] = lastItemId;
        }
        if (pathField) {
            overrides[pathField] = String(exerciseId);
        }
        if (typeField) {
            overrides[typeField] = "quiz";
        }
        if (postTimeField) {
            overrides[postTimeField] = String(Math.floor(Date.now() / 1000));
        }
        if (!overrides.submit_button) {
            overrides.submit_button = "";
        }
        if (!overrides._qf__quiz_form) {
            overrides._qf__quiz_form = "";
        }

        addUrl = addItemForm.action || addUrl;
        body = formToUrlEncoded(addItemForm, overrides).toString();
    } else {
        const fallbackBody = new URLSearchParams();
        fallbackBody.set("title", trimText(exerciseTitle || "Final test") || "Final test");
        fallbackBody.set("parent", "0");
        fallbackBody.set("previous", lastItemId);
        fallbackBody.set("submit_button", "");
        fallbackBody.set("_qf__quiz_form", "");
        fallbackBody.set("path", String(exerciseId));
        fallbackBody.set("type", "quiz");
        fallbackBody.set("post_time", String(Math.floor(Date.now() / 1000)));
        body = fallbackBody.toString();
    }

    const response = await requestWithCookieJar(cookieJar, addUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body,
        redirect: "manual"
    });

    const responseText = await response.text();
    const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const safeTitle = escapeRegex(trimText(exerciseTitle || ""));
    const safeExerciseId = escapeRegex(String(exerciseId));
    const linkedById = new RegExp(`(?:path|exerciseId|exercise_id|item_view|id)=${safeExerciseId}`, "i").test(responseText + " " + (response.headers.get("location") || ""));
    const linkedByTitle = safeTitle ? new RegExp(safeTitle, "i").test(responseText) : false;
    const requestOk = response.ok || (response.status >= 300 && response.status < 400);

    return {
        ok: requestOk && (linkedById || linkedByTitle || addItemForm !== null),
        status: response.status,
        linkedById,
        linkedByTitle,
        usedFormAction: addUrl,
        message: linkedById || linkedByTitle
            ? "Exercise link marker was found in Chamilo response."
            : "Exercise add request was sent, but explicit link marker was not found in response."
    };
}

export const __chamiloClientInternals = {
    isStrictUploadConfirmationEnabled,
    extractLpIdFromUploadResult
};


