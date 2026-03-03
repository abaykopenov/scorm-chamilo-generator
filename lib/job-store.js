/**
 * Job Store — persistent storage for async generation jobs
 * Jobs are stored as JSON files in .data/jobs/
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const JOBS_DIR = path.join(process.cwd(), ".data", "jobs");

/** @typedef {"pending"|"running"|"completed"|"failed"|"cancelled"} JobStatus */

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {JobStatus} status
 * @property {number} progress       - 0 to 100
 * @property {string} currentStep    - human-readable current step
 * @property {Object[]} steps        - array of step results
 * @property {string|null} courseId   - resulting course ID
 * @property {string|null} error     - error message if failed
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Object} input          - original generation input
 */

export function createJob(id, input) {
    return {
        id,
        status: "pending",
        progress: 0,
        currentStep: "Ожидание...",
        steps: [],
        courseId: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        input
    };
}

function jobPath(jobId) {
    return path.join(JOBS_DIR, `${jobId}.json`);
}

export async function saveJob(job) {
    await mkdir(JOBS_DIR, { recursive: true });
    job.updatedAt = Date.now();
    await writeFile(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
    return job;
}

export async function getJob(jobId) {
    try {
        const raw = await readFile(jobPath(jobId), "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function listJobs() {
    try {
        await mkdir(JOBS_DIR, { recursive: true });
        const files = await readdir(JOBS_DIR);
        const jobs = [];
        for (const f of files) {
            if (!f.endsWith(".json")) continue;
            try {
                const raw = await readFile(path.join(JOBS_DIR, f), "utf8");
                jobs.push(JSON.parse(raw));
            } catch { /* skip corrupt */ }
        }
        return jobs.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
        return [];
    }
}

// In-memory event emitters for SSE
const listeners = new Map(); // jobId → Set<callback>

export function subscribeJob(jobId, callback) {
    if (!listeners.has(jobId)) listeners.set(jobId, new Set());
    listeners.get(jobId).add(callback);
    return () => listeners.get(jobId)?.delete(callback);
}

export function emitJobUpdate(job) {
    const cbs = listeners.get(job.id);
    if (cbs) {
        const data = {
            id: job.id,
            status: job.status,
            progress: job.progress,
            currentStep: job.currentStep,
            courseId: job.courseId,
            error: job.error,
            stepsCompleted: job.steps.length
        };
        for (const cb of cbs) cb(data);
    }
}
