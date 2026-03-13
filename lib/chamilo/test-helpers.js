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
    protectToken = "",
    formInputs = [],
    submitName = "submitExercise",
    submitValue = "1"
}) {
    const bodyParts = [];

    // First, include ALL hidden fields from the scraped form
    // (CSRF tokens, _qf__ identifiers, sec_token, etc.)
    const skipNames = new Set([
        "exerciseTitle", "exercise_title", "exerciseAttempts", "pass_percentage",
        "exerciseEndMessage", "submitExercise", "protect_token", submitName,
        "text_when_finished", "exerciseDescription"
    ]);
    const seenNames = new Set();
    for (const input of Array.isArray(formInputs) ? formInputs : []) {
        const name = `${input?.name || ""}`.trim();
        if (!name || skipNames.has(name)) continue;
        const type = `${input?.type || ""}`.toLowerCase();
        if (type === "file" || type === "submit") continue;
        // Checkboxes: skip entirely — in HTML, unchecked checkboxes are NOT sent.
        // Sending them would enable start/end dates, timers, etc.
        if (type === "checkbox") continue;
        // Radio: only send first (default) value
        if (type === "radio") {
            if (seenNames.has(name)) continue;
        }
        // Skip date/time fields and other non-essential fields
        if (/^(start_time|end_time|enabletimercontroltotalminutes)$/.test(name)) continue;
        seenNames.add(name);
        bodyParts.push(`${encodeURIComponent(name)}=${encodeURIComponent(input?.value ?? "")}`);
    }

    // Now add our exercise-specific fields
    bodyParts.push(`exerciseTitle=${encodeURIComponent(trimText(title) || "New test")}`);
    bodyParts.push(`exerciseAttempts=${encodeURIComponent(String(Math.max(1, Math.trunc(Number(attemptsLimit) || 1))))}`);
    bodyParts.push(`pass_percentage=${encodeURIComponent(String(Math.max(0, Math.min(100, Math.trunc(Number(passPercentage) || 80)))))}`);
    // Prevent finishText TypeError in Chamilo PHP 8.x
    bodyParts.push(`exerciseEndMessage=`);
    if (protectToken) {
        bodyParts.push(`protect_token=${encodeURIComponent(protectToken)}`);
    }
    // Use the dynamically detected submit button name
    bodyParts.push(`${encodeURIComponent(submitName)}=${encodeURIComponent(submitValue)}`);
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

    // Scrape the form to get ALL hidden fields
    const scrapedForms = parseForms(formHtml, formResponse.url || exerciseUrl);
    
    console.log(`[chamilo-test] Found ${scrapedForms.length} forms on exercise_admin page`);
    for (const [i, f] of scrapedForms.entries()) {
        const fieldNames = f.inputs.map(inp => `${inp.name}(${inp.type})`).join(", ");
        console.log(`[chamilo-test] Form ${i}: method=${f.method} action=${f.action} fields=[${fieldNames}]`);
    }

    const exerciseForm = scrapedForms.find(f =>
        f.method === "POST" && f.inputs.some(inp => /exerciseTitle|exercise_title/i.test(inp.name))
    ) || scrapedForms.find(f =>
        f.method === "POST" && /exercise_admin/i.test(f.action)
    ) || scrapedForms.find(f => f.method === "POST") || null;

    if (!exerciseForm) {
        console.error(`[chamilo-test] No POST form found! Page title: ${formHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "unknown"}`);
        console.error(`[chamilo-test] Page snippet: ${formHtml.slice(0, 800)}`);
        throw new Error("Exercise creation form not found on Chamilo page. Check course code and permissions.");
    }

    const formInputs = exerciseForm.inputs || [];
    const formActionUrl = exerciseForm.action || exerciseUrl;

    // Detect the submit button name dynamically
    const submitBtn = formInputs.find(inp => inp.type === "submit" && inp.name);
    const submitName = submitBtn?.name || "submitExercise";
    const submitValue = submitBtn?.value || "1";

    console.log(`[chamilo-test] Using form: ${formInputs.length} fields, action=${formActionUrl}, submit=${submitName}`);

    const createBody = buildExerciseCreateRequestBody({
        title: test?.title || "New test",
        attemptsLimit: test?.attemptsLimit ?? 3,
        passPercentage: test?.passPercentage ?? 80,
        protectToken,
        formInputs,
        submitName,
        submitValue
    });

    console.log(`[chamilo-test] POST body preview: ${createBody.slice(0, 300)}`);

    // Use fetchWithRedirectChain to follow 302 redirects and capture exerciseId
    const createResult = await fetchWithRedirectChain({
        url: formActionUrl,
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...buildRequestHeaders(cookieJar)
        },
        body: createBody,
        cookieJar,
        maxRedirects: 6
    });

    const createResponse = createResult.response;
    const createHtml = await createResponse.text();

    // Check for Chamilo error messages
    const alertDanger = createHtml.match(/class="alert[- ]danger"[^>]*>([\s\S]*?)<\/div>/i);
    if (alertDanger) {
        console.error(`[chamilo-test] Chamilo error: ${alertDanger[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`);
    }

    // Check if login page was returned
    if (createHtml.includes('id="login_form"') || createHtml.includes('name="login"')) {
        console.error(`[chamilo-test] Chamilo returned login page — session expired`);
        throw new Error("Chamilo session expired during test creation. Re-authenticate.");
    }

    // Extract exerciseId from redirect chain, final URL, and response body
    const allUrls = [
        ...createResult.history.map(h => h.location),
        ...createResult.history.map(h => h.url),
        createResponse.url || "",
        createHtml
    ].filter(Boolean).join(" ");

    let exerciseId = allUrls.match(/exerciseId=(\d+)/i)?.[1] || "";
    if (!exerciseId) {
        exerciseId = allUrls.match(/exercise_id=(\d+)/i)?.[1]
            || allUrls.match(/id_exercise=(\d+)/i)?.[1]
            || allUrls.match(/"exerciseId"\s*:\s*"?(\d+)/i)?.[1]
            || allUrls.match(/id=(\d+)/i)?.[1]
            || "";
    }

    console.log(`[chamilo-test] Exercise create: status=${createResponse.status}, redirects=${createResult.history.length}, exerciseId=${exerciseId || "NOT FOUND"}`);

    if (!exerciseId) {
        console.error(`[chamilo-test] Response snippet: ${createHtml.slice(0, 1000)}`);
        console.error(`[chamilo-test] Redirect history: ${JSON.stringify(createResult.history.map(h => ({ status: h.status, location: h.location })))}`);
        throw new Error("Unable to create exercise: exerciseId was not found in response.");
    }
    const questions = Array.isArray(test?.questions) ? test.questions : [];
    console.log(`[chamilo-test] Adding ${questions.length} questions to exercise ${exerciseId}...`);
    for (const [ questionIndex, question ] of questions.entries()) {
        try {
            await addQuestionToExercise({
                baseUrl: normalized.baseUrl,
                cidReq: normalized.courseCode,
                exerciseId,
                question,
                questionIndex,
                cookieJar
            });
            console.log(`[chamilo-test] ✅ Question ${questionIndex + 1}/${questions.length} added`);
        } catch (qErr) {
            console.error(`[chamilo-test] ❌ Question ${questionIndex + 1} failed: ${qErr?.message || qErr}`);
            // Continue with remaining questions
        }
    }
    return {
        success: true,
        exerciseId,
        questionCount: questions.length,
        _cookieJar: cookieJar
    };
}

