import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PythonRuntimeManager, withPythonMcpEnvironment, pythonRuntimeContext } from '../../src/runtime/pythonRuntime.js';
import type { PilotDeckMcpServerSpec } from '../../src/mcp/protocol/types.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-python-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '应用 with spaces');
  await mkdir(root);
  const manifest = { schemaVersion: 1, id: 'a'.repeat(64), version: '3.12.16', platform: process.platform, arch: process.arch,
    python: 'python', uv: 'uv', packages: { requests: '2.0' }, modules: ['requests'] };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'python'), 'fixture'); await writeFile(join(root, 'uv'), 'fixture');
  const calls: { command: string; args: string[] }[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes('venv')) {
      const target = join(args.at(-1)!, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'venv fixture');
      await new Promise(done => setTimeout(done, 30));
      return '';
    }
    return JSON.stringify({ version: manifest.version, prefix: dirname(dirname(command)) });
  };
  const env = { Path: '/host/bin', PILOTDECK_PYTHON_ROOT: root, PYTHONHOME: '/wrong', PYTHONPATH: '/wrong', SECRET: 'never-publish' };
  return { home, root, manifest, env, calls, run, manager: new PythonRuntimeManager({ pilotHome: home, env, run }) };
}

test('default-on initialization is coalesced, isolated, immutable and retained when disabled', async t => {
  const f = await fixture(t);
  const [on, same] = await Promise.all([f.manager.resolve(), f.manager.resolve(true)]);
  assert.equal(on, same); assert.equal(on.status.state, 'ready');
  assert.equal(f.calls.filter(call => call.args.includes('venv')).length, 1);
  assert.equal(on.env.PYTHONHOME, undefined); assert.equal(on.env.PYTHONPATH, undefined);
  assert.equal(on.env.Path, undefined); assert.ok(on.env.PATH!.startsWith(dirname(on.status.executable!)));
  assert.equal(on.env.UV_PYTHON, on.status.executable);
  assert.equal(f.env.Path, '/host/bin'); assert.equal(f.env.PYTHONHOME, '/wrong');
  assert.ok(Object.isFrozen(on.env)); assert.ok(Object.isFrozen(on.status));
  const off = await f.manager.resolve(false);
  assert.equal(off.status.state, 'disabled'); assert.deepEqual(off.env, f.env);
  assert.equal(await readFile(on.status.executable!, 'utf8'), 'venv fixture');
  assert.equal(await f.manager.resolve(true), on);
  assert.ok(!JSON.stringify(on.status).includes('never-publish'));
});

test('concurrent Gateway instances share one completed virtual environment', async t => {
  const f = await fixture(t);
  const other = new PythonRuntimeManager({ pilotHome: f.home, env: f.env, run: f.run });
  const [a, b] = await Promise.all([f.manager.resolve(), other.resolve()]);
  assert.equal(a.status.state, 'ready'); assert.equal(b.status.state, 'ready');
  assert.equal(a.status.executable, b.status.executable);
  assert.equal(f.calls.filter(call => call.args.includes('venv')).length, 2);
  assert.equal(await readFile(a.status.executable!, 'utf8'), 'venv fixture');
});

test('missing, disabled and explicitly activated environments never launch bundled Python', async () => {
  const run = async () => { throw new Error('Unexpected launch'); };
  const manager = new PythonRuntimeManager({ pilotHome: '/unused', env: {}, run });
  assert.deepEqual((await manager.resolve()).status, { enabled: true, state: 'unavailable', reason: 'not-installed' });
  assert.equal((await manager.resolve(false)).status.state, 'disabled');
  const external = new PythonRuntimeManager({ pilotHome: '/unused', env: { VIRTUAL_ENV: '/project/.venv' }, run });
  assert.equal((await external.resolve()).status.state, 'external');
});

test('invalid manifests fail closed, and a repaired installation can be retried', async t => {
  const f = await fixture(t);
  for (const patch of [{ version: '3.13.1' }, { python: '../escape' }, { arch: 'ia32' }]) {
    await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ ...f.manifest, ...patch }));
    assert.equal((await f.manager.resolve()).status.state, 'unavailable');
    assert.equal(f.calls.length, 0);
  }
  await writeFile(join(f.root, 'manifest.json'), JSON.stringify(f.manifest));
  assert.equal((await f.manager.resolve()).status.state, 'ready');
});

test('MCP receives only the capability variables and preserves explicit overrides', async t => {
  const f = await fixture(t), runtime = await f.manager.resolve();
  const bare = { id: 'fixture', transport: 'stdio' as const, command: 'python', env: { CUSTOM: 'value' } };
  const patched = withPythonMcpEnvironment(bare, runtime);
  assert.equal(patched.transport, 'stdio');
  if (patched.transport !== 'stdio') throw new Error('wrong transport');
  assert.equal(patched.env?.UV_PYTHON, runtime.status.executable);
  assert.equal(patched.env?.CUSTOM, 'value'); assert.equal(patched.env?.SECRET, undefined);
  const explicit: PilotDeckMcpServerSpec[] = [{ ...bare, command: join(f.home, 'project-python') }, { ...bare, command: './.venv/bin/python' },
    { ...bare, env: { Path: '/custom' } }, { ...bare, env: { UV_PYTHON: '/custom/python' } },
    { id: 'http', transport: 'streamable_http' as const, url: 'https://example.test' }];
  for (const spec of explicit) {
    assert.equal(withPythonMcpEnvironment(spec, runtime), spec);
  }
  assert.equal(withPythonMcpEnvironment(bare, await f.manager.resolve(false)), bare);
  assert.match(pythonRuntimeContext(runtime.status), /requests==2.0/);
  assert.ok(!pythonRuntimeContext(runtime.status).includes('never-publish'));
});
