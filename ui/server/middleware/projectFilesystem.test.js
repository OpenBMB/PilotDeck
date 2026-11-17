// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createLocalGateway } from '../../../src/cli/createLocalGateway.js';
import { createCronManager, defaultCronConfig } from '../../../src/cron/index.js';
import { createProjectId } from '../../../src/pilot/paths.js';
import { createModelRuntime } from '../../../src/model/index.js';
import { SessionConfigOverrides } from '../../../src/always-on/runtime/SessionConfigOverrides.js';
import { createCronWorkspaceResolver } from '../services/cronWorkspace.js';
import { cronTaskOverview } from '../services/cronOverview.js';
import { projectFileIndex } from '../services/projectFileIndex.js';
import { ensureGeneralWorkspaceDirectory } from '../utils/generalWorkspace.js';
import { runWorkspaceFileOperation } from '../../../src/session/checkpoints/workspaceFileOperation.js';
import { createProjectFilesystemMiddleware } from './projectFilesystem.js';
import { isPathInsideOrEqual } from '../utils/pathSafety.js';
import { createWorkspaceFileUploadHandler, createWorkspaceUploadCheckHandler } from '../services/workspaceFileUpload.js';

let root, home, workspace, server, url, env, taskResolver;
const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');

// Mount the production handlers without starting the gateway, database or UI.
function mountReportedHandlers(app, authenticateToken, requireRealProjectFilesystem) {
    const indexRoute = "app.get('/api/projects/:projectName/files/index', authenticateToken, requireRealProjectFilesystem, projectFileIndex);";
    expect(source).toContain(indexRoute);
    new Function('app', 'authenticateToken', 'requireRealProjectFilesystem', 'projectFileIndex', indexRoute)(app, authenticateToken, requireRealProjectFilesystem, projectFileIndex);
    for (const [method, suffix] of [['get', 'file'], ['get', 'files/content'], ['put', 'file'], ['delete', 'files']]) {
        const start = source.indexOf(`app.${method}('/api/projects/:projectName/${suffix}',`);
        const end = source.indexOf('\n});', start) + '\n});'.length;
        expect(start).toBeGreaterThan(-1);
        const register = new Function('app', 'authenticateToken', 'requireRealProjectFilesystem', 'fsPromises', 'path', 'isPathInsideOrEqual', 'resolvePathInProject', 'validatePathInProject', 'mime', 'streamFileWithRange', 'crypto', 'mutateWorkspaceFile', source.slice(start, end));
        const helper = name => {
            const start = source.indexOf(`function ${name}(`);
            const end = source.indexOf('\n}', start) + 2;
            return new Function('path', 'isPathInsideOrEqual', `${source.slice(start, end)}; return ${name};`)(path, isPathInsideOrEqual);
        };
        register(app, authenticateToken, requireRealProjectFilesystem, fs, path, isPathInsideOrEqual, helper('resolvePathInProject'), helper('validatePathInProject'),
            { lookup: () => 'application/octet-stream' }, async (_req, res, target) => res.send(await fs.readFile(target)), crypto,
            (projectRoot, operation) => runWorkspaceFileOperation(projectRoot, home, operation));
    }
}

