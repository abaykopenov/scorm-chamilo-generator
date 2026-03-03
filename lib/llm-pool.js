/**
 * LLM Pool — manages multiple LLM server endpoints
 * Provides round-robin or fastest-first distribution across servers
 */

/**
 * @typedef {Object} LlmServer
 * @property {string} id
 * @property {string} name
 * @property {string} url      - base URL (e.g. http://192.168.8.9:11434)
 * @property {string} provider - "ollama" | "openai-compatible"
 * @property {string} model
 * @property {number} maxConcurrent - max parallel requests (default 2)
 * @property {boolean} enabled
 */

export function createDefaultServer(overrides = {}) {
    return {
        id: "srv_" + Math.random().toString(36).slice(2, 8),
        name: "Server 1",
        url: "http://127.0.0.1:11434",
        provider: "ollama",
        model: "",
        maxConcurrent: 2,
        enabled: true,
        ...overrides
    };
}

export class LlmPool {
    /** @param {LlmServer[]} servers */
    constructor(servers = []) {
        // Trim URLs to prevent whitespace issues
        const cleaned = servers.map(s => ({ ...s, url: s.url?.trim() }));
        // For generation: need model. For health check: model can be empty
        this.allServers = cleaned.filter((s) => s.enabled && s.url);
        this.servers = cleaned.filter((s) => s.enabled && s.url && s.model);
        this.active = new Map();
        for (const s of this.servers) this.active.set(s.id, 0);
    }

    get size() {
        return this.servers.length;
    }

    /** Pick the least-busy server */
    pickServer() {
        if (this.servers.length === 0) return null;
        let best = this.servers[0];
        let bestLoad = Infinity;
        for (const s of this.servers) {
            const load = (this.active.get(s.id) || 0) / (s.maxConcurrent || 1);
            if (load < bestLoad) {
                bestLoad = load;
                best = s;
            }
        }
        return best;
    }

    /** Acquire a server slot, returns release function */
    acquire(serverId) {
        this.active.set(serverId, (this.active.get(serverId) || 0) + 1);
        return () => {
            this.active.set(serverId, Math.max(0, (this.active.get(serverId) || 1) - 1));
        };
    }

    /** Check if a server has available capacity */
    hasCapacity(serverId) {
        const server = this.servers.find((s) => s.id === serverId);
        if (!server) return false;
        return (this.active.get(serverId) || 0) < (server.maxConcurrent || 1);
    }

    /** Queue for serializing slot acquisition */
    _acquireQueue = Promise.resolve();

    /** Atomically wait for capacity and acquire a slot — prevents race conditions */
    acquireSlot() {
        return new Promise((resolve) => {
            this._acquireQueue = this._acquireQueue.then(async () => {
                // Wait until some server has capacity
                while (true) {
                    // Pick least-loaded server with capacity
                    let best = null;
                    let bestLoad = Infinity;
                    for (const s of this.servers) {
                        const current = this.active.get(s.id) || 0;
                        const max = s.maxConcurrent || 1;
                        if (current < max) {
                            const load = current / max;
                            if (load < bestLoad) {
                                bestLoad = load;
                                best = s;
                            }
                        }
                    }
                    if (best) {
                        // Atomically acquire
                        this.active.set(best.id, (this.active.get(best.id) || 0) + 1);
                        const release = () => {
                            this.active.set(best.id, Math.max(0, (this.active.get(best.id) || 1) - 1));
                        };
                        resolve({ server: best, release });
                        return;
                    }
                    await new Promise((r) => setTimeout(r, 200));
                }
            });
        });
    }

    /** Health check all servers — returns models list for each */
    async checkAll() {
        const results = [];
        // Use allServers (don't require model for health check)
        for (const server of this.allServers) {
            try {
                const base = server.url.replace(/\/$/, "");
                let models = [];
                let ok = false;

                if (server.provider === "ollama") {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 5000);
                    const resp = await fetch(`${base}/api/tags`, { signal: controller.signal });
                    clearTimeout(timeout);
                    if (resp.ok) {
                        const data = await resp.json();
                        models = (data.models || []).map((m) => m.name || m.model);
                        ok = true;
                    }
                } else {
                    // OpenAI compatible
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 5000);
                    const url = base.includes("/v1") ? `${base}/models` : `${base}/v1/models`;
                    const resp = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeout);
                    if (resp.ok) {
                        const data = await resp.json();
                        models = (data.data || []).map((m) => m.id);
                        ok = true;
                    }
                }

                results.push({ ...server, ok, models });
            } catch (err) {
                results.push({ ...server, ok: false, error: err.message, models: [] });
            }
        }
        return results;
    }
}
