import { resolveUrl } from "./html-parser.js";

export function buildChamiloUrl(baseUrl, maybePath) {
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

export function pickForm(forms, predicate, fallbackMessage) {
    const form = forms.find(predicate);
    if (!form) {
        throw new Error(fallbackMessage);
    }
    return form;
}

export function buildSubmitOverrides(form) {
    const submitInput = form.inputs.find((input => input.type === "submit" && input.name));
    if (!submitInput) {
        return {};
    }
    return {
        [submitInput.name]: submitInput.value || "1"
    };
}

export function isRedirectStatus(status) {
    return status >= 300 && status < 400;
}

export function createCookieJar() {
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

export function buildRequestHeaders(cookieJar) {
    const cookie = cookieJar.header();
    return cookie ? {
        Cookie: cookie
    } : {};
}

export async function fetchWithRedirectChain({url, method = "GET", headers = {}, body, cookieJar, maxRedirects = 5}) {
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
        if ((response.status === 301 || response.status === 302 || response.status === 303) && currentMethod !== "GET") {
            currentMethod = "GET";
            currentBody = undefined;
        }
        if (response.status === 307 || response.status === 308) {
            break;
        }
    }
    return {
        response,
        history
    };
}

export async function requestWithCookieJar(cookieJar, url, options = {}) {
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
