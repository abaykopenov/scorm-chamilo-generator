// ---------------------------------------------------------------------------
// lib/llm — Public API (barrel export)
// ---------------------------------------------------------------------------
// Re-exports all public symbols so that consumers can import from "lib/llm"
// or from the individual sub-modules.

export {
  callOllama,
  callOpenAiCompatible,
  callProvider,
  checkLocalLlmConnection
} from "./providers.js";

export {
  parseJsonFromLlmText,
  parseLinePlanText,
  validateOutlineJson
} from "./parser.js";

export {
  delay,
  describePrompt,
  describeTrace,
  fetchWithNetworkHint,
  getConfiguredBaseUrls,
  isEndpointUnreachableError,
  llmLog,
  LOG_CHARS_MAX,
  LOG_CHARS_PROMPT_PREVIEW,
  LOG_CHARS_RESPONSE_PREVIEW,
  looksLikeEmbeddingModel,
  resolveTimeoutMs,
  rotateBaseUrls,
  shouldFallbackFromChatToGenerate,
  shouldRetryNetworkError,
  toPlainText,
  truncateForLog
} from "./utils.js";
