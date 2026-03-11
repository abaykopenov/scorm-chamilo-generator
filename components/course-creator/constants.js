export const MAX_UPLOAD_FILE_SIZE_MB = 50;
export const MAX_UPLOAD_FILE_SIZE = MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;
export const MATERIAL_CHUNKS_PAGE_SIZE = 12;
export const MATERIAL_CHUNK_PREVIEW_CHARS = 420;
export const GENERATION_STAGE_LABELS = {
  request: "Preparing request",
  input: "Validating input",
  rag: "Building context",
  "llm-outline": "Generating outline",
  "llm-line-plan": "Building line plan",
  finalize: "Finalizing course",
  saving: "Saving course",
  done: "Completed"
};
