// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileSymlinkOrSkip } from '../test-support/symlink.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock('../pilotdeck-bridge.js', () => ({
  getPilotDeckGateway: async () => ({ skillRead: mocks.read, skillsList: mocks.list }),
}));
let temporary, skillPath, router;
beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-documents-test-'));
  const root = path.join(temporary, 'gateway-release', 'skills');
  skillPath = path.join(root, 'example');
  await fs.mkdir(path.join(skillPath, 'references'), { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Skill');
  await fs.writeFile(path.join(skillPath, 'references', 'guide.md'), '# Guide');
  await fs.writeFile(path.join(temporary, 'outside.md'), 'private');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'private');
  await fs.symlink(outside, path.join(skillPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(skillPath, 'script.sh'), 'echo run');
  await fs.writeFile(path.join(skillPath, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
  vi.stubEnv('PILOTDECK_BUNDLED_SKILLS_DIR', path.join(temporary, 'other-web-release', 'skills'));
  vi.resetModules();
  router = (await import('./skills.js')).default;
});
beforeEach(() => {
  const skill = {
    scope: 'builtin',
    slug: 'example',
    skillDir: skillPath,
    skillFile: path.join(skillPath, 'SKILL.md'),
  };
  mocks.read.mockResolvedValue({ content: '# Skill', skill });
  mocks.list.mockResolvedValue({ builtin: [skill], user: [], project: [] });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temporary, { recursive: true, force: true });
});
async function invoke(endpoint, file, address = { scope: 'builtin', slug: 'example' }) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await router.stack
    .find((layer) => layer.route?.path === endpoint)
    .route.stack[0].handle({ body: { ...address, file } }, response);
  return response;
}
it('lists supporting text documents without scripts or symlink escapes', async () => {
  const response = await invoke('/documents');
  expect(response.json).toHaveBeenCalledWith({
    files: ['SKILL.md', 'large.md', 'references/guide.md'],
  });
});
it('reads a reference inside the skill folder', async () => {
  const response = await invoke('/read-document', 'references/guide.md');
  expect(response.json).toHaveBeenCalledWith({ file: 'references/guide.md', content: '# Guide' });
});
it.each(['../../outside.md', 'escape/secret.md'])('rejects an escaping reference %s', async (file) => {
  expect((await invoke('/read-document', file)).status).toHaveBeenCalledWith(403);
});
it('rejects and omits a file symlink escaping the skill folder', async context => {
  if (!fileSymlinkOrSkip(context, path.join(temporary, 'outside.md'), path.join(skillPath, 'escape.md'))) return;
  expect((await invoke('/read-document', 'escape.md')).status).toHaveBeenCalledWith(403);
  expect((await invoke('/documents')).json.mock.calls[0][0].files).not.toContain('escape.md');
});
it.each(['/etc/secret.md', 'script.sh'])('rejects unsupported document paths %s', async (file) => {
  expect((await invoke('/read-document', file)).status).toHaveBeenCalledWith(400);
});
it('bounds large documents and reports missing references', async () => {
  expect((await invoke('/read-document', 'large.md')).status).toHaveBeenCalledWith(413);
  expect((await invoke('/read-document', 'missing.md')).status).toHaveBeenCalledWith(404);
});

it('accepts a legacy path from the gateway list when the Web release has a different root', async () => {
  const response = await invoke('/read-document', 'references/guide.md', { skillPath });
  expect(response.json).toHaveBeenCalledWith({ file: 'references/guide.md', content: '# Guide' });
});

it('ignores a stale client path when reading references by skill identity', async () => {
  const response = await invoke('/read-document', 'references/guide.md', {
    scope: 'builtin',
    slug: 'example',
    skillPath: '/removed-worktree/skills/example',
  });
  expect(response.json).toHaveBeenCalledWith({ file: 'references/guide.md', content: '# Guide' });
  expect(mocks.read).toHaveBeenCalledWith({ scope: 'builtin', slug: 'example', projectKey: null });
});
