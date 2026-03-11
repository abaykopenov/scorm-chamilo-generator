export function trimText(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

export function stripQuotes(value) {
    return value.replace(/^['"]|['"]$/g, "");
}

export function getAttr(tag, attrName) {
    const match = tag.match(new RegExp(`${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return stripQuotes(match?.[1] ?? "");
}

export function decodeHtml(value) {
    return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

export function resolveUrl(baseUrl, maybeRelative) {
    return new URL(maybeRelative || "", baseUrl).toString();
}

export function decodeMaybeEncodedUrl(value) {
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

export function parseInputs(formHtml) {
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

export function looksLikeFileField(input) {
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
    if (/\b(user_?file|file_upload|upload_file|uploaded_file|zip_file|package_file|scorm_file)\b/.test(name)) {
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

export function isLikelyCourseCode(value) {
    const normalized = String(value ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{2,64}$/.test(normalized)) {
        return false;
    }
    const blacklist = new Set([ "true", "false", "null", "undefined", "none", "course", "courses", "home", "index", "profile", "upload", "import", "list", "edit", "delete" ]);
    return !blacklist.has(normalized.toLowerCase());
}

export function extractCourseCode(rawValue, baseUrl) {
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
    } catch { /* ignore invalid URL */ }
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

export function isLikelyCourseTitle(value) {
    const normalized = decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (normalized.length < 2) {
        return false;
    }
    const blacklist = new Set([ "import", "upload", "delete", "edit", "profile", "dashboard", "settings", "home", "next", "previous" ]);
    return !blacklist.has(normalized.toLowerCase());
}

export function isCourseRelatedPath(pathname) {
    return /\/(?:main\/)?(?:course_home|course_info|auth\/courses\.php|newscorm|lp|learnpath|myspace|session\/\d+\/course)/i.test(pathname) || /\/courses\/[^/?#]+/i.test(pathname);
}

export function isLikelyCourseHref(href, baseUrl, depth = 0) {
    const decodedHref = decodeMaybeEncodedUrl(String(href ?? ""));
    if (!decodedHref || /^javascript:/i.test(decodedHref)) {
        return false;
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

export function isLikelyCourseSelect(attrs) {
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

export function isLikelyCourseContainer(attrs) {
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

export function extractPageTitle(html) {
    return String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
}

export function extractProtectToken(html) {
    const source = String(html || "");
    const direct = source.match(/name=["']protect_token["'][^>]*value=["']([^"']*)["']/i);
    if (direct?.[1]) {
        return decodeHtml(direct[1]);
    }
    const reverse = source.match(/value=["']([^"']*)["'][^>]*name=["']protect_token["']/i);
    return decodeHtml(reverse?.[1] || "");
}

export function extractExerciseIdFromResponse(locationHeader, htmlBody) {
    const fromLocation = String(locationHeader || "").match(/exerciseId=(\d+)/i)?.[1];
    if (fromLocation) {
        return fromLocation;
    }
    return String(htmlBody || "").match(/exerciseId=(\d+)/i)?.[1] || "";
}
