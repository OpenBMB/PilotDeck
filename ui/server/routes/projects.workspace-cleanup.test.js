import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../projects.js', () => ({ addProjectManually: vi.fn(), extractProjectDirectory: vi.fn() }));
vi.mock('../discovery-plans.js', () => ({
  getProjectDiscoveryContext: vi.fn(),
  getProjectDiscoveryPlansOverview: vi.fn(),
  getProjectDiscoveryPlanReport: vi.fn(),
  rerunDiscoveryPlan: vi.fn(),
  getProjectWorkCycles: vi.fn(),
  applyWorkCycle: vi.fn(),
  archiveWorkCycle: vi.fn(),
}));
// Simulates a GitHub credential that was deleted or deactivated after the
// wizard loaded its list: the lookup finds no active row.
vi.mock('../database/db.js', () => ({
  db: { prepare: () => ({ get: () => undefined }) },
}));

let baseDir;
let parentDir;
let siblingFile;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-clone-cleanup-'));
  parentDir = path.join(baseDir, 'dev');
  siblingFile = path.join(parentDir, 'other-project', 'important.txt');
  await fs.mkdir(path.dirname(siblingFile), { recursive: true });
  await fs.writeFile(siblingFile, 'keep me');
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('clone with a missing GitHub token', () => {
  it('GET /clone-progress keeps the existing parent directory', async () => {
    const handler = await loadRouteHandler('get', '/clone-progress');
    const events = [];
    const req = Object.assign(new EventEmitter(), {
      query: { path: parentDir, githubUrl: 'https://github.com/owner/repo', githubTokenId: '42' },
      user: { id: 1 },
    });
    const res = { setHeader() {}, flushHeaders() {}, write: (chunk) => events.push(chunk), end() {} };

    await handler(req, res);

    expect(events.join('')).toContain('GitHub token not found');
    await expect(fs.readFile(siblingFile, 'utf8')).resolves.toBe('keep me');
  });

  it('GET /clone-progress does not create a new workspace directory', async () => {
    const handler = await loadRouteHandler('get', '/clone-progress');
    const newWorkspace = path.join(baseDir, 'fresh');
    const req = Object.assign(new EventEmitter(), {
      query: { path: newWorkspace, githubUrl: 'https://github.com/owner/repo', githubTokenId: '42' },
      user: { id: 1 },
    });
    const res = { setHeader() {}, flushHeaders() {}, write() {}, end() {} };

    await handler(req, res);

    await expect(fs.access(newWorkspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('POST /create-workspace keeps the existing parent directory', async () => {
    const handler = await loadRouteHandler('post', '/create-workspace');
    const res = createJsonResponse();

    await handler({
      body: {
        workspaceType: 'new',
        path: parentDir,
        githubUrl: 'https://github.com/owner/repo',
        githubTokenId: 42,
      },
      user: { id: 1 },
    }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'GitHub token not found' });
    await expect(fs.readFile(siblingFile, 'utf8')).resolves.toBe('keep me');
  });
});

async function loadRouteHandler(method, routePath) {
  const router = (await import('./projects.js')).default;
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  return layer.route.stack.at(-1).handle;
}

function createJsonResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
