/**
 * Pure-JS port of the path helpers from `src/pilot/paths.ts`.
 *
 * Lets `ui/server/` resolve `~/.pilotdeck` and encode project IDs the
 * same way the gateway server does, WITHOUT pulling `dist/src/pilot/`
 * into the express bridge. Keeping the math here means the UI server
 * can run from source without needing the TypeScript output to exist
 * on disk first.
 *
 * Keep this in sync with `src/pilot/paths.ts` — both must round-trip
 * identically or `~/.pilotdeck/projects/<id>/.cwd` markers written by
 * the bridge will not be found by `gateway.listProjects()` and vice
 * versa.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const DEFAULT_PILOT_HOME = '~/.pilotdeck';

function normalizeHomePath(p) {
    if (p === '~') return homedir();
    if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
    return resolve(p);
}

/**
 * Resolve the active PilotDeck home directory. Honors `PILOT_HOME` so
 * tests / multi-instance setups can isolate state. Defaults to
 * `~/.pilotdeck`.
 *
 * @param {Record<string, string | undefined>} [env] Environment to read.
 * @returns {string} Absolute path.
 */
export function resolvePilotHome(env = process.env) {
    return normalizeHomePath(env.PILOT_HOME ?? DEFAULT_PILOT_HOME);
}

/**
 * Encode an absolute project path into the on-disk project ID used
 * under `~/.pilotdeck/projects/<id>/`. Lossy — both `/` and literal
 * `-` collapse to `-`, so two different absolute paths can produce the
 * same ID; we work around that by writing a `.cwd` marker that records
 * the original path verbatim.
 *
 * @param {string} projectRoot Absolute filesystem path.
 * @returns {string} Encoded project ID.
 */
export function createProjectId(projectRoot) {
    const normalizedRoot = resolve(projectRoot);
    return (
        normalizedRoot.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
        'project'
    );
}
