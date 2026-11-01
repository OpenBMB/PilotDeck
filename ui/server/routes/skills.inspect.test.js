// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import skillsRouter from './skills.js';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), import: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execFile = () => {};
  execFile[promisify.custom] = mocks.exec;
  return { ...actual, execFile };
});
vi.mock('../pilotdeck-bridge.js', () => ({
  getPilotDeckGateway: async () => ({ skillImport: mocks.import }),
}));

const handler = skillsRouter.stack.find((layer) => layer.route?.path === '/clawhub/inspect').route
  .stack[0].handle;
const res = () => {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
};
afterEach(() => vi.clearAllMocks());

it('fetches only SKILL.md and returns the version that was inspected', async () => {
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({ file: { content: '# Instructions' }, version: { version: '1.2.3' } }),
  });
  const response = res();
  await handler({ body: { slug: 'report-writer' } }, response);
  expect(response.json).toHaveBeenCalledWith({ content: '# Instructions', version: '1.2.3' });
  const [command, args, options] = mocks.exec.mock.calls[0];
  expect(command).toBe(process.execPath);
  expect(args.slice(1)).toEqual([
    '--no-input',
    'inspect',
    'report-writer',
    '--file',
    'SKILL.md',
    '--json',
  ]);
  expect(options).toMatchObject({ timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
});

it('rejects paths and command options before invoking the CLI', async () => {
  for (const slug of ['../../secret', '--help', '', null]) {
    const response = res();
    await handler({ body: { slug } }, response);
    expect(response.status).toHaveBeenCalledWith(400);
  }
  expect(mocks.exec).not.toHaveBeenCalled();
});

it('reports missing instructions without trying to install a skill', async () => {
  mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ file: null }) });
  const response = res();
  await handler({ body: { slug: 'report-writer' } }, response);
  expect(response.status).toHaveBeenCalledWith(404);
  expect(mocks.exec).toHaveBeenCalledOnce();
});

it('turns a registry or malformed-output failure into a bounded error', async () => {
  mocks.exec.mockResolvedValue({ stdout: 'not JSON' });
  const response = res();
  await handler({ body: { slug: 'report-writer' } }, response);
  expect(response.status).toHaveBeenCalledWith(502);
  expect(response.json).toHaveBeenCalledWith({
    error: 'Could not read skill instructions from ClawHub.',
  });
});

const route = (path) =>
  skillsRouter.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;

it('keeps publishers distinct when current ClawHub results share a slug', async () => {
  mocks.exec.mockResolvedValue({
    stdout:
      'pdf v1.0.0  @alice  PDF Writer  score 0.900\npdf v2.0.0  @bob  PDF Reader  score 0.800\n',
  });
  const response = res();
  await route('/clawhub/search')({ body: { query: 'pdf' } }, response);
  expect(response.json).toHaveBeenCalledWith({
    results: [
      { slug: 'pdf', owner: 'alice', name: 'PDF Writer', score: null },
      { slug: 'pdf', owner: 'bob', name: 'PDF Reader', score: null },
    ],
  });
});

it('previews the selected publisher and rejects unsafe publisher names', async () => {
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify({ file: { content: '# PDF' }, latestVersion: { version: '1.0.0' } }),
  });
  await handler({ body: { slug: 'pdf', owner: 'alice' } }, res());
  expect(mocks.exec.mock.calls[0][1]).toContain('@alice/pdf');
  mocks.exec.mockClear();
  const response = res();
  await handler({ body: { slug: 'pdf', owner: '../alice' } }, response);
  expect(response.status).toHaveBeenCalledWith(400);
  expect(mocks.exec).not.toHaveBeenCalled();
});

it('imports a reviewed publisher package without replacing existing global skills', async () => {
  mocks.exec.mockResolvedValue({ stdout: 'Installed', stderr: '' });
  mocks.import.mockResolvedValue({
    skill: { slug: 'alice--pdf', skillDir: '/home/skills/alice--pdf' },
  });
  const response = res();
  await route('/clawhub/install')(
    { body: { slug: 'pdf', owner: 'alice', version: '1.0.0', scope: 'user' } },
    response,
  );
  expect(mocks.exec.mock.calls[0][1]).toEqual(
    expect.arrayContaining(['@alice/pdf', '--version', '1.0.0']),
  );
  expect(mocks.import).toHaveBeenCalledWith(
    expect.objectContaining({
      slug: 'alice--pdf',
      scope: 'user',
      projectKey: null,
      mode: 'copy',
      force: false,
    }),
  );
  expect(mocks.import.mock.calls[0][0].sourcePath).toMatch(/\/skills\/@alice\/pdf$/);
  expect(response.json.mock.calls[0][0]).toMatchObject({
    installed: true,
    slug: 'alice--pdf',
    scope: 'user',
  });
});

it('retains ClawHub force confirmation and does not import a flagged package', async () => {
  mocks.exec.mockRejectedValue({
    code: 1,
    stderr: 'Use --force to install suspicious skills in non-interactive mode',
  });
  const response = res();
  await route('/clawhub/install')(
    { body: { slug: 'pdf', owner: 'alice', scope: 'user' } },
    response,
  );
  expect(response.json.mock.calls[0][0]).toMatchObject({ installed: false, needsForce: true });
  expect(mocks.import).not.toHaveBeenCalled();
});

it('does not use a suspicious-package confirmation to overwrite an existing skill', async () => {
  mocks.exec.mockResolvedValue({ stdout: 'Installed', stderr: '' });
  mocks.import.mockRejectedValue({ code: 'conflict', message: 'Skill already exists' });
  const response = res();
  await route('/clawhub/install')(
    {
      body: { slug: 'pdf', owner: 'alice', force: true, scope: 'project', projectPath: '/project' },
    },
    response,
  );
  expect(mocks.exec.mock.calls[0][1]).toContain('--force');
  expect(mocks.import).toHaveBeenCalledWith(
    expect.objectContaining({ force: false, projectKey: '/project' }),
  );
  expect(response.status).toHaveBeenCalledWith(409);
});
