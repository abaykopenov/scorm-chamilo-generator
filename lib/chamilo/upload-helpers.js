import { 
    trimText, 
    decodeHtml, 
    parseForms, 
    extractCourseCode, 
    decodeMaybeEncodedUrl, 
    resolveUrl, 
    extractPageTitle, 
    getAttr 
} from "./html-parser.js";
import { 
    buildChamiloUrl, 
    isRedirectStatus, 
    fetchWithRedirectChain, 
    buildSubmitOverrides, 
    buildRequestHeaders 
} from "./http-client.js";
import { hasLoginForm } from "./auth-helpers.js";

export function isStrictUploadConfirmationEnabled() {
    const value = String(process.env.CHAMILO_UPLOAD_STRICT_CONFIRMATION || "").toLowerCase();
    if (!value) {
        return true;
    }
    return !(value === "0" || value === "false" || value === "no" || value === "off" || value === "compat");
}

export function extractLpIdFromUrl(value) {
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
    } catch { /* ignore malformed URLs */ }
    const inline = source.match(/(?:[?&]|\/)(?:lp_id|learnpath_id)=(\d+)/i)?.[1] || "";
    return /^\d+$/.test(inline) ? inline : "";
}

export function extractLpIdFromUploadResult({responseUrl, redirectHistory, responseSnippet}) {
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

export function detectUploadOutcome({status, finalUrl, bodyText, history}) {
    const rawText = String(bodyText || "");
    const text = decodeHtml(rawText);
    const lower = text.toLowerCase();
    const lastHop = history.at(-1);
    const strict = isStrictUploadConfirmationEnabled();
    if (status >= 400) {
        return { ok: false, message: `Chamilo returned HTTP ${status} on upload.` };
    }
    if (isRedirectStatus(status)) {
        return { ok: false, message: `Chamilo returned unresolved redirect (${status}) during upload.` };
    }
    if (hasLoginForm(text) || /\/(index\.php|login|auth)\b/i.test(String(finalUrl || ""))) {
        return { ok: false, message: "Chamilo returned login page after upload. Session/auth was not accepted." };
    }
    const failurePatterns = [ /upload failed/i, /failed to upload/i, /fatal error/i, /exception/i, /not allowed/i, /forbidden/i, /invalid file/i, /file is too large/i, /scorm.*error/i, /import.*error/i, /\berror\b/i ];
    if (failurePatterns.some((pattern => pattern.test(lower)))) {
        return { ok: false, message: "Chamilo reported an upload/import error." };
    }
    const successPatterns = [ /imported successfully/i, /has been imported/i, /uploaded successfully/i, /learnpath has been created/i, /learning path has been imported/i, /lp_controller\.php\?action=(list|view|build|home|edit)/i, /\u0443\u0441\u043f\u0435\u0448\u043d\u043e\s+\u0438\u043c\u043f\u043e\u0440\u0442/i, /\u0443\u0441\u043f\u0435\u0448\u043d\u043e\s+\u0437\u0430\u0433\u0440\u0443\u0436/i, /\u0438\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u043d\s+\u0443\u0441\u043f\u0435\u0448\u043d\u043e/i ];
    if (successPatterns.some((pattern => pattern.test(lower)))) {
        return { ok: true, message: "SCORM upload/import is confirmed by Chamilo response." };
    }
    const responseForms = parseForms(rawText, finalUrl || lastHop?.url || "http://localhost/");
    if (responseForms.some((form => form.hasFileInput))) {
        if (!strict) {
            return { ok: true, message: "Chamilo returned the upload form again; treating as success in compatibility mode." };
        }
        return { ok: false, message: "Upload form is still displayed; SCORM import was not completed." };
    }
    const pendingPatterns = [ /scorm or aicc files for upload/i, /upload.*scorm/i, /file is uploaded/i, /\u0444\u0430\u0439\u043b\s+\u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044f/i ];
    if (pendingPatterns.some((pattern => pattern.test(lower)))) {
        if (!strict) {
            return { ok: true, message: "Chamilo is processing/uploading the SCORM package; treating as success in compatibility mode." };
        }
        return { ok: false, message: "Chamilo is still on upload page; no final import confirmation." };
    }
    if (/lp_controller|newscorm|learnpath|scorm|upload\/index\.php/i.test(String(lastHop?.url || finalUrl || "")) && !hasLoginForm(text)) {
        if (!strict) {
            return { ok: true, message: "Reached Chamilo SCORM area without explicit marker; treating upload as successful in compatibility mode." };
        }
        return { ok: false, message: "Reached Chamilo SCORM area, but explicit import success marker was not found." };
    }
    return { ok: false, message: "Chamilo did not confirm SCORM import in response page." };
}

export function findFollowupImportForm(html, baseUrl) {
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

export function formToUrlEncoded(form, overrides) {
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

export function formToMultipart(form, overrides, fileName, buffer) {
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

export function buildUploadUrl(profile) {
    const base = trimText(profile.baseUrl).replace(/\/$/, "");
    const path = trimText(profile.uploadPagePath || "/main/newscorm/lp_controller.php?action=upload");
    const url = new URL(buildChamiloUrl(base, path));
    if (profile.courseCode && !url.searchParams.has("cidReq")) {
        url.searchParams.set("cidReq", profile.courseCode);
    }
    return url.toString();
}

export function buildUploadCandidateUrls(profile, courses) {
    const candidates = [ buildUploadUrl(profile), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=upload"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=import"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php?action=add_lp"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_controller.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/lp_upload.php"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=upload"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=import"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php?action=add_lp"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_controller.php"), buildChamiloUrl(profile.baseUrl, "/main/lp/lp_upload.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/upload.scorm.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/upload.php"), buildChamiloUrl(profile.baseUrl, "/main/upload/index.php?tool=learnpath&curdirpath=%2F"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/upload.php"), buildChamiloUrl(profile.baseUrl, "/main/newscorm/") ];
    if (profile.courseCode) {
        for (const candidate of [ ...candidates ]) {
            try {
                const url = new URL(candidate);
                if (!url.searchParams.has("cidReq")) {
                    url.searchParams.set("cidReq", profile.courseCode);
                }
                candidates.push(url.toString());
            } catch { /* ignore malformed URL */ }
        }
        candidates.push(buildChamiloUrl(profile.baseUrl, "/course_home/course_home.php?cidReq=" + encodeURIComponent(profile.courseCode)));
    }
    const selectedCourse = Array.isArray(courses) ? courses.find((course => String(course?.code ?? "").trim() === profile.courseCode)) : null;
    if (selectedCourse?.url) {
        candidates.push(selectedCourse.url);
    }
    return Array.from(new Set(candidates.filter(Boolean)));
}

export function createSyntheticUploadForm(action, courseCode, fileInputName = "user_file") {
    const inputs = [];
    if (courseCode) {
        inputs.push({ tagName: "input", name: "cidReq", type: "hidden", value: courseCode });
    }
    try {
        const parsed = new URL(action);
        const tool = parsed.searchParams.get("tool");
        const curdirpath = parsed.searchParams.get("curdirpath");
        if (tool) {
            inputs.push({ tagName: "input", name: "tool", type: "hidden", value: tool });
        } else if (/\/main\/upload\/index\.php$/i.test(parsed.pathname)) {
            inputs.push({ tagName: "input", name: "tool", type: "hidden", value: "learnpath" });
        }
        if (curdirpath) {
            inputs.push({ tagName: "input", name: "curdirpath", type: "hidden", value: curdirpath });
        }
    } catch { /* ignore invalid URL */ }
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

export function buildDirectUploadForms(profile) {
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

export function extractLikelyUploadLinks(html, pageUrl, courseCode) {
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

export function isLikelyScormUploadAction(actionUrl) {
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

export function hasScormUploadHints(form) {
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

export function isLikelyScormStepForm(form) {
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

export async function submitScormStepForm(form, cookieJar) {
    const method = (form.method || "GET").toUpperCase();
    const overrides = { ...buildSubmitOverrides(form) };
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

export async function findUploadForm(normalized, cookieJar, courses) {
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
            attempts.push({ start: nextUrl, finalUrl: nextUrl, status: "network-error" });
            continue;
        }
        const resolvedUrl = response?.url || history.at(-1)?.url || nextUrl;
        const status = response?.status ?? 0;
        attempts.push({ start: nextUrl, finalUrl: resolvedUrl, status });
        const html = await response.text();
        const forms = parseForms(html, resolvedUrl);
        const uploadForm = forms.find((form => form.hasFileInput && isLikelyScormUploadAction(form.action))) || forms.find((form => hasScormUploadHints(form)));
        if (uploadForm) {
            return { uploadUrl: resolvedUrl, uploadForm, uploadPageTitle: extractPageTitle(html) };
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
                attempts.push({ start: `form:${resolvedUrl}`, finalUrl: stepForm.action, status: "form-step-error" });
                continue;
            }
            const stepResolvedUrl = stepResponse?.url || stepHistory.at(-1)?.url || stepForm.action;
            const stepStatus = stepResponse?.status ?? 0;
            attempts.push({ start: `form:${resolvedUrl}`, finalUrl: stepResolvedUrl, status: stepStatus });
            const stepHtml = await stepResponse.text();
            const stepParsedForms = parseForms(stepHtml, stepResolvedUrl);
            const stepUploadForm = stepParsedForms.find((form => form.hasFileInput && isLikelyScormUploadAction(form.action))) || stepParsedForms.find((form => hasScormUploadHints(form)));
            if (stepUploadForm) {
                return { uploadUrl: stepResolvedUrl, uploadForm: stepUploadForm, uploadPageTitle: extractPageTitle(stepHtml) };
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
