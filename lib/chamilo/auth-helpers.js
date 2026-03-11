import { trimText, parseForms, parseCoursesFromHtml } from "./html-parser.js";
import { 
    buildChamiloUrl, 
    createCookieJar, 
    buildRequestHeaders, 
    requestWithCookieJar,
    buildSubmitOverrides
} from "./http-client.js";
import { formToUrlEncoded, findUploadForm, createSyntheticUploadForm, buildUploadUrl } from "./upload-helpers.js";

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

export function hasLoginForm(html) {
    const text = String(html || "").toLowerCase();
    return /<input\b[^>]*type\s*=\s*["']password["']/i.test(text) && (text.includes('name="login"') || text.includes('name="username"') || text.includes("submitauth"));
}

export function buildLoginUrl(profile) {
    const base = trimText(profile.baseUrl).replace(/\/$/, "");
    return buildChamiloUrl(base, trimText(profile.loginPath || "/index.php"));
}

export async function fetchDashboard(normalized, cookieJar) {
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

export async function fetchCourseCatalog(normalized, cookieJar) {
    const candidateUrls = [ buildChamiloUrl(normalized.baseUrl, "/main/auth/courses.php?action=subscribe"), buildChamiloUrl(normalized.baseUrl, "/main/auth/courses.php"), buildChamiloUrl(normalized.baseUrl, "/main/auth/my_space.php"), buildChamiloUrl(normalized.baseUrl, "/main/mySpace/index.php"), buildChamiloUrl(normalized.baseUrl, "/main/mySpace/"), buildChamiloUrl(normalized.baseUrl, "/main/course_info/course_home.php"), buildChamiloUrl(normalized.baseUrl, "/main/course_info/catalog.php"), buildChamiloUrl(normalized.baseUrl, "/main/course_info/my_course.php") ];
    const uniqueUrls = Array.from(new Set(candidateUrls));
    for (const url of uniqueUrls) {
        try {
            const response = await fetch(url, { headers: buildRequestHeaders(cookieJar) });
            if (response.status === 200) {
                const html = await response.text();
                const courses = parseCoursesFromHtml(html, response.url || url);
                if (courses.length > 0) return courses;
            }
        } catch { /* ignore */ }
    }
    return [];
}

export async function tryDirectChamiloLogin(normalized, cookieJar, loginUrl) {
    const loginBody = `login=${encodeURIComponent(normalized.username)}&password=${encodeURIComponent(normalized.password)}&submitAuth=1`;
    await fetch(loginUrl, {
        method: "POST",
        headers: {
            ...buildRequestHeaders(cookieJar),
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: loginBody,
        redirect: "manual"
    });
    return await fetchDashboard(normalized, cookieJar);
}

export async function fetchCoursesFromUploadPage(normalized, cookieJar) {
    try {
        const uploadUrl = buildUploadUrl(normalized);
        const response = await fetch(uploadUrl, { headers: buildRequestHeaders(cookieJar) });
        if (response.status === 200) {
            const html = await response.text();
            return parseCoursesFromHtml(html, response.url || uploadUrl);
        }
    } catch { /* ignore */ }
    return [];
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
    if (courses.length === 0) courses = await fetchCourseCatalog(normalized, cookieJar);
    if (courses.length === 0) courses = await fetchCoursesFromUploadPage(normalized, cookieJar);

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
        if (!normalized.courseCode) throw primaryError;
        const relaxedProfile = { ...normalized, courseCode: "" };
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

export async function ensureChamiloCookieJar(profile, existingJar) {
    const normalized = normalizeChamiloProfile(profile);
    if (existingJar) return { profile: normalized, cookieJar: existingJar };
    if (!normalized.baseUrl || !normalized.username || !normalized.password) {
        throw new Error("Chamilo base URL, username and password are required.");
    }
    const cookieJar = createCookieJar();
    const loginUrl = buildChamiloUrl(normalized.baseUrl, normalized.loginPath || "/index.php");
    const loginBody = `login=${encodeURIComponent(normalized.username)}&password=${encodeURIComponent(normalized.password)}&submitAuth=1`;
    await requestWithCookieJar(cookieJar, loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: loginBody
    });
    return { profile: normalized, cookieJar };
}
