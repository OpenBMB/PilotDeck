// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const gateway = vi.hoisted(() => ({ reloadExtensions: vi.fn(async () => ({})), listProjects: vi.fn(async () => ({ projects: [] })),
  closeProjectSessions: vi.fn(async () => ({})),
  listSessions: vi.fn(async () => ({ sessions: [] })), describeProject: vi.fn(async () => ({ sessionCount: 0 })) }));
vi.mock('../pilotdeck-bridge.js', () => ({ getPilotDeckGateway: async () => gateway,
  withPilotDeckGatewayReadRetry: async call => call(gateway), beginProjectDeletion: () => () => {},
  beginSessionDeletion: () => () => {}, isGatewayUnavailableError: () => false }));
vi.mock('../database/db.js', () => ({ applyCustomSessionNames: () => {} }));
vi.mock('child_process', async original => ({ ...(await original()), spawn: (_command, args) => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
  void mkdir(args.at(-1), { recursive: true }).then(() => child.emit('close', 0)); return child;
} }));
import projectsRouter from './projects.js';
import { createModuleRuntimeRouter } from './modules.js';
import { getProjects, clearProjectDirectoryCache, deleteProject } from '../projects.js';
const cleanups = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); clearProjectDirectoryCache(); await Promise.all(cleanups.splice(0).map(fn => fn())); });
it('registers all three entries, preserves failed projects, and never provisions during listing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pd-registration-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), existing = join(root, 'existing'); await mkdir(existing);
  await mkdir(home);
  await import('node:fs/promises').then(fs => fs.writeFile(join(home, 'pilotdeck.yaml'),
    'agent: {model: test/model}\nmodel:\n  providers:\n    test:\n      protocol: openai\n      url: http://example.test/v1\n      apiKey: test\n      models: {model: {}}\n'));
  const key = 'sd_live_registration_test_key';
  for (const [name, value] of Object.entries({ PILOT_HOME: home, WORKSPACES_ROOT: root,
    PILOTDECK_CONFIG_PATH: join(home, 'pilotdeck.yaml'), STAFFDECK_PROJECT_BINDING_ENABLED: 'true',
    STAFFDECK_FORMAL_API_ORIGIN: 'http://sd.test', STAFFDECK_COPY_TENANT_ID: 'tenant',
    STAFFDECK_COPY_ACTOR_USER_ID: 'actor', STAFFDECK_COPY_PILOTDECK_USER_ID: '1',
    STAFFDECK_COPY_USER_TOKEN: 'token', STAFFDECK_SOP_MANAGEMENT_API_KEY: key,
    STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID: 'credential', STAFFDECK_SOP_RUNTIME_ORIGIN: 'http://sop.test' })) vi.stubEnv(name, value);
  const nativeFetch = globalThis.fetch, targets = new Map(); let unavailable = false;
  let jobAgent = 'agent-0', cancellations = 0;
  vi.stubGlobal('fetch', async (url, options) => {
    if (!String(url).startsWith('http://sd.test')) return nativeFetch(url, options);
    if (unavailable) throw new Error('SD timed out');
    const path = new URL(url).pathname;
    if (path === '/api/v1/jobs/task') return Response.json({ id: 'task', agent_id: jobAgent, status: 'running' });
    if (path === '/api/v1/jobs/task:cancel') { cancellations++; return Response.json({ id: 'task', status: 'cancel_requested' }); }
    if (path === '/api/auth/me') return Response.json({ id: 'actor', tenant_id: 'tenant' });
    if (path === '/api/auth/me/api-credentials') return Response.json([{ id: 'credential', user_id: 'actor', status: 'active',
      access: 'user_full_access', key_prefix: key.slice(0, 20) + '…',
      scopes: ['agents:read', 'agents:write', 'knowledge:read', 'knowledge:write', 'sops:read', 'sops:write', 'sops:publish', 'sops:cancel'] }]);
    if (path.endsWith('agents:ensure-project-binding')) {
      const body = JSON.parse(options.body);
      if (!targets.has(body.project_binding_id)) targets.set(body.project_binding_id, 'agent-' + targets.size);
      return Response.json({ ...body, agent: { id: targets.get(body.project_binding_id) } });
    }
    return Response.json({ id: path.split('/').at(-1), name: 'Agent', is_overall: false, status: 'active' });
  });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 1 }; next(); }); app.use('/api/projects', projectsRouter);
  app.use('/api/modules', createModuleRuntimeRouter({ loadConfig: () => ({}), getGateway: async () => gateway }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const register = async body => {
    const response = await fetch(origin + '/api/projects/create-workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return (await response.json()).project;
  };
  const a = await register({ workspaceType: 'new', path: join(root, 'new') });
  const b = await register({ workspaceType: 'existing', path: existing });
  const c = await register({ workspaceType: 'new', path: join(root, 'clones'), githubUrl: 'https://github.com/example/repo.git' });
  expect([a, b, c].every(p => p.staffdeckBinding.status === 'bound')).toBe(true);
  expect(targets.size).toBe(3);
  const task = operation => fetch(origin + '/api/modules/staffdeck-sdk/call', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PilotDeck-Project': a.name },
    body: JSON.stringify({ operation, input: { jobId: 'task' } }) });
  jobAgent = b.staffdeckBinding.agentId;
  expect((await task('get_job')).status).toBe(403);
  expect((await task('cancel_job')).status).toBe(403);
  expect(cancellations).toBe(0);
  jobAgent = a.staffdeckBinding.agentId;
  expect((await task('get_job')).status).toBe(200);
  expect((await task('cancel_job')).status).toBe(200);
  expect(cancellations).toBe(1);
  await getProjects(); expect(targets.size).toBe(3);
  const again = await register({ workspaceType: 'existing', path: existing });
  expect(again.staffdeckBinding.agentId).toBe(b.staffdeckBinding.agentId); expect(targets.size).toBe(3);
  await deleteProject(b.name);
  const restored = await register({ workspaceType: 'existing', path: existing });
  expect(restored.staffdeckBinding.bindingId).toBe(b.staffdeckBinding.bindingId);
  expect(restored.staffdeckBinding.agentId).toBe(b.staffdeckBinding.agentId);
  expect(targets.size).toBe(3);
  unavailable = true;
  const failed = await register({ workspaceType: 'new', path: join(root, 'offline') });
  expect(failed.staffdeckBinding.status).toBe('failed');
  expect(await readFile(join(home, 'projects', failed.name, '.cwd'), 'utf8')).toBe(failed.fullPath);
  const unknown = await fetch(origin + '/api/projects/unknown/staffdeck-binding');
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ status: 'failed', error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
  const storage = join(home, 'staffdeck/project-bindings.json');
  await writeFile(storage, '{broken');
  const damaged = await fetch(origin + `/api/projects/${a.name}/staffdeck-binding`);
  expect(damaged.status).toBe(409);
  expect((await damaged.json()).error.code).toBe('PROJECT_BINDING_STORE_INVALID');
  expect(await readFile(storage, 'utf8')).toBe('{broken');
});
