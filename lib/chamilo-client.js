// Chamilo Client - Re-export hub
export {
    trimText,
    stripQuotes,
    getAttr,
    decodeHtml,
    resolveUrl,
    decodeMaybeEncodedUrl,
    parseInputs,
    looksLikeFileField,
    parseForms,
    isLikelyCourseCode,
    extractCourseCode,
    isLikelyCourseTitle,
    isCourseRelatedPath,
    isLikelyCourseHref,
    isLikelyCourseSelect,
    isLikelyCourseContainer,
    parseCoursesFromHtml,
    extractPageTitle,
    extractProtectToken,
    extractExerciseIdFromResponse
} from "./chamilo/html-parser.js";

export {
    buildChamiloUrl,
    pickForm,
    buildSubmitOverrides,
    isRedirectStatus,
    createCookieJar,
    buildRequestHeaders,
    fetchWithRedirectChain,
    requestWithCookieJar
} from "./chamilo/http-client.js";

export {
    isStrictUploadConfirmationEnabled,
    extractLpIdFromUrl,
    extractLpIdFromUploadResult,
    detectUploadOutcome,
    findFollowupImportForm,
    formToUrlEncoded,
    formToMultipart,
    buildUploadUrl,
    buildUploadCandidateUrls,
    createSyntheticUploadForm,
    buildDirectUploadForms,
    extractLikelyUploadLinks,
    isLikelyScormUploadAction,
    hasScormUploadHints,
    isLikelyScormStepForm,
    submitScormStepForm,
    findUploadForm
} from "./chamilo/upload-helpers.js";

export {
    normalizeChamiloProfile,
    hasLoginForm,
    buildLoginUrl,
    fetchDashboard,
    fetchCourseCatalog,
    tryDirectChamiloLogin,
    fetchCoursesFromUploadPage,
    connectToChamilo,
    ensureChamiloCookieJar
} from "./chamilo/auth-helpers.js";

export {
    normalizeExerciseQuestion,
    buildExerciseCreateRequestBody,
    buildExerciseQuestionRequestBody,
    addQuestionToExercise,
    createChamiloTest,
    createFinalTestExerciseInChamilo,
    findLatestLpId,
    addExerciseToLearningPath
} from "./chamilo/test-helpers.js";

import {
    isStrictUploadConfirmationEnabled,
    extractLpIdFromUploadResult
} from "./chamilo/upload-helpers.js";

export const __chamiloClientInternals = {
    isStrictUploadConfirmationEnabled,
    extractLpIdFromUploadResult
};
