import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
    chamilo: {
        baseUrl: "",
        username: "",
        password: "",
        courseCode: ""
    },
    llm: {
        provider: "template",
        baseUrl: "http://127.0.0.1:11434",
        model: "",
        temperature: 0.4
    }
};

export async function getSettings() {
    try {
        const raw = await readFile(SETTINGS_PATH, "utf8");
        const saved = JSON.parse(raw);
        return {
            chamilo: { ...DEFAULTS.chamilo, ...saved.chamilo },
            llm: { ...DEFAULTS.llm, ...saved.llm }
        };
    } catch {
        return { ...DEFAULTS };
    }
}

export async function saveSettings(settings) {
    await mkdir(DATA_DIR, { recursive: true });
    const current = await getSettings();
    const merged = {
        chamilo: { ...current.chamilo, ...settings.chamilo },
        llm: { ...current.llm, ...settings.llm }
    };
    await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
    return merged;
}