beforeEach(async () => {
    taskResolver = null;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reported-project-injection-'));
    home = path.join(root, 'state');
    workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(home, 'projects', 'demo'), { recursive: true });
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(home, 'projects/demo/.cwd'), workspace);
    await fs.writeFile(path.join(home, 'auth.db'), 'fake-auth-database');
    await fs.writeFile(path.join(home, 'server-token'), 'fake-server-token');
    await fs.writeFile(path.join(workspace, 'normal.txt'), 'normal');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    const authenticateToken = (req, res, next) => req.headers.authorization === 'Bearer test' ? next() : res.sendStatus(401);
    env = { PILOT_HOME: home };
    const guard = createProjectFilesystemMiddleware({ env, resolveTaskWorkspace: async id => {
      if (taskResolver) return taskResolver(id);
      if (id === 'local') return { root: workspace, sourceRoot: workspace };
      if (id === 'owned') return { root: path.join(home, 'cron/worktrees/owned'), sourceRoot: workspace, worktree: true };
      if (id === 'outside') return { root, sourceRoot: workspace };
      if (id === 'forbidden') return { root: home, sourceRoot: workspace, worktree: true };
      if (id === 'symlink') return { root: path.join(home, 'cron/worktrees/symlink'), sourceRoot: workspace, worktree: true };
      return null;
    } });
    mountReportedHandlers(app, authenticateToken, guard);
    const resolveProject = () => { throw new Error('Upload must use the root authorized by middleware'); };
    app.post('/api/projects/:projectName/files/upload/check', authenticateToken, guard, createWorkspaceUploadCheckHandler({ resolveProject }));
    app.post('/api/projects/:projectName/files/upload', authenticateToken, guard, createWorkspaceFileUploadHandler({ resolveProject }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}/api/projects/`;
});
afterEach(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
});
const request = (name, suffix, method = 'GET', body) => fetch(`${url}${encodeURIComponent(name)}${suffix}`, {
    method, headers: { Authorization: 'Bearer test', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
});

describe('reported project root injection', () => {
    it('rejects unauthenticated access and unregistered absolute/dash roots for read, download, write, delete and upload', async () => {
        expect((await fetch(`${url}${encodeURIComponent(root)}/file?filePath=state/server-token`)).status).toBe(401);
        for (const name of ['/root', '/etc', root, '-root', '-etc', 'unknown']) {
            for (const args of [
                ['/file?filePath=state/server-token'], ['/files/content?path=state/auth.db'], ['/files/index'],
                ['/file', 'PUT', { filePath: 'marker', content: 'changed' }],
                ['/files', 'DELETE', { path: 'marker' }],
                ['/files/upload/check', 'POST', { relativePaths: ['marker'] }],
            ]) {
                const response = await request(name, ...args);
                expect(response.status).toBe(404);
                expect((await response.json()).error.code).toBe('PROJECT_NOT_FOUND');
            }
            const form = new FormData();
            form.append('files', new Blob(['changed']), 'marker');
            expect((await fetch(`${url}${encodeURIComponent(name)}/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form })).status).toBe(404);
        }
        expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-auth-database');
        expect(await fs.readFile(path.join(home, 'server-token'), 'utf8')).toBe('fake-server-token');
        await expect(fs.access(path.join(root, 'marker'))).rejects.toThrow();
    });

    it('rejects registered PILOT_HOME, descendants and parents', async () => {
        for (const [id, location] of [['parent', root], ['home', home], ['child', path.join(home, 'projects')]]) {
            await fs.mkdir(path.join(home, 'projects', id));
            await fs.writeFile(path.join(home, 'projects', id, '.cwd'), location);
            for (const suffix of ['/file?filePath=state/server-token', '/files/content?path=auth.db']) {
                const response = await request(id, suffix);
                expect(response.status).toBe(403);
                expect((await response.json()).error.code).toBe('PROJECT_PATH_FORBIDDEN');
            }
        }
        expect((await request('general', '/file?filePath=server-token')).status).toBe(403);
    });

    it.each([false, true])('rejects canonical home overlaps with a symlinked PILOT_HOME=%s', async (aliasHome) => {
        if (aliasHome) {
            const homeAlias = path.join(root, 'configured-home-alias');
            await fs.symlink(home, homeAlias, process.platform === 'win32' ? 'junction' : 'dir');
            env.PILOT_HOME = homeAlias;
        }
        for (const [id, location] of [['parent', root], ['home', home], ['child', path.join(home, 'projects')]]) {
            const alias = path.join(root, `${id}-alias`);
            await fs.symlink(location, alias, process.platform === 'win32' ? 'junction' : 'dir');
            await fs.mkdir(path.join(home, 'projects', id));
            await fs.writeFile(path.join(home, 'projects', id, '.cwd'), aliasHome ? location : alias);
            for (const args of [
                ['/file?filePath=server-token'], ['/files/content?path=auth.db'],
                ['/file', 'PUT', { filePath: 'server-token', content: 'changed' }],
                ['/files', 'DELETE', { path: 'server-token' }],
                ['/files/upload/check', 'POST', { relativePaths: ['marker'] }],
            ]) {
                const response = await request(id, ...args);
                expect(response.status).toBe(403);
                expect((await response.json()).error.code).toBe('PROJECT_PATH_FORBIDDEN');
            }
            const form = new FormData();
            form.append('files', new Blob(['changed']), 'marker');
            expect((await fetch(`${url}${id}/files/upload`, {
                method: 'POST', headers: { Authorization: 'Bearer test' }, body: form,
            })).status).toBe(403);
        }
        expect(await fs.readFile(path.join(home, 'server-token'), 'utf8')).toBe('fake-server-token');
        expect(await fs.readFile(path.join(home, 'auth.db'), 'utf8')).toBe('fake-auth-database');
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(200);
    });

    it('allows registered symlink aliases of ordinary workspaces', async () => {
        const alias = path.join(root, 'workspace-alias');
        await fs.symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
        await fs.writeFile(path.join(home, 'projects/demo/.cwd'), alias);
        expect((await (await request('demo', '/file?filePath=normal.txt')).json()).content).toBe('normal');
        expect((await request('demo', '/file', 'PUT', { filePath: 'normal.txt', content: 'edited' })).status).toBe(200);
        expect(await fs.readFile(path.join(workspace, 'normal.txt'), 'utf8')).toBe('edited');
    });

    it('keeps legitimate project read, download, write, delete and upload behavior', async () => {
        expect((await (await request('demo', '/file?filePath=normal.txt')).json()).content).toBe('normal');
        expect(await (await request(workspace, '/files/content?path=normal.txt')).text()).toBe('normal');
        expect((await request('demo', '/file', 'PUT', { filePath: 'normal.txt', content: 'edited' })).status).toBe(200);
        expect(await fs.readFile(path.join(workspace, 'normal.txt'), 'utf8')).toBe('edited');
        expect((await request('demo', '/files/upload/check', 'POST', { relativePaths: ['new.txt'] })).status).toBe(200);
        const form = new FormData();
        form.append('files', new Blob(['upload']), 'new.txt');
        expect((await fetch(`${url}demo/files/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form })).status).toBe(200);
        expect(await fs.readFile(path.join(workspace, 'new.txt'), 'utf8')).toBe('upload');
        expect((await request('demo', '/files', 'DELETE', { path: 'new.txt' })).status).toBe(200);
        await expect(fs.access(path.join(workspace, 'new.txt'))).rejects.toThrow();
    });

    it('revalidates registrations and rejects missing workspaces', async () => {
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(200);
        await fs.rm(path.join(home, 'projects/demo'), { recursive: true });
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(404);
        await fs.mkdir(path.join(home, 'projects/demo'));
        await fs.writeFile(path.join(home, 'projects/demo/.cwd'), path.join(root, 'missing'));
        expect((await request('demo', '/file?filePath=normal.txt')).status).toBe(404);
    });

    it('round-trips an 11 MB CSV over the save route while rejecting stale content', async () => {
        const original = 'a'.repeat(11 * 1024 * 1024), updated = original.slice(0, -1) + 'b';
        await fs.writeFile(path.join(workspace, 'large.csv'), original);
        const loaded = await (await request('demo', '/file?filePath=large.csv')).json();
        expect(loaded.hash).toBe(crypto.createHash('sha256').update(original).digest('hex'));
        expect((await request('demo', '/file', 'PUT', { filePath: 'large.csv', content: updated, expectedHash: loaded.hash })).status).toBe(200);
        expect(await fs.readFile(path.join(workspace, 'large.csv'), 'utf8')).toBe(updated);
        expect((await request('demo', '/file', 'PUT', { filePath: 'large.csv', content: original, expectedHash: loaded.hash })).status).toBe(409);
        expect(await fs.readFile(path.join(workspace, 'large.csv'), 'utf8')).toBe(updated);
    });

    it('saves through a file symlink without replacing it', async (context) => {
        const alias = path.join(workspace, 'alias.txt');
        try { await fs.symlink(path.join(workspace, 'normal.txt'), alias, 'file'); }
        catch (error) { if (error.code === 'EPERM') { context.skip('File symlinks require Windows Developer Mode or a privileged token.'); return; } throw error; }
        const loaded = await (await request('demo', '/file?filePath=alias.txt')).json();
        expect((await request('demo', '/file', 'PUT', { filePath: 'alias.txt', content: 'linked edit', expectedHash: loaded.hash })).status).toBe(200);
        expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(workspace, 'normal.txt'), 'utf8')).toBe('linked edit');
    });

    it('wires every project file route to the guard and uses only its resolved root', () => {
        const fileRoutes = source.match(/app\.(?:get|put|post|delete)\('\/api\/projects\/:projectName\/(?:file(?:'|s[/'\w]*')|preview\/\*'|download')[^\n]*/g);
        expect(fileRoutes.length).toBe(16);
        for (const route of fileRoutes) expect(route).toContain('authenticateToken, requireRealProjectFilesystem');
        const start = source.indexOf('// Read file content endpoint');
        const end = source.indexOf("app.post('/api/projects/:projectName/files/upload',", start);
        const handlers = source.slice(start, end);
        expect(handlers).not.toContain('extractProjectDirectory(');
        expect(handlers).not.toContain('Fallback to simple dash replacement');
    });
});


it('resolves only trusted task roots for General and owned worktree files', async () => {
    expect((await request('cron-task:missing', '/file?filePath=normal.txt')).status).toBe(404);
    expect((await request('cron-task:local', '/file?filePath=normal.txt')).status).toBe(200);
    expect((await request('cron-task:local', '/file?filePath=../state/server-token')).status).toBe(403);
    expect((await request('cron-task:outside', '/file?filePath=state/server-token')).status).toBe(403);
    expect((await request('cron-task:forbidden', '/file?filePath=server-token')).status).toBe(403);
    const owned = path.join(home, 'cron/worktrees/owned');
    await fs.mkdir(owned, { recursive: true });
    await fs.writeFile(path.join(owned, 'report.txt'), 'owned task result');
    const read = await request('cron-task:owned', '/file?filePath=report.txt');
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe('owned task result');
    expect((await request('cron-task:owned', '/file?filePath=../../../server-token')).status).toBe(403);
    await fs.symlink(home, path.join(home, 'cron/worktrees/symlink'), 'dir');
    expect((await request('cron-task:symlink', '/file?filePath=server-token')).status).toBe(403);
    for (const [id, status] of [['missing', 404], ['outside', 403], ['forbidden', 403], ['symlink', 403]]) {
        expect((await request(`cron-task:${id}`, '/files/index')).status).toBe(status);
    }
    expect((await fetch(`${url}cron-task%3Aowned/files/index`)).status).toBe(401);
    await fs.symlink(home, path.join(owned, 'escape'), 'dir');
    const page = await (await request('cron-task:owned', '/files/index?projectKey=' + encodeURIComponent(home))).json();
    expect(page.projectKey).toBe(await fs.realpath(owned));
    expect(page.items.map(item => item.relativePath)).toEqual(['report.txt']);
    expect((await request('cron-task:owned', '/files/index?limit=0')).status).toBe(400);
    expect((await request('cron-task:owned', '/files/index?cursor=invalid')).status).toBe(400);
});

it('keeps task file-index pagination and queries scoped to the trusted workspace', async () => {
    const owned = path.join(home, 'cron/worktrees/owned');
    await fs.mkdir(owned, { recursive: true });
    for (const name of ['alpha.md', 'beta.md']) await fs.writeFile(path.join(owned, name), name);
    const first = await (await request('cron-task:owned', '/files/index?limit=1')).json();
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const second = await (await request('cron-task:owned', '/files/index?limit=1&cursor=' + encodeURIComponent(first.nextCursor))).json();
    expect([...first.items, ...second.items].map(item => item.relativePath).sort()).toEqual(['alpha.md', 'beta.md']);
    expect((await request('cron-task:local', '/files/index?cursor=' + encodeURIComponent(first.nextCursor))).status).toBe(400);
    const matched = await (await request('cron-task:owned', '/files/index?query=beta&includeDirs=false')).json();
    expect(matched.items.map(item => item.relativePath)).toEqual(['beta.md']);
    expect(matched.items[0].matches).toEqual(expect.arrayContaining([expect.objectContaining({ start: 0, end: 4 })]));
});

it('keeps a General task authorized in its saved execution directory after settings change and restart', async () => {
    const canonicalRoot = await fs.realpath(root);
    env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY = path.join(canonicalRoot, 'general-a');
    const generalA = await ensureGeneralWorkspaceDirectory(env);
    await fs.writeFile(path.join(generalA, 'report.md'), 'Task report in A');
    const gateway = { closeSession: async () => {}, async *submitTurn() { throw new Error('File requests must not execute a model turn'); } };
    let manager = createCronManager({ config: defaultCronConfig(), pilotHome: home });
    manager.bindGateway(gateway);
    taskResolver = createCronWorkspaceResolver({ getGateway: () => ({ cronList: input => manager.listTasks(input) }), env });
    try {
        const task = (await manager.createTask({ name: 'Pinned General report', message: 'Report in the saved workspace',
            projectKey: 'general', workspaceCwd: generalA, schedule: { type: 'once', runAt: '2030-01-01T00:00:00Z' } })).task;
        const id = `cron-task:${task.taskId}`;
        const verifyFiles = async () => {
            const prepared = await manager.prepareConversation({ sessionKey: task.sessionKey, projectKey: home });
            expect(await fs.realpath(prepared.workspaceCwd)).toBe(await fs.realpath(generalA));
            const pageResponse = await request(id, '/files/index');
            expect(pageResponse.status).toBe(200);
            const page = await pageResponse.json();
            expect(page.projectKey).toBe(await fs.realpath(generalA));
            expect(page.items.map(item => item.relativePath)).toContain('report.md');
            const preview = await request(id, '/file?filePath=report.md');
            expect(preview.status).toBe(200); expect((await preview.json()).content).toBe('Task report in A');
            const download = await request(id, '/files/content?path=report.md&download=1');
            expect(download.status).toBe(200); expect(await download.text()).toBe('Task report in A');
            expect((await request(id, '/file?filePath=' + encodeURIComponent(path.join(home, 'auth.db')))).status).toBe(403);
        };
        await verifyFiles();
        env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY = path.join(canonicalRoot, 'general-b');
        const generalB = await ensureGeneralWorkspaceDirectory(env);
        await fs.writeFile(path.join(generalB, 'report.md'), 'New General report in B');
        await verifyFiles();
        expect((await request(id, '/file?filePath=' + encodeURIComponent(path.join(generalB, 'report.md')))).status).toBe(403);
        await manager.stop();
        manager = createCronManager({ config: defaultCronConfig(), pilotHome: home });
        manager.bindGateway(gateway);
        await manager.start();
        await verifyFiles();
        expect((await manager.listTasks({ taskId: task.taskId })).tasks[0].lastRun).toBeUndefined();
        expect(await fs.readFile(path.join(generalB, 'report.md'), 'utf8')).toBe('New General report in B');
        await fs.rm(generalA, { recursive: true });
        expect((await request(id, '/files/index')).status).toBe(404); // Never silently redirect old tasks to B.
        await fs.symlink(home, generalA, process.platform === 'win32' ? 'junction' : 'dir');
        expect((await request(id, '/files/index')).status).toBe(403);
    } finally { await manager.stop(); }
});

it('previews files from task chat before its first worktree execution and follows the current workspace', async () => {
    const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
    git('init'); git('config', 'user.name', 'Task QA'); git('config', 'user.email', 'task@example.invalid');
    await fs.writeFile(path.join(workspace, 'report.txt'), 'Source report');
    git('add', '.'); git('commit', '-m', 'Fixture');
    await fs.writeFile(path.join(workspace, 'source-only.md'), 'Uncommitted source file');
    const registered = path.join(home, 'projects', createProjectId(workspace));
    await fs.mkdir(registered, { recursive: true }); await fs.writeFile(path.join(registered, '.cwd'), workspace);
    const skills = path.join(root, 'skills'); await fs.mkdir(skills);
    const configPath = path.join(home, 'pilotdeck.yaml');
    await fs.writeFile(configPath, `schemaVersion: 1
agent: { model: test/model }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: synthetic
      models: { model: {} }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
runtime: { python: { enabled: false } }
memory: { enabled: false }
telemetry: { enabled: false }
`);
    const sessionOverrides = new SessionConfigOverrides();
    const cron = createCronManager({ config: defaultCronConfig(), pilotHome: home, sessionOverrides });
    let calls = 0, writtenCwd;
    const local = createLocalGateway({ pilotHome: home, projectRoot: workspace, builtinSkillsRoot: skills,
        env: { ...env, PILOTDECK_CONFIG_PATH: configPath }, cron, sessionOverrides,
        extraTools: [{ name: 'write_report', kind: 'filesystem', description: 'Write the synthetic task report',
            inputSchema: { type: 'object', properties: {} }, isReadOnly: () => false,
            execute: async (_input, context) => { writtenCwd = context.cwd;
                await fs.writeFile(path.join(context.cwd, 'worktree-only.md'), 'Task report context');
                await fs.writeFile(path.join(context.cwd, 'report.txt'), 'Task chat report'); return { content: [] }; } }],
        __testModelFactory(snapshot) { return { ...createModelRuntime(snapshot.config.model), async *stream() {
            yield { type: 'message_start', role: 'assistant' };
            if (++calls === 1) {
                const toolCall = { id: 'writer', name: 'write_report', input: {} };
                yield { type: 'tool_call_start', id: toolCall.id, name: toolCall.name };
                yield { type: 'tool_call_end', toolCall }; yield { type: 'message_end', finishReason: 'tool_call' };
            } else { yield { type: 'text_delta', text: 'Report ready' }; yield { type: 'message_end', finishReason: 'stop' }; }
        } }; },
    });
    cron.bindGateway(local.gateway);
    taskResolver = createCronWorkspaceResolver({ getGateway: () => local.gateway, env });
    try {
        const task = (await cron.createTask({ name: 'Report', message: 'Prepare a report', projectKey: workspace,
            mode: 'bypassPermissions', workspaceMode: 'worktree', schedule: { type: 'once', runAt: new Date(Date.now() + 3600000).toISOString() } })).task;
        const id = `cron-task:${task.taskId}`;
        expect((await request(id, '/file?filePath=report.txt')).status).toBe(404);
        expect((await request(id, '/files/index')).status).toBe(404);
        await expect(fs.access(path.join(home, 'cron/worktrees', task.taskId))).rejects.toThrow();
        for await (const _ of local.gateway.submitTurn({ sessionKey: task.sessionKey, projectKey: workspace,
            channelKey: 'web', mode: 'bypassPermissions', message: 'Generate the report' })) { /* Consume the actual tool turn. */ }
        const current = (await local.gateway.cronList({ taskId: task.taskId, includeHistory: true }));
        expect(current.tasks[0].lastRun).toBeUndefined();
        expect(current.recentRuns).toEqual([]);
        expect(writtenCwd).toBe(path.join(home, 'cron', 'worktrees', task.taskId));
        expect(cronTaskOverview(current.tasks[0], null, home).workspaceCwd).toBe(writtenCwd);
        const fileNames = async () => (await (await request(id, '/files/index')).json()).items.map(item => item.relativePath);
        expect(await fileNames()).toContain('worktree-only.md');
        expect(await fileNames()).not.toContain('source-only.md');
        for (const filePath of ['report.txt', path.join(writtenCwd, 'report.txt')]) {
            const loaded = await request(id, '/file?filePath=' + encodeURIComponent(filePath));
            expect(loaded.status).toBe(200); expect((await loaded.json()).content).toBe('Task chat report');
            expect(await (await request(id, '/files/content?path=' + encodeURIComponent(filePath))).text()).toBe('Task chat report');
        }
        expect((await request(id, '/file?filePath=' + encodeURIComponent(path.join(home, 'auth.db')))).status).toBe(403);
        await cron.updateTask({ ...task, taskId: task.taskId, expectedRevision: current.tasks[0].revision, workspaceMode: 'local' });
        expect(await fileNames()).toContain('source-only.md');
        expect(await fileNames()).not.toContain('worktree-only.md');
        expect((await (await request(id, '/file?filePath=report.txt')).json()).content).toBe('Source report');
        expect(await fs.readFile(path.join(workspace, 'report.txt'), 'utf8')).toBe('Source report');
    } finally { await cron.stop(); local.dispose(); }
});
