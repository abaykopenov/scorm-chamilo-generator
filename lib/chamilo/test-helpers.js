import { 
    trimText, 
    parseForms, 
    extractProtectToken, 
    extractExerciseIdFromResponse 
} from "./html-parser.js";
import { buildChamiloUrl, requestWithCookieJar, buildSubmitOverrides, fetchWithRedirectChain, buildRequestHeaders } from "./http-client.js";
import { normalizeChamiloProfile, connectToChamilo, ensureChamiloCookieJar } from "./auth-helpers.js";
import { formToUrlEncoded } from "./upload-helpers.js";

export function normalizeExerciseQuestion(question, questionIndex) {
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

export function buildExerciseCreateRequestBody({
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

export function buildExerciseQuestionRequestBody(questionPayload, protectToken, formInputs = []) {
    const bodyParts = [];
    const skipNames = new Set([ "questionName", "nb_answers", "correct", "submitQuestion", "protect_token" ]);
    for (const input of Array.isArray(formInputs) ? formInputs : []) {
        const name = `${input?.name || ""}`.trim();
        if (!name || skipNames.has(name)) continue;
        if (/^answer\[\d+\]$/i.test(name) || /^weighting\[\d+\]$/i.test(name)) continue;
        const type = `${input?.type || ""}`.toLowerCase();
        if (type === "file" || type === "submit") continue;
        bodyParts.push(`${encodeURIComponent(name)}=${encodeURIComponent(input?.value ?? "")}`);
    }
    bodyParts.push(`questionName=${encodeURIComponent(questionPayload.prompt)}`);
    bodyParts.push(`nb_answers=${questionPayload.options.length}`);
    bodyParts.push(`correct=${questionPayload.correctIndex + 1}`);
    if (protectToken) bodyParts.push(`protect_token=${encodeURIComponent(protectToken)}`);
    bodyParts.push("submitQuestion=1");
    questionPayload.options.forEach(((option, optionIndex) => {
        const num = optionIndex + 1;
        bodyParts.push(`answer[${num}]=${encodeURIComponent(option.text)}`);
        bodyParts.push(`weighting[${num}]=${num === questionPayload.correctIndex + 1 ? "10" : "0"}`);
    }));
    return bodyParts.join("&");
}

export async function addQuestionToExercise({
    baseUrl,
    cidReq,
    exerciseId,
    question,
    questionIndex,
    cookieJar
}) {
    const qUrl = buildChamiloUrl(baseUrl, `/main/exercise/admin.php?cidReq=${encodeURIComponent(cidReq)}&exerciseId=${encodeURIComponent(exerciseId)}&newQuestion=yes&answerType=1`);
    const openFormResponse = await requestWithCookieJar(cookieJar, qUrl, { method: "GET" });
    const formHtml = await openFormResponse.text();
    const parsedForms = parseForms(formHtml, openFormResponse.url || qUrl);
    const questionForm = parsedForms.find((form => form.method === "POST" && /\/main\/exercise\/admin\.php/i.test(form.action))) || parsedForms[0] || null;
    const formInputs = Array.isArray(questionForm?.inputs) ? questionForm.inputs : [];
    const protectToken = extractProtectToken(formHtml);
    const normalizedQuestion = normalizeExerciseQuestion(question, questionIndex);
    const body = buildExerciseQuestionRequestBody(normalizedQuestion, protectToken, formInputs);
    const response = await requestWithCookieJar(cookieJar, questionForm?.action || qUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    if (response.status >= 400) {
        throw new Error(`Chamilo rejected question ${questionIndex + 1} with HTTP ${response.status}.`);
    }
}

export async function createChamiloTest(profile, test) {
    const normalized = normalizeChamiloProfile(profile);
    if (!normalized.courseCode) {
        throw new Error("Chamilo course must be selected before creating a test.");
    }
    const connection = await connectToChamilo({ profile: normalized });
    if (!connection.ok) {
        throw new Error("Failed to authenticate with Chamilo while creating test.");
    }
    const cookieJar = connection.cookieJar;
    const exerciseUrl = buildChamiloUrl(normalized.baseUrl, `/main/exercise/exercise_admin.php?cidReq=${encodeURIComponent(normalized.courseCode)}`);
    const formResponse = await requestWithCookieJar(cookieJar, exerciseUrl, { method: "GET" });
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
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
        return { ok: false, skipped: true, message: "Final test is disabled or has no questions." };
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

export async function findLatestLpId({profile, cookieJar: existingJar}) {
    const prepared = await ensureChamiloCookieJar(profile, existingJar);
    const normalized = prepared.profile;
    const cookieJar = prepared.cookieJar;
    if (!normalized.courseCode) return null;
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
    if (!normalized.courseCode) throw new Error("Chamilo course code is required to add exercise to learning path.");
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
    if (itemIds.length === 0) itemIds = [...lpHtml.matchAll(/data-id\s*=\s*["'](\d+)["']/gi)].map((match) => match[1]);
    if (itemIds.length === 0) {
        const selectMatch = lpHtml.match(/<select[^>]*name\s*=\s*["']previous["'][^>]*>([\s\S]*?)<\/select>/i);
        if (selectMatch?.[1]) itemIds = [...selectMatch[1].matchAll(/value\s*=\s*["'](\d+)["']/gi)].map((match) => match[1]);
    }
    const lastItemId = itemIds.length > 0 ? itemIds[itemIds.length - 1] : "0";
    const forms = parseForms(lpHtml, buildRequest.response.url || buildUrl);
    const addItemForm = forms.find((form) => {
        if (form.method !== "POST") return false;
        if (!/lp_controller|learnpath/i.test(form.action)) return false;
        if (/action=add_item/i.test(form.action)) return true;
        return form.inputs.some((input) => /(^|_)(path|type|title|parent|previous|_qf__quiz_form)(_|$)/i.test(String(input?.name || "")));
    }) || null;

    const findInputName = (inputs, patterns, fallback = "") => {
        for (const pattern of patterns) {
            const found = inputs.find((input) => pattern.test(String(input?.name || "")));
            if (found?.name) return found.name;
        }
        return fallback;
    };

    let addUrl = `${base}/main/lp/lp_controller.php?cidReq=${encodeURIComponent(cidReq)}&id_session=0&gidReq=0&gradebook=0&origin=&action=add_item&lp_id=${encodeURIComponent(String(lpId))}`;
    let body = "";
    const serverDateHeader = buildRequest.response.headers.get("date");
    const calculatedServerTime = serverDateHeader ? Math.floor(new Date(serverDateHeader).getTime() / 1000) : Math.floor(Date.now() / 1000);

    if (addItemForm) {
        const inputs = Array.isArray(addItemForm.inputs) ? addItemForm.inputs : [];
        const titleField = findInputName(inputs, [/^title$/i, /item.*title/i, /item.*name/i], "title");
        const parentField = findInputName(inputs, [/^parent$/i, /item.*parent/i], "parent");
        const previousField = findInputName(inputs, [/^previous$/i, /item.*previous/i], "previous");
        const pathField = findInputName(inputs, [/^path$/i, /item.*path/i, /lp.*path/i], "path");
        const typeField = findInputName(inputs, [/^type$/i, /item.*type/i], "type");
        const postTimeField = findInputName(inputs, [/^post_time$/i], "");
        const overrides = { ...buildSubmitOverrides(addItemForm) };
        if (titleField) overrides[titleField] = trimText(exerciseTitle || "Final test") || "Final test";
        if (parentField) overrides[parentField] = "0";
        if (previousField) overrides[previousField] = lastItemId;
        if (pathField) overrides[pathField] = String(exerciseId);
        if (typeField) overrides[typeField] = "quiz";
        if (postTimeField) overrides[postTimeField] = String(calculatedServerTime);
        if (!overrides.submit_button) overrides.submit_button = "";
        if (!overrides._qf__quiz_form) overrides._qf__quiz_form = "";
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
        fallbackBody.set("post_time", String(calculatedServerTime));
        body = fallbackBody.toString();
    }

    const response = await requestWithCookieJar(cookieJar, addUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
        message: linkedById || linkedByTitle ? "Exercise link marker was found in Chamilo response." : "Exercise add request was sent, but explicit link marker was not found in response."
    };
}
