import { NextResponse } from "next/server";
import { getCourse, saveCourse } from "@/lib/course-store";
import { getSettings } from "@/lib/settings-store";
import { createModulePrompt } from "@/lib/local-llm";
import { createId } from "@/lib/ids";

function extractJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { }
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { return JSON.parse(m[1].trim()); } catch { } }
    const s = text.indexOf("{");
    if (s >= 0) {
        let d = 0;
        for (let i = s; i < text.length; i++) {
            if (text[i] === "{") d++;
            if (text[i] === "}") d--;
            if (d === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { break; } }
        }
    }
    return null;
}

async function callLlmServer(server, systemPrompt, userPrompt) {
    const timeout = 300000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        if (server.provider === "ollama") {
            const resp = await fetch(`${server.url.replace(/\/$/, "")}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: server.model, stream: false,
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
                }),
                signal: controller.signal
            });
            const data = await resp.json();
            return data?.message?.content || "";
        } else {
            const base = server.url.replace(/\/$/, "");
            const url = base.includes("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: server.model,
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                    temperature: 0.7, max_tokens: 64000
                }),
                signal: controller.signal
            });
            const data = await resp.json();
            return data?.choices?.[0]?.message?.content || "";
        }
    } finally { clearTimeout(timer); }
}


/** Flatten LLM module output into screens, regardless of nesting depth */
function flattenScreens(parsed) {
    const screens = [];

    function collect(obj) {
        if (!obj || typeof obj !== "object") return;
        // If obj has blocks array, it's a screen
        if (Array.isArray(obj.blocks)) {
            screens.push({ title: obj.title || "", blocks: obj.blocks });
            return;
        }
        // Recurse into arrays and known children
        for (const key of ["screens", "scos", "sections", "lessons", "slides", "pages"]) {
            if (Array.isArray(obj[key])) {
                for (const child of obj[key]) collect(child);
            }
        }
        // Also check if it's an array directly
        if (Array.isArray(obj)) {
            for (const child of obj) collect(child);
        }
    }

    collect(parsed);
    return screens;
}

export async function POST(request, { params }) {
    const { courseId } = await params;
    const body = await request.json();
    const { action, moduleIndex, instruction, server: requestedServer } = body;

    const course = await getCourse(courseId);
    if (!course) {
        return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const settings = await getSettings();

    // Pick server: 1) from request body, 2) from course generation config, 3) from servers pool, 4) from settings.llm
    let server;
    if (requestedServer && requestedServer.url && requestedServer.model) {
        server = requestedServer;
    } else {
        const genConfig = course._generationConfig || course.generation;
        const servers = settings.servers || [];
        const activeServer = servers.find((s) => s.enabled && s.url && s.model);

        if (genConfig && genConfig.baseUrl && genConfig.model) {
            server = { url: genConfig.baseUrl, model: genConfig.model, provider: genConfig.provider || "ollama", name: `Original (${genConfig.model})` };
        } else if (activeServer) {
            server = activeServer;
        } else {
            const llm = settings.llm || {};
            if (llm.baseUrl && llm.model) {
                server = { url: llm.baseUrl, model: llm.model, provider: llm.provider || "ollama", name: "Default LLM" };
            }
        }
    }

    if (!server) {
        return NextResponse.json({ error: "No LLM server configured" }, { status: 400 });
    }

    if (action === "regenerate-module" && moduleIndex !== undefined) {
        const input = {
            titleHint: course.title,
            audience: "сотрудники",
            learningGoals: course.modules.map((m) => m.title),
            durationMinutes: 45,
            structure: { moduleCount: course.modules.length, sectionsPerModule: 2, scosPerSection: 2, screensPerSco: 3 },
            generation: settings.llm
        };
        const promptObj = createModulePrompt(input, moduleIndex);
        let userPrompt = promptObj.user;
        if (instruction) userPrompt += `\n\nДОПОЛНИТЕЛЬНОЕ УКАЗАНИЕ: ${instruction}`;

        console.log(`[Regenerate] Module ${moduleIndex + 1} → ${server.name} (${server.model})`);
        const text = await callLlmServer(server, promptObj.system, userPrompt);
        console.log(`[Regenerate] Response: ${text.length} chars`);

        const parsed = extractJson(text);
        if (!parsed) {
            return NextResponse.json({ error: "LLM returned invalid JSON" }, { status: 500 });
        }

        // Flatten screens from any nesting structure
        const allScreens = flattenScreens(parsed);
        console.log(`[Regenerate] Found ${allScreens.length} screens in response`);

        // Rebuild module with LLM content
        const oldModule = course.modules[moduleIndex];
        const newModule = {
            ...oldModule,
            title: parsed.title || oldModule.title,
            sections: oldModule.sections.map((section, si) => ({
                ...section,
                title: parsed.sections?.[si]?.title || section.title,
                scos: section.scos.map((sco, sci) => ({
                    ...sco,
                    screens: sco.screens.map((screen, scri) => {
                        // Map screens sequentially from flattened list
                        const flatIdx = si * (section.scos.length * sco.screens.length) + sci * sco.screens.length + scri;
                        const screenData = allScreens[flatIdx] || allScreens[scri];
                        if (screenData) {
                            return { ...screen, title: screenData.title || screen.title, blocks: screenData.blocks };
                        }
                        return screen;
                    })
                }))
            }))
        };

        course.modules[moduleIndex] = newModule;
        await saveCourse(course);
        return NextResponse.json({ ok: true, module: newModule });
    }

    if (action === "add-module") {
        const input = {
            titleHint: course.title,
            audience: "сотрудники",
            learningGoals: [instruction || "Дополнительная тема"],
            durationMinutes: 15,
            structure: { moduleCount: 1, sectionsPerModule: 2, scosPerSection: 1, screensPerSco: 3 },
            generation: settings.llm
        };
        const promptObj = createModulePrompt(input, 0);
        console.log(`[AddModule] → ${server.name} (${server.model})`);
        const text = await callLlmServer(server, promptObj.system, promptObj.user);
        const parsed = extractJson(text);
        const allScreens = flattenScreens(parsed || {});

        const newModule = {
            id: createId("module"),
            title: parsed?.title || instruction || `Модуль ${course.modules.length + 1}`,
            order: course.modules.length + 1,
            sections: [{
                id: createId("section"),
                title: parsed?.sections?.[0]?.title || "Раздел 1",
                order: 1,
                scos: [{
                    id: createId("sco"),
                    title: "SCO 1",
                    order: 1,
                    screens: allScreens.length > 0
                        ? allScreens.map((s, i) => ({
                            id: createId("screen"),
                            title: s.title || `Экран ${i + 1}`,
                            order: i + 1,
                            blocks: s.blocks || [{ type: "text", text: "Контент" }]
                        }))
                        : [{ id: createId("screen"), title: "Экран 1", order: 1, blocks: [{ type: "text", text: "Контент генерируется..." }] }]
                }]
            }]
        };

        course.modules.push(newModule);
        await saveCourse(course);
        return NextResponse.json({ ok: true, module: newModule });
    }

    if (action === "delete-module" && moduleIndex !== undefined) {
        course.modules.splice(moduleIndex, 1);
        course.modules.forEach((m, i) => { m.order = i + 1; });
        await saveCourse(course);
        return NextResponse.json({ ok: true });
    }

    if (action === "update-module" && moduleIndex !== undefined) {
        const { module } = body;
        if (module) {
            course.modules[moduleIndex] = { ...course.modules[moduleIndex], ...module };
            await saveCourse(course);
            return NextResponse.json({ ok: true });
        }
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
