// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import skillsRouter from './skills.js';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  import: vi.fn(),
}));
vi.mock('../pilotdeck-bridge.js', () => ({
  getPilotDeckGateway: async () => ({
    skillsList: mocks.list,
    skillRead: mocks.read,
    skillWrite: mocks.write,
    skillDelete: mocks.remove,
    skillImport: mocks.import,
  }),
}));
const skill = {
  slug: 'apple-notes',
  scope: 'builtin',
  skillDir: '/other-gateway-worktree/skills/apple-notes',
  skillFile: '/other-gateway-worktree/skills/apple-notes/SKILL.md',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ builtin: [skill], user: [], project: [] });
  mocks.read.mockResolvedValue({ content: '# Apple Notes', skill });
  mocks.write.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.import.mockResolvedValue({ ok: true });
});
async function invoke(endpoint, body) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await skillsRouter.stack
    .find((layer) => layer.route?.path === endpoint)
    .route.stack[0].handle({ body }, response);
  return response;
}

it('reads a built-in skill by identity despite a stale worktree path', async () => {
  const response = await invoke('/read', {
    scope: 'builtin',
    slug: 'apple-notes',
    skillPath: '/removed-worktree/skills/apple-notes',
  });
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ content: '# Apple Notes' }));
  expect(mocks.read).toHaveBeenCalledWith({
    scope: 'builtin',
    slug: 'apple-notes',
    projectKey: null,
  });
  expect(mocks.list).not.toHaveBeenCalled();
});
it('resolves legacy paths using the current gateway list', async () => {
  await invoke('/read', { skillPath: skill.skillDir });
  expect(mocks.read).toHaveBeenCalledWith({
    scope: 'builtin',
    slug: 'apple-notes',
    projectKey: null,
  });
});
it.each([
  '/unlisted/skills/apple-notes',
  '/other-gateway-worktree/skills/apple-notes/references/private.md',
])('rejects an unlisted legacy path %s', async (skillPath) => {
  expect((await invoke('/read', { skillPath })).status).toHaveBeenCalledWith(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
it.each([
  { scope: 'builtin', slug: '../secret' },
  { scope: 'other', slug: 'apple-notes' },
  { scope: 'project', slug: 'apple-notes' },
  { slug: 'apple-notes' },
])('rejects an invalid or incomplete address %j', async (body) => {
  expect((await invoke('/read', body)).status).toHaveBeenCalledWith(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('forwards write and delete identities to the authoritative manager with the correct project', async () => {
  await invoke('/write', {
    scope: 'project',
    slug: 'notes',
    projectPath: '/project-b',
    content: '# Notes',
  });
  expect(mocks.write).toHaveBeenCalledWith({
    scope: 'project',
    slug: 'notes',
    projectKey: '/project-b',
    content: '# Notes',
  });
  await invoke('/delete', { scope: 'project', slug: 'notes', projectPath: '/project-a' });
  expect(mocks.remove).toHaveBeenCalledWith({
    scope: 'project',
    slug: 'notes',
    projectKey: '/project-a',
  });
});
it('preserves the gateway restriction on built-in writes', async () => {
  mocks.write.mockRejectedValue(
    Object.assign(new Error('Built-in skills are read-only.'), { code: 'read_only' }),
  );
  expect(
    (await invoke('/write', { scope: 'builtin', slug: 'apple-notes', content: '# Changed' }))
      .status,
  ).toHaveBeenCalledWith(403);
});
it('copies a custom version from the gateway-resolved directory', async () => {
  await invoke('/import', {
    sourceSkill: { scope: 'builtin', slug: 'apple-notes' },
    scope: 'user',
    slug: 'apple-notes',
    mode: 'copy',
    force: false,
  });
  expect(mocks.import).toHaveBeenCalledWith({
    sourcePath: skill.skillDir,
    scope: 'user',
    slug: 'apple-notes',
    projectKey: null,
    mode: 'copy',
    force: false,
  });
});
