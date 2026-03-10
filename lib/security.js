import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// ID Sanitization — prevents path traversal attacks
// ---------------------------------------------------------------------------

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validates and sanitizes a resource ID (courseId, materialId, exportId).
 * Returns the ID if safe, or null if it contains path traversal or invalid chars.
 */
export function sanitizeResourceId(id) {
  if (typeof id !== "string") {
    return null;
  }
  const trimmed = id.trim();
  if (!trimmed || !SAFE_ID_PATTERN.test(trimmed)) {
    return null;
  }
  // Extra guard: reject anything with path separators or dots sequences
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  return trimmed;
}

/**
 * Returns a 400 response if the resource ID is invalid.
 * Use in API routes: const id = guardResourceId(rawId); if (id instanceof NextResponse) return id;
 */
export function guardResourceId(rawId, label = "Resource") {
  const safe = sanitizeResourceId(rawId);
  if (!safe) {
    return NextResponse.json(
      { error: `Invalid ${label} ID. Only alphanumeric characters, hyphens and underscores are allowed.` },
      { status: 400 }
    );
  }
  return safe;
}

// ---------------------------------------------------------------------------
// API Key Authentication
// ---------------------------------------------------------------------------

/**
 * Checks the API key from the request headers against the configured key.
 * If SCORM_API_KEY env variable is not set, authentication is disabled (open access).
 * Returns null if auth passes, or a NextResponse with 401 if it fails.
 */
export function checkApiAuth(request) {
  const configuredKey = (process.env.SCORM_API_KEY || "").trim();
  if (!configuredKey) {
    // Auth disabled — no API key configured
    return null;
  }

  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  const apiKeyHeader = (request.headers.get("x-api-key") || "").trim();

  if (bearerToken === configuredKey || apiKeyHeader === configuredKey) {
    return null;
  }

  return NextResponse.json(
    { error: "Unauthorized. Provide a valid API key via Authorization: Bearer <key> or X-API-Key header." },
    { status: 401 }
  );
}

// ---------------------------------------------------------------------------
// Rate Limiting (simple in-memory, per-IP)
// ---------------------------------------------------------------------------

const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.SCORM_RATE_LIMIT) || 30;

function cleanupExpiredEntries() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(ip);
    }
  }
}

/**
 * Simple rate limiter. Returns null if request is allowed,
 * or a NextResponse with 429 if rate limit exceeded.
 */
export function checkRateLimit(request) {
  if (RATE_LIMIT_MAX_REQUESTS <= 0) {
    return null; // Rate limiting disabled
  }

  const ip = request.headers.get("x-forwarded-for")
    || request.headers.get("x-real-ip")
    || "127.0.0.1";

  const now = Date.now();

  // Cleanup every ~100 requests
  if (rateLimitStore.size > 100) {
    cleanupExpiredEntries();
  }

  const entry = rateLimitStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return null;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX_REQUESTS} requests per minute.` },
      { status: 429 }
    );
  }

  return null;
}
