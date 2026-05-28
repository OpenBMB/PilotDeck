import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePilotHome, createProjectId } from '../utils/pilotPaths.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

/**
 * Read phase events from a single project's events.jsonl.
 *
 * @param {string} projectDir Absolute path to the project's always-on dir
 *   (e.g. `~/.pilotdeck/always-on/projects/<id>`)
 * @returns {Array<object>}
 */
async function readProjectEvents(projectDir) {
    const eventsFile = resolve(projectDir, 'events.jsonl');
    let raw;
    try {
        raw = await readFile(eventsFile, 'utf-8');
    } catch {
        return [];
    }
    const events = [];
    for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            // skip malformed
        }
    }
    return events;
}

/**
 * Build a lookup from projectKey -> { projectName, projectDisplayName }.
 */
async function buildProjectLookup() {
    const gateway = await getPilotDeckGateway();
    const { projects } = await gateway.listProjects();
    const lookup = new Map();
    for (const project of projects) {
        const key = resolve(project.projectKey ?? project.fullPath ?? '');
        if (!key) continue;
        const name = createProjectId(key);
        const displayName = project.displayName || key.split(/[\\/]/).pop() || name;
        lookup.set(key, { projectName: name, projectDisplayName: displayName });
    }
    return lookup;
}

/**
 * Aggregate Always-On phase events across all projects.
 *
 * @param {{ limit?: number; since?: string }} [opts]
 * @returns {Promise<{ events: Array<object> }>}
 */
export async function getAlwaysOnDashboardEvents(opts = {}) {
    const { limit = 200, since } = opts;
    const pilotHome = resolvePilotHome();
    const projectsDir = resolve(pilotHome, 'always-on', 'projects');

    let projectDirs;
    try {
        projectDirs = await readdir(projectsDir, { withFileTypes: true });
    } catch {
        return { events: [] };
    }

    const lookup = await buildProjectLookup().catch(() => new Map());

    const allEvents = [];
    for (const entry of projectDirs) {
        if (!entry.isDirectory()) continue;
        const dir = resolve(projectsDir, entry.name);
        const events = await readProjectEvents(dir);
        allEvents.push(...events);
    }

    let filtered = allEvents;

    if (since) {
        const sinceMs = Date.parse(since);
        if (Number.isFinite(sinceMs)) {
            filtered = filtered.filter((e) => Date.parse(e.timestamp) >= sinceMs);
        }
    }

    filtered.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    if (limit > 0) {
        filtered = filtered.slice(0, limit);
    }

    const events = filtered.map((event) => {
        const key = resolve(event.projectKey || '');
        const info = lookup.get(key) || {
            projectName: createProjectId(key || 'unknown'),
            projectDisplayName: key.split(/[\\/]/).pop() || 'Unknown',
        };
        return {
            ...event,
            projectName: info.projectName,
            projectDisplayName: info.projectDisplayName,
        };
    });

    return { events };
}
