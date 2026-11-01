import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveRegisteredProject } from '../services/projectRegistration.js';
import { isPathInsideOrEqual } from '../utils/pathSafety.js';
import { isVirtualProjectPath, resolvePilotHome } from '../utils/pilotPaths.js';

export function createProjectFilesystemMiddleware({ env = process.env } = {}) {
    return async (req, res, next) => {
        try {
            const pilotHome = resolvePilotHome(env);
            // Never authorize a project root using request-derived paths or the
            // presentation cache populated by getProjects().
            const projectRoot = await resolveRegisteredProject(req.params.projectName, pilotHome);
            const [realProjectRoot, realPilotHome] = await Promise.all([
                realpath(projectRoot),
                realpath(pilotHome),
            ]);
            if (
                isVirtualProjectPath(projectRoot, pilotHome, env)
                || isPathInsideOrEqual(pilotHome, projectRoot)
                || isPathInsideOrEqual(projectRoot, pilotHome)
                || isPathInsideOrEqual(realPilotHome, realProjectRoot)
                || isPathInsideOrEqual(realProjectRoot, realPilotHome)
            ) {
                return res.status(403).json({
                    error: { code: 'PROJECT_PATH_FORBIDDEN', message: 'Project file operations are unavailable for this path.' },
                });
            }
            if (!(await stat(projectRoot)).isDirectory()) {
                throw Object.assign(new Error('Project not found'), { code: 'PROJECT_NOT_FOUND' });
            }
            req.projectRoot = path.resolve(projectRoot);
            return next();
        } catch (error) {
            if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
            }
            return next(error);
        }
    };
}