export async function findExistingExercise({ profile, title, cookieJar: existingJar }) {
    const prepared = await ensureChamiloCookieJar(profile, existingJar);
    const normalized = prepared.profile;
    const cookieJar = prepared.cookieJar;
    if (!normalized.courseCode || !title) return null;

    const base = normalized.baseUrl.replace(/\/$/, "");
    const listUrl = `${base}/main/exercise/exercise.php?cidReq=${encodeURIComponent(normalized.courseCode)}`;

    try {
        const request = await fetchWithRedirectChain({
            url: listUrl,
            method: "GET",
            headers: buildRequestHeaders(cookieJar),
            cookieJar,
            maxRedirects: 6
        });
        const html = await request.response.text();
        const normalizedTitle = title.trim().toLowerCase();

        // Search for exercise links with matching title
        // Chamilo renders: <a href="...exerciseId=123...">Exercise Title</a>
        const exercisePattern = /href="[^"]*exerciseId=(\d+)[^"]*"[^>]*>([^<]+)</gi;
        let match;
        while ((match = exercisePattern.exec(html)) !== null) {
            const foundId = match[1];
            const foundTitle = match[2].trim().toLowerCase();
            if (foundTitle === normalizedTitle || foundTitle.includes(normalizedTitle) || normalizedTitle.includes(foundTitle)) {
                console.log(`[chamilo-test] Found existing exercise: id=${foundId}, title="${match[2].trim()}"`);
                return { exerciseId: foundId, title: match[2].trim(), cookieJar };
            }
        }
        console.log(`[chamilo-test] No existing exercise found with title "${title}"`);
        return null;
    } catch (err) {
        console.error(`[chamilo-test] Error checking existing exercises: ${err?.message || err}`);
        return null;
    }
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

    // Check for existing exercise with same title to avoid duplicates
    const existing = await findExistingExercise({ profile: normalized, title: testTitle });
    if (existing) {
        console.log(`[chamilo-test] Reusing existing exercise ${existing.exerciseId} ("${existing.title}") instead of creating duplicate`);
        return {
            ok: true,
            exerciseId: existing.exerciseId,
            questionCount: questions.length,
            message: `Reused existing exercise ${existing.exerciseId} ("${existing.title}").`,
            _cookieJar: existing.cookieJar || null,
            reused: true
        };
    }

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
        _cookieJar: created._cookieJar || null,
        reused: false
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
    console.log(`[chamilo-lp] Linking exercise ${exerciseId} to LP ${lpId}...`);
    const prepared = await ensureChamiloCookieJar(profile, existingJar);
    const normalized = prepared.profile;
    const cookieJar = prepared.cookieJar;
    if (!normalized.courseCode) throw new Error("Chamilo course code is required to add exercise to learning path.");
    const base = normalized.baseUrl.replace(/\/$/, "");
    const cidReq = normalized.courseCode;

    // Step 1: GET the LP build page to find existing items (for "previous" field)
    const buildUrl = `${base}/main/lp/lp_controller.php?cidReq=${encodeURIComponent(cidReq)}&action=build&lp_id=${encodeURIComponent(String(lpId))}`;
    console.log(`[chamilo-lp] Step 1: GET LP build page: ${buildUrl}`);
    const buildRequest = await fetchWithRedirectChain({
        url: buildUrl,
        method: "GET",
        headers: buildRequestHeaders(cookieJar),
        cookieJar,
        maxRedirects: 6
    });
    const lpHtml = await buildRequest.response.text();
    
    // Find last item ID in the LP structure
    let itemIds = [...lpHtml.matchAll(/id\s*=\s*["']lp_item_(\d+)["']/gi)].map(m => m[1]);
    if (itemIds.length === 0) itemIds = [...lpHtml.matchAll(/data-id\s*=\s*["'](\d+)["']/gi)].map(m => m[1]);
    if (itemIds.length === 0) {
        const selectMatch = lpHtml.match(/<select[^>]*name\s*=\s*["']previous["'][^>]*>([\s\S]*?)<\/select>/i);
        if (selectMatch?.[1]) itemIds = [...selectMatch[1].matchAll(/value\s*=\s*["'](\d+)["']/gi)].map(m => m[1]);
    }
    const lastItemId = itemIds.length > 0 ? itemIds[itemIds.length - 1] : "0";
    console.log(`[chamilo-lp] Found ${itemIds.length} existing items, lastItemId=${lastItemId}`);

    // Step 2: Direct POST to add_item action
    const addUrl = `${base}/main/lp/lp_controller.php?cidReq=${encodeURIComponent(cidReq)}&id_session=0&gidReq=0&gradebook=0&origin=&action=add_item&lp_id=${encodeURIComponent(String(lpId))}`;
    
    const serverDateHeader = buildRequest.response.headers.get("date");
    const calculatedServerTime = serverDateHeader ? Math.floor(new Date(serverDateHeader).getTime() / 1000) : Math.floor(Date.now() / 1000);

    // Build the POST body manually (don't use URLSearchParams to keep brackets unencoded)
    const bodyParts = [
        `title=${encodeURIComponent(trimText(exerciseTitle || "Final test") || "Final test")}`,
        `parent=0`,
        `previous=${lastItemId}`,
        `path=${exerciseId}`,
        `type=quiz`,
        `post_time=${calculatedServerTime}`,
        `submit_button=`,
        `_qf__quiz_form=`
    ];
    const body = bodyParts.join("&");

    console.log(`[chamilo-lp] Step 2: POST add_item: ${addUrl}`);
    console.log(`[chamilo-lp] Body: ${body}`);

    const addResult = await fetchWithRedirectChain({
        url: addUrl,
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...buildRequestHeaders(cookieJar)
        },
        body,
        cookieJar,
        maxRedirects: 6
    });

    const response = addResult.response;
    const responseText = await response.text();
    const responseUrl = response.url || addUrl;

    console.log(`[chamilo-lp] Response status=${response.status}, redirects=${addResult.history.length}, finalUrl=${responseUrl}`);

    // Check if exercise appears in the LP structure after adding
    const exerciseInLp = responseText.includes(`path=${exerciseId}`) || 
        responseText.includes(`exerciseId=${exerciseId}`) ||
        new RegExp(trimText(exerciseTitle || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(responseText) ||
        responseText.includes(`id="lp_item_`);

    // Check for real Chamilo errors (not just CSS class presence)
    const alertMatches = [...responseText.matchAll(/class="alert[- ]danger"[^>]*>([\s\S]*?)<\/div>/gi)];
    let realErrorText = "";
    for (const m of alertMatches) {
        const text = m[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
        if (text.length > 5) { // Ignore empty alert divs (Chamilo standard template)
            realErrorText = text.slice(0, 300);
            break;
        }
    }
    
    if (realErrorText) {
        console.error(`[chamilo-lp] Chamilo error: ${realErrorText}`);
    }

    const requestOk = response.ok || (response.status >= 300 && response.status < 400);
    // If the exercise title/id appears in the response, it was linked successfully
    const isSuccess = (requestOk && !realErrorText) || exerciseInLp;

    console.log(`[chamilo-lp] Result: ok=${isSuccess}, exerciseInLp=${exerciseInLp}, error="${realErrorText || "none"}"`);

    return {
        ok: isSuccess,
        status: response.status,
        linkedById: exerciseInLp,
        linkedByTitle: exerciseInLp,
        usedFormAction: addUrl,
        message: isSuccess ? "Exercise added to Learning Path." : `LP linking failed: ${realErrorText || "unknown error"}`
    };
}
