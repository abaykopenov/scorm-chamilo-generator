import { NextResponse } from "next/server";

export async function POST(request) {
    const payload = await request.json().catch(() => ({}));
    const { provider, baseUrl, model } = payload;

    if (!baseUrl) {
        return NextResponse.json({ ok: false, error: "Укажите Base URL." });
    }

    const base = baseUrl.replace(/\/$/, "");

    try {
        if (provider === "ollama") {
            // Check Ollama: GET /api/tags returns list of models
            const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) {
                return NextResponse.json({ ok: false, error: `Ollama вернул HTTP ${resp.status}` });
            }
            const data = await resp.json();
            const models = (data.models || []).map((m) => m.name || m.model);
            const hasModel = !model || models.some((m) => m.startsWith(model));

            return NextResponse.json({
                ok: true,
                models,
                hasModel,
                message: hasModel
                    ? `Подключение к Ollama успешно. Доступно моделей: ${models.length}.`
                    : `Ollama доступен, но модель "${model}" не найдена. Доступные: ${models.join(", ")}`
            });
        } else if (provider === "openai-compatible") {
            // Check OpenAI-compatible: GET /models
            const resp = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) {
                return NextResponse.json({ ok: false, error: `API вернул HTTP ${resp.status}` });
            }
            const data = await resp.json();
            const models = (data.data || []).map((m) => m.id);

            return NextResponse.json({
                ok: true,
                models,
                hasModel: !model || models.includes(model),
                message: `Подключение успешно. Доступно моделей: ${models.length}.`
            });
        } else {
            return NextResponse.json({ ok: true, message: "Шаблонный режим — LLM не требуется." });
        }
    } catch (err) {
        const msg = err.name === "TimeoutError"
            ? `Таймаут подключения к ${base} (5 сек)`
            : `Ошибка подключения: ${err.message}`;
        return NextResponse.json({ ok: false, error: msg });
    }
}
