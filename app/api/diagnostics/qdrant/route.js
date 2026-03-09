import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { getQdrantRuntimeConfig } from "@/lib/langchain-qdrant";

function normalizeBaseUrl(value, fallback) {
  const raw = `${value || ""}`.trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (!parsed.port) {
      parsed.port = "6333";
    }
    return parsed;
  } catch {
    return new URL(fallback);
  }
}

function toErrorMessage(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

async function checkDns(hostname) {
  try {
    const result = await lookup(hostname);
    return {
      ok: true,
      host: hostname,
      address: result.address,
      family: result.family
    };
  } catch (error) {
    return {
      ok: false,
      host: hostname,
      message: toErrorMessage(error, "DNS lookup failed")
    };
  }
}

async function checkTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let finished = false;

    function done(payload) {
      if (finished) {
        return;
      }
      finished = true;
      socket.destroy();
      resolve(payload);
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      done({ ok: true, host, port });
    });
    socket.once("timeout", () => {
      done({ ok: false, host, port, message: `TCP timeout after ${timeoutMs}ms` });
    });
    socket.once("error", (error) => {
      done({ ok: false, host, port, message: toErrorMessage(error, "TCP connection failed") });
    });

    socket.connect(port, host);
  });
}

function parseCollectionNames(payload) {
  const list = Array.isArray(payload?.result?.collections)
    ? payload.result.collections
    : (Array.isArray(payload?.collections) ? payload.collections : []);

  return list
    .map((item) => `${item?.name || ""}`.trim())
    .filter(Boolean);
}

async function checkHttp(baseUrl, apiKey, collectionName) {
  const url = `${baseUrl.replace(/\/$/, "")}/collections`;
  const headers = apiKey ? { "api-key": apiKey } : {};

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000)
    });

    const payload = await response.json().catch(() => null);
    const collectionNames = parseCollectionNames(payload);
    const collectionExists = collectionName
      ? collectionNames.includes(collectionName)
      : null;

    return {
      ok: response.ok,
      status: response.status,
      url,
      collectionName,
      collectionExists,
      collectionsCount: collectionNames.length,
      collectionsSample: collectionNames.slice(0, 12)
    };
  } catch (error) {
    return {
      ok: false,
      url,
      collectionName,
      collectionExists: null,
      message: toErrorMessage(error, "HTTP check failed")
    };
  }
}

function buildRecommendations({ enabled, dns, tcp, http, target }) {
  const items = [];

  if (!enabled) {
    items.push("Set QDRANT_ENABLED=true (or remove it) to enable Qdrant mode.");
  }
  if (!dns.ok) {
    items.push("Check that Qdrant host resolves from backend runtime.");
  }
  if (!tcp.ok) {
    items.push("Port is unreachable. Verify Qdrant is running and firewall allows access.");
  }
  if (tcp.ok && !http.ok) {
    items.push("TCP is open but /collections failed. Verify URL, reverse proxy and API key.");
  }
  if (http.ok && target.collectionName && http.collectionExists === false) {
    items.push(`Collection \"${target.collectionName}\" does not exist yet. It will be created during indexing.`);
  }
  if (items.length === 0) {
    items.push(`Qdrant endpoint ${target.baseUrl} is reachable.`);
  }

  return items;
}

async function diagnose(payload) {
  const runtime = getQdrantRuntimeConfig();
  const parsed = normalizeBaseUrl(payload?.baseUrl, runtime.url);
  const target = {
    enabled: runtime.enabled,
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    host: parsed.hostname,
    port: Number(parsed.port),
    protocol: parsed.protocol.replace(":", ""),
    collectionName: `${payload?.collectionName || runtime.collectionName || ""}`.trim() || runtime.collectionName
  };

  const dns = await checkDns(target.host);
  const tcp = await checkTcp(target.host, target.port);
  const http = await checkHttp(target.baseUrl, payload?.apiKey || runtime.apiKey, target.collectionName);

  const ok = Boolean(runtime.enabled && dns.ok && tcp.ok && http.ok);
  const mode = ok ? "connected" : "fallback";

  const message = !runtime.enabled
    ? "Qdrant disabled by configuration (QDRANT_ENABLED=false). Local vector fallback is active."
    : (ok
      ? `Qdrant connected (${target.baseUrl}).`
      : "Qdrant is not available. Local vector fallback is active.");

  return {
    ok,
    mode,
    message,
    target,
    checks: { dns, tcp, http },
    recommendations: buildRecommendations({ enabled: runtime.enabled, dns, tcp, http, target }),
    checkedAt: new Date().toISOString()
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const result = await diagnose({
    baseUrl: searchParams.get("baseUrl") || "",
    collectionName: searchParams.get("collectionName") || "",
    apiKey: searchParams.get("apiKey") || ""
  });
  return NextResponse.json(result);
}

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const result = await diagnose(payload || {});
  return NextResponse.json(result);
}
