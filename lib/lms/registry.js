/**
 * LMS Adapter Registry
 *
 * Central place that knows about all available LMS adapters.
 * API routes and services call `getAdapter(id)` to get the right one.
 *
 * Adding a new LMS:
 *   1. Create `lib/lms/your-adapter.js` extending LmsAdapter
 *   2. Import and register it in the `adapters` map below
 *   3. Done! The UI dropdown and API routes will pick it up automatically.
 */
import { ChamiloAdapter } from "./chamilo-adapter.js";
import { MoodleAdapter } from "./moodle-adapter.js";

/** @type {Map<string, import("./adapter.js").LmsAdapter>} */
const adapters = new Map();

// ── Register all known adapters ────────────────────────────────────────────
const chamilo = new ChamiloAdapter();
const moodle = new MoodleAdapter();

adapters.set(chamilo.id, chamilo);
adapters.set(moodle.id, moodle);

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get an adapter by its id (e.g. "chamilo", "moodle").
 * Falls back to Chamilo for backward compatibility.
 *
 * @param {string} [id]
 * @returns {import("./adapter.js").LmsAdapter}
 */
export function getAdapter(id) {
  if (!id) return chamilo;
  const adapter = adapters.get(id.toLowerCase().trim());
  if (!adapter) {
    throw new Error(
      `Unknown LMS adapter "${id}". Available: ${[...adapters.keys()].join(", ")}`
    );
  }
  return adapter;
}

/**
 * List all registered adapters for the UI dropdown.
 *
 * @returns {Array<{id: string, label: string}>}
 */
export function listAdapters() {
  return [...adapters.values()].map((adapter) => ({
    id: adapter.id,
    label: adapter.label
  }));
}

/**
 * Check if an adapter id is valid and registered.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function hasAdapter(id) {
  return adapters.has((id || "").toLowerCase().trim());
}
