// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runWorkspaceFileOperation } from '../../../src/session/checkpoints/workspaceFileOperation.js';
import { createProjectFilesystemMiddleware } from './projectFilesystem.js';
import { isPathInsideOrEqual } from '../utils/pathSafety.js';
import { createWorkspaceFileUploadHandler, createWorkspaceUploadCheckHandler } from '../services/workspaceFileUpload.js';

let root, home, workspace, server, url, env;
const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');

// Mount the production handlers without starting the gateway, database or UI.
function mountReportedHandlers(app, authenticateToken, requireRealProjectFilesystem) {
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
    const guard = createProjectFilesystemMiddleware({ env });
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
                ['/file?filePath=state/server-token'], ['/files/content?path=state/auth.db'],
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
            await fs.symlink(home, homeAlias, 'dir');
            env.PILOT_HOME = homeAlias;
        }
        for (const [id, location] of [['parent', root], ['home', home], ['child', path.join(home, 'projects')]]) {
            const alias = path.join(root, `${id}-alias`);
            await fs.symlink(location, alias, 'dir');
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
        await fs.symlink(workspace, alias, 'dir');
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

    it('saves through a file symlink without replacing it', async () => {
        const alias = path.join(workspace, 'alias.txt');
        await fs.symlink(path.join(workspace, 'normal.txt'), alias, 'file');
        const loaded = await (await request('demo', '/file?filePath=alias.txt')).json();
        expect((await request('demo', '/file', 'PUT', { filePath: 'alias.txt', content: 'linked edit', expectedHash: loaded.hash })).status).toBe(200);
        expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(workspace, 'normal.txt'), 'utf8')).toBe('linked edit');
    });

    it('wires every project file route to the guard and uses only its resolved root', () => {
        const fileRoutes = source.match(/app\.(?:get|put|post|delete)\('\/api\/projects\/:projectName\/(?:file(?:'|s[/'\w]*')|preview\/\*'|download')[^\n]*/g);
        expect(fileRoutes.length).toBe(15);
        for (const route of fileRoutes) expect(route).toContain('authenticateToken, requireRealProjectFilesystem');
        const start = source.indexOf('// Read file content endpoint');
        const end = source.indexOf("app.post('/api/projects/:projectName/files/upload',", start);
        const handlers = source.slice(start, end);
        expect(handlers).not.toContain('extractProjectDirectory(');
        expect(handlers).not.toContain('Fallback to simple dash replacement');
    });
});
