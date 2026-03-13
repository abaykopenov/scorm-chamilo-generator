import { NextResponse } from "next/server";

// Routes that require authentication via ADMIN_PANEL_PASSWORD
const PROTECTED_API_PREFIXES = ["/api/admin"];
// Public routes — no auth needed
const PUBLIC_PATHS = ["/", "/api/local-llm", "/api/courses", "/api/materials", "/api/exports", "/api/diagnostics"];

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // Only protect admin API routes
  const isProtectedApi = PROTECTED_API_PREFIXES.some(prefix => pathname.startsWith(prefix));
  if (!isProtectedApi) {
    return NextResponse.next();
  }

  // Check Bearer token against ADMIN_PANEL_PASSWORD
  const adminPassword = process.env.ADMIN_PANEL_PASSWORD;
  if (!adminPassword) {
    // If no password configured, allow all access
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (token === adminPassword) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { ok: false, error: "Unauthorized" },
    { status: 401 }
  );
}

export const config = {
  matcher: ["/api/admin/:path*"]
};
