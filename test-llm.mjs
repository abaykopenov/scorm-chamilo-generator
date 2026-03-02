// Diagnostic script to test LLM pipeline independently
// Usage: node /tmp/test-llm-pipeline.mjs [ollama_url] [model]

const baseUrl = process.argv[2] || "http://127.0.0.1:11434";
const model = process.argv[3] || "qwen2.5:14b";

console.log(`\n=== LLM Pipeline Test ===`);
console.log(`URL: ${baseUrl}`);
console.log(`Model: ${model}\n`);

// Step 1: Check connectivity
console.log("Step 1: Checking Ollama connectivity...");
try {
    const tagsResp = await fetch(`${baseUrl}/api/tags`);
    const tags = await tagsResp.json();
    const models = (tags.models || []).map(m => m.name);
    console.log(`  ✅ Connected. Available models: ${models.join(", ") || "none"}`);
    if (!models.some(m => m.startsWith(model.split(":")[0]))) {
        console.log(`  ⚠️  Model "${model}" not found in available models!`);
    }
} catch (e) {
    console.log(`  ❌ Cannot connect to ${baseUrl}: ${e.message}`);
    process.exit(1);
}

// Step 2: Test /api/chat
console.log("\nStep 2: Testing /api/chat endpoint...");
const prompt = {
    system: "Ты эксперт по e-learning. Сгенерируй JSON курса. Ответ — ТОЛЬКО валидный JSON.",
    user: `Создай мини-курс:
Название: Основы безопасности
Структура: 1 модуль, 1 раздел, 1 урок, 1 экран, 2 вопроса.
JSON формат:
{
  "title": "string",
  "description": "string", 
  "modules": [{"title": "string", "sections": [{"title": "string", "scos": [{"title": "string", "screens": [{"title": "string", "blocks": [{"type": "text", "text": "2-3 предложения"}]}]}]}]}],
  "finalTest": {"title": "string", "questions": [{"prompt": "string", "options": ["a","b","c","d"], "correctOptionIndex": 0, "explanation": "string"}]}
}`
};

try {
    const start = Date.now();
    const resp = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            stream: false,
            format: "json",
            options: { temperature: 0.7, num_ctx: 8192 },
            messages: [
                { role: "system", content: prompt.system },
                { role: "user", content: prompt.user }
            ]
        })
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Response status: ${resp.status} (${elapsed}s)`);

    if (!resp.ok) {
        const errText = await resp.text();
        console.log(`  ❌ Error: ${errText.slice(0, 300)}`);
        process.exit(1);
    }

    const payload = await resp.json();
    const raw = payload?.message?.content ?? "";
    console.log(`  Raw response length: ${raw.length} chars`);
    console.log(`  First 500 chars:\n---\n${raw.slice(0, 500)}\n---`);

    // Step 3: Parse JSON
    console.log("\nStep 3: Parsing JSON...");
    let parsed = null;
    try { parsed = JSON.parse(raw.trim()); } catch { /* continue */ }

    if (!parsed) {
        const codeBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlock) { try { parsed = JSON.parse(codeBlock[1].trim()); } catch { } }
    }

    if (!parsed) {
        const start = raw.search(/[{\[]/);
        if (start >= 0) {
            const open = raw[start], close = open === "{" ? "}" : "]";
            let depth = 0;
            for (let i = start; i < raw.length; i++) {
                if (raw[i] === open) depth++;
                else if (raw[i] === close) depth--;
                if (depth === 0) { try { parsed = JSON.parse(raw.slice(start, i + 1)); } catch { } break; }
            }
        }
    }

    if (parsed) {
        console.log("  ✅ JSON parsed successfully!");
        console.log(`  Title: ${parsed.title}`);
        console.log(`  Modules: ${parsed.modules?.length}`);
        if (parsed.modules?.[0]?.sections?.[0]?.scos?.[0]?.screens?.[0]?.blocks?.[0]) {
            const block = parsed.modules[0].sections[0].scos[0].screens[0].blocks[0];
            console.log(`  First block type: ${block.type}`);
            console.log(`  First block text: ${(block.text || "").slice(0, 200)}`);
        }
        console.log(`  Questions: ${parsed.finalTest?.questions?.length}`);
    } else {
        console.log("  ❌ Could not parse JSON from response!");
        console.log("  Full response:");
        console.log(raw);
    }
} catch (e) {
    console.log(`  ❌ Request failed: ${e.message}`);
}
