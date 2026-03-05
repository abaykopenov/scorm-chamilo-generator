import { NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import net from "node:net";

function normalizeBaseUrl(value) {
  const fallback = "http://127.0.0.1:11434";
  const raw = `${value || ""}`.trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (!parsed.port) {
      parsed.port = parsed.protocol === "https:" ? "443" : "80";
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
      done({
        ok: true,
        host,
        port
      });
    });
    socket.once("timeout", () => {
      done({
        ok: false,
        host,
        port,
        message: `TCP timeout after ${timeoutMs}ms`
      });
    });
    socket.once("error", (error) => {
      done({
        ok: false,
        host,
        port,
        message: toErrorMessage(error, "TCP connection failed")
      });
    });

    socket.connect(port, host);
  });
}

async function checkHttp(baseUrl) {
  const tagsUrl = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const response = await fetch(tagsUrl, {
      method: "GET",
      signal: AbortSignal.timeout(3000)
    });
    const text = await response.text();
    return {
      ok: response.ok,
      url: tagsUrl,
      status: response.status,
      sample: text.slice(0, 240)
    };
  } catch (error) {
    return {
      ok: false,
      url: tagsUrl,
      message: toErrorMessage(error, "HTTP check failed")
    };
  }
}

function buildRecommendations({ dns, tcp, http, target }) {
  const items = [];
  if (!dns.ok) {
    items.push("Проверьте, что host в Base URL указан корректно и резолвится из среды backend.");
  }
  if (!tcp.ok) {
    items.push("Порт недоступен. Проверьте OLLAMA_HOST (например, 0.0.0.0:11434) и firewall.");
  }
  if (tcp.ok && !http.ok) {
    items.push("TCP доступен, но HTTP /api/tags недоступен. Проверьте, что это действительно Ollama endpoint.");
  }
  if (http.ok && http.status >= 400) {
    items.push("HTTP endpoint отвечает с ошибкой. Проверьте reverse proxy, auth и путь /api/tags.");
  }
  if (items.length === 0) {
    items.push(`Endpoint ${target.baseUrl} доступен и отвечает.`);
  }
  return items;
}

async function diagnose(baseUrlInput) {
  const parsed = normalizeBaseUrl(baseUrlInput);
  const target = {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    host: parsed.hostname,
    port: Number(parsed.port),
    protocol: parsed.protocol.replace(":", "")
  };

  const dns = await checkDns(target.host);
  const tcp = await checkTcp(target.host, target.port);
  const http = await checkHttp(target.baseUrl);

  const ok = Boolean(dns.ok && tcp.ok && http.ok);
  return {
    ok,
    target,
    checks: { dns, tcp, http },
    recommendations: buildRecommendations({ dns, tcp, http, target }),
    checkedAt: new Date().toISOString()
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const baseUrl = searchParams.get("baseUrl") || "";
  const result = await diagnose(baseUrl);
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}

export async function POST(request) {
  const payload = await request.json().catch(() => ({}));
  const result = await diagnose(payload?.baseUrl || "");
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
