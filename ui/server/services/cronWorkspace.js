import path from 'node:path';
import { resolveCronWorkspacePath } from '../../../src/cron/runtime/CronWorkspace.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { ensureGeneralWorkspaceDirectory } from '../utils/generalWorkspace.js';
import { resolveRegisteredProject } from './projectRegistration.js';

export function currentCronWorkspace(task, pilotHome = resolvePilotHome(process.env)) {
    return resolveCronWorkspacePath(task, path.resolve(pilotHome, 'cron', 'worktrees'));
}

/** File requests resolve the current destination without preparing or running a task. */
export function createCronWorkspaceResolver({ getGateway, env = process.env }) {
    return async taskId => {
        const gateway = await getGateway();
        const { tasks } = await gateway.cronList({ taskId });
        const task = tasks.find(item => item.taskId === taskId);
        if (!task) return null;
        const pilotHome = resolvePilotHome(env);
        const sourceRoot = path.resolve(task.projectKey) === path.resolve(pilotHome)
            // General settings affect new tasks; existing tasks retain their saved execution root.
            ? task.workspaceCwd || await ensureGeneralWorkspaceDirectory(env)
            : await resolveRegisteredProject(task.projectKey, pilotHome);
        return { root: currentCronWorkspace({ ...task, workspaceCwd: task.workspaceCwd || sourceRoot }, pilotHome),
            sourceRoot, worktree: task.workspaceMode === 'worktree' };
    };
}
