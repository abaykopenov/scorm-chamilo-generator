/**
 * Parallel Generator — distributes module generation across LLM pool
 * with concurrency control and progress tracking
 */
import { LlmPool } from "./llm-pool.js";
import { createModulePrompt, createTestPrompt } from "./local-llm.js";
import { saveJob, emitJobUpdate } from "./job-store.js";

/**
 * Call a single LLM server (Ollama or OpenAI-compatible)
 */
async function callServer(server, systemPrompt, userPrompt, maxTokens = 64000) {
    const timeout = 300000; // 5 min
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        if (server.provider === "ollama") {
            const resp = await fetch(`${server.url.replace(/\/$/, "")}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: server.model,
                    stream: false,
                    format: "json",
                    options: {
                        temperature: 0.7,
                        num_ctx: maxTokens >= 32000 ? 65536 : 32768,
                        num_predict: maxTokens || 8192
                    },
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ]
                }),
                signal: controller.signal
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => "");
                throw new Error(`Ollama: ${resp.status} ${errText.slice(0, 200)}`);
            }
            const data = await resp.json();
            const content = data?.message?.content || "";
            console.log(`[Parallel] Ollama raw (first 200): ${content.slice(0, 200)}`);
            return content;
        } else {
            // OpenAI-compatible
            const baseUrl = server.url.replace(/\/$/, "");
            const url = baseUrl.includes("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: server.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: maxTokens
                }),
                signal: controller.signal
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => "");
                throw new Error(`OpenAI: ${resp.status} ${errText.slice(0, 200)}`);
            }
            const data = await resp.json();
            return data?.choices?.[0]?.message?.content || "";
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Extract JSON from LLM response text
 */
function extractJson(text) {
    if (!text) return null;
    // Strip <think> blocks (Qwen models)
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // Try direct parse
    try { return JSON.parse(cleaned); } catch { }
    // Find JSON block in markdown
    const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        try { return JSON.parse(jsonMatch[1].trim()); } catch { }
    }
    // Find first { ... } or [ ... ]
    const start = cleaned.indexOf("{");
    const startArr = cleaned.indexOf("[");
    const idx = start >= 0 && (startArr < 0 || start < startArr) ? start : startArr;
    if (idx >= 0) {
        const openBr = cleaned[idx];
        const closeBr = openBr === "{" ? "}" : "]";
        let depth = 0;
        for (let i = idx; i < cleaned.length; i++) {
            if (cleaned[i] === openBr) depth++;
            if (cleaned[i] === closeBr) depth--;
            if (depth === 0) {
                try { return JSON.parse(cleaned.slice(idx, i + 1)); } catch { break; }
            }
        }
    }
    console.warn(`[Parallel] extractJson FAILED, text starts with: ${text.slice(0, 100)}`);
    return null;
}

const SYSTEM_PROMPT = `Ты — эксперт по созданию e-learning курсов. Генерируй контент на русском языке строго в JSON формате.
ПРАВИЛА:
- Каждый "text" блок: 2-4 содержательных предложения с фактами и примерами.
- Списки: 3-5 пунктов, каждый — конкретное действие или факт.
- НЕ используй шаблонные фразы. Пиши как профессиональный методист.
- Ответ — ТОЛЬКО валидный JSON, без markdown и пояснений.`;

/**
 * Generate modules in parallel across LLM pool
 * @param {Object} input - normalized generation input
 * @param {LlmServer[]} servers - array of LLM server configs
 * @param {Object} job - job object for progress tracking
 * @param {Object} options
 * @param {number} options.concurrency - max parallel tasks
 * @param {string[]} [options.fileChunks] - optional text chunks from uploaded files
 */
export async function generateParallel(input, servers, job, options = {}) {
    const { concurrency = 4, fileChunks = [] } = options;
    const pool = new LlmPool(servers);

    if (pool.size === 0) {
        throw new Error("No enabled LLM servers configured");
    }

    const { structure } = input;
    const totalSteps = structure.moduleCount + (input.finalTest.enabled ? 1 : 0);

    // Create tasks
    const tasks = [];
    for (let i = 0; i < structure.moduleCount; i++) {
        const promptObj = createModulePrompt(input, i);
        let userPrompt = promptObj.user;
        // Add file context if available
        if (fileChunks.length > 0) {
            const chunksPerModule = Math.ceil(fileChunks.length / structure.moduleCount);
            const start = i * chunksPerModule;
            const relevantChunks = fileChunks.slice(start, start + chunksPerModule);
            if (relevantChunks.length > 0) {
                userPrompt += `\n\nИСПОЛЬЗУЙ ЭТОТ МАТЕРИАЛ КАК ОСНОВУ:\n${relevantChunks.join("\n---\n")}`;
            }
        }
        tasks.push({ type: "module", index: i, system: promptObj.system, user: userPrompt });
    }

    if (input.finalTest.enabled && input.finalTest.questionCount > 0) {
        const testPrompt = createTestPrompt(input);
        tasks.push({ type: "test", system: testPrompt.system, user: testPrompt.user });
    }

    // Execute with concurrency
    const results = new Array(tasks.length).fill(null);
    let completedCount = 0;

    async function runTask(taskIndex) {
        const task = tasks[taskIndex];
        const { server, release } = await pool.acquireSlot();
        const label = task.type === "test" ? "Тест" : `Модуль ${task.index + 1}`;

        try {
            job.currentStep = `Генерация: ${label} → ${server.name}`;
            job.progress = Math.round((completedCount / totalSteps) * 100);
            await saveJob(job);
            emitJobUpdate(job);

            console.log(`[Parallel] ${label} → ${server.name} (${server.model})`);
            const start = Date.now();
            const text = await callServer(server, task.system, task.user, input.generation?.maxTokens);
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`[Parallel] ${label} done in ${elapsed}s (${text.length} chars)`);

            const parsed = extractJson(text);
            if (parsed) {
                console.log(`[Parallel] ${label} parsed OK, keys: ${Object.keys(parsed).join(", ")}`);
            } else {
                console.warn(`[Parallel] ${label} parse FAILED, text length: ${text.length}`);
            }
            results[taskIndex] = parsed;

            completedCount++;
            job.steps.push({ label, server: server.name, elapsed: `${elapsed}s`, ok: !!parsed });
            job.progress = Math.round((completedCount / totalSteps) * 100);
            job.currentStep = `✅ ${label} готов (${elapsed}s)`;
            await saveJob(job);
            emitJobUpdate(job);
        } catch (err) {
            console.error(`[Parallel] ${label} failed:`, err.message);
            completedCount++;
            job.steps.push({ label, server: server.name, ok: false, error: err.message });
            job.progress = Math.round((completedCount / totalSteps) * 100);
            await saveJob(job);
            emitJobUpdate(job);
        } finally {
            release();
        }
    }

    // Run with concurrency limit
    const executing = new Set();
    for (let i = 0; i < tasks.length; i++) {
        const p = runTask(i).then(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);

    // Assemble results
    const modules = [];
    let finalTest = null;
    for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].type === "module") {
            modules.push(results[i]);
        } else {
            finalTest = results[i];
        }
    }

    const validModules = modules.filter(Boolean);
    if (validModules.length === 0 && !finalTest) {
        return null;
    }

    console.log(`[Parallel] Generated ${validModules.length}/${structure.moduleCount} modules, test: ${finalTest ? "yes" : "no"}`);

    return {
        title: input.titleHint,
        description: `Курс "${input.titleHint}" для аудитории "${input.audience}". Длительность: ${input.durationMinutes} минут.`,
        modules,
        finalTest
    };
}
