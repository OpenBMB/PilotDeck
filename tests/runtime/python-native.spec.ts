import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PythonRuntimeManager, withPythonMcpEnvironment } from '../../src/runtime/pythonRuntime.js';
import { NodeShellCommandRunner } from '../../src/tool/builtin/bash/commandRunner.js';
import { McpClient } from '../../src/mcp/client/McpClient.js';
import { BackgroundTaskRuntime } from '../../src/task/runtime/BackgroundTaskRuntime.js';
import { createLocalGateway } from '../../src/cli/createLocalGateway.js';
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from '../../src/model/index.js';

const root = resolve(process.env.PILOTDECK_PYTHON_TEST_ROOT ?? 'apps/desktop/resources/python-runtime');
const hasBundle = Boolean(process.env.PILOTDECK_PYTHON_TEST_ROOT) || existsSync(join(root, 'manifest.json'));
const execute = promisify(execFile);
const quoted = (path: string) => `"${path.replaceAll('\\', '/')}"`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('native bundle executes offline data/documents/plots, installs user packages, and retains live tasks and MCP across toggles', { skip: !hasBundle, timeout: 300000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'PilotDeck 用户 profile '));
  const cleanups: (() => Promise<unknown> | void)[] = [];
  const onCleanup = (cleanup: () => Promise<unknown> | void) => cleanups.push(cleanup);
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  const work = join(home, 'workspace'); await mkdir(work);
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, TEMP: home, TMP: home, HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, PATH: process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32') : '/usr/bin:/bin',
    PILOT_HOME: home, PILOTDECK_PYTHON_ROOT: root, UV_OFFLINE: '1', UV_NO_CONFIG: '1',
    PIP_NO_INDEX: '1', PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const bundledBash = resolve('apps/desktop/resources/git/bin/bash.exe');
  if (process.platform === 'win32' && existsSync(bundledBash)) env.PILOTDECK_GIT_BASH_PATH = bundledBash;
  const manager = new PythonRuntimeManager({ pilotHome: home, env });
  const runtime = await manager.resolve();
  assert.equal(runtime.status.state, 'ready', 'the native bundle must initialize without downloading Python or packages');
  const python = runtime.status.executable!;
  const manifestBefore = await readFile(join(root, 'manifest.json'));
  const pythonBefore = await readFile(join(root, JSON.parse(manifestBefore.toString()).python));
  const workload = await execute(python, [resolve('tests/runtime/fixtures/python-workload.py'), work], { env: runtime.env, windowsHide: true, timeout: 60000 });
  assert.equal(JSON.parse(workload.stdout).executable, python);
  const shell = new NodeShellCommandRunner();
  for (const command of ['python', 'python3']) {
    const result = await shell.run(`${command} -c 'import sys,json; print(json.dumps(sys.prefix))'`, { cwd: work, env: runtime.env, timeoutMs: 15000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await realpath(JSON.parse(result.stdout)), await realpath(runtime.status.environment!));
  }
  const installed = await shell.run(`uv pip install --offline --no-index --no-deps ${quoted(join(work, 'pilotdeck_fixture-1.0-py3-none-any.whl'))}`, { cwd: work, env: runtime.env, timeoutMs: 15000 });
  assert.equal(installed.exitCode, 0, installed.stderr);
  const userPackage = await execute(python, ['-c', 'import pilotdeck_fixture; assert pilotdeck_fixture.VALUE == 42; print(pilotdeck_fixture.__file__)'], { env: runtime.env, windowsHide: true });
  assert.ok((await realpath(userPackage.stdout.trim())).toLowerCase().startsWith((await realpath(runtime.status.environment!)).toLowerCase()));
  const basePython = join(root, JSON.parse(manifestBefore.toString()).python);
  await execute(basePython, ['-I', '-B', '-c', 'import importlib.util; assert importlib.util.find_spec("pilotdeck_fixture") is None'], { env, windowsHide: true });
  assert.deepEqual(await readFile(join(root, 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(basePython), pythonBefore);

  const mcp = new McpClient(withPythonMcpEnvironment({ id: 'python', transport: 'stdio', command: 'python', args: [resolve('tests/runtime/fixtures/python-mcp.py')] }, runtime));
  onCleanup(() => mcp.close());
  assert.equal((await mcp.listTools())[0]?.toolName, 'identity');
  const tasks = new BackgroundTaskRuntime();
  const gate = join(work, 'finish');
  const script = join(work, 'running.py');
  await writeFile(script, 'import pathlib,sys,time,json\nwhile not pathlib.Path("finish").exists(): time.sleep(0.05)\nprint(json.dumps(sys.executable))\n');
  const task = await tasks.start({ command: `python ${quoted(script)}`, cwd: work, env: runtime.env });
  onCleanup(() => tasks.stop(task.taskId, { graceMs: 10 }));
  assert.equal(task.status, 'running');
  const disabled = await manager.resolve(false);
  assert.equal(disabled.status.state, 'disabled');
  assert.equal(disabled.env.UV_PYTHON, undefined);
  const identity = await mcp.callTool('identity', {});
  const mcpIdentity = JSON.parse((identity.content as { text: string }[])[0]!.text);
  assert.equal(await realpath(mcpIdentity.prefix), await realpath(runtime.status.environment!));
  assert.equal(await realpath(mcpIdentity.executable), await realpath(python));
  await writeFile(gate, 'done');
  const completed = await tasks.wait(task.taskId, { timeoutMs: 10000 });
  assert.equal(completed?.task.exitCode, 0);
  assert.equal(await manager.resolve(), runtime);
  await mcp.close();

  // Exercise the real Gateway reload and context/execution wiring with a deterministic model.
  const configPath = join(home, 'pilotdeck.yaml');
  const config = (enabled: boolean) => `schemaVersion: 1\nagent: { model: test/model }\nmodel:\n  providers:\n    test:\n      protocol: openai\n      url: https://example.test/v1\n      apiKey: fixture-key\n      models: { model: {} }\nextension:\n  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }\ntelemetry: { enabled: false }\nruntime: { python: { enabled: ${enabled} } }\n`;
  await writeFile(configPath, config(true));
  await writeFile(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { python: { command: 'python', args: [resolve('tests/runtime/fixtures/python-mcp.py')] } } }));
  const entered = deferred(), proceed = deferred();
  const requests: CanonicalModelRequest[] = [];
  let round = 0;
  const local = createLocalGateway({ pilotHome: home, projectRoot: home, builtinSkillsRoot: join(home, 'skills'), permissionMode: 'bypassPermissions',
    env: { ...env, PILOTDECK_CONFIG_PATH: configPath },
    __testModelFactory(snapshot) {
      return { ...createModelRuntime(snapshot.config.model),
        async *stream(request): AsyncIterable<CanonicalModelEvent> {
          requests.push(request);
          yield { type: 'message_start', role: 'assistant' };
          if (round++ === 0) {
            entered.resolve(); await proceed.promise;
            const call = { id: 'python-call', name: 'bash', input: { command: `python -c 'import sys,os; print(sys.executable); print(os.path.realpath(sys.prefix))'` } };
            yield { type: 'tool_call_start', id: call.id, name: call.name };
            yield { type: 'tool_call_end', toolCall: call };
            yield { type: 'message_end', finishReason: 'tool_call' };
          } else { yield { type: 'text_delta', text: 'Done' }; yield { type: 'message_end', finishReason: 'stop' }; }
        },
        async complete() { return { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{"title":"Python test"}' }], finishReason: 'stop' as const }; },
      };
    },
  });
  const submit = async () => { const events = []; for await (const event of local.gateway.submitTurn({ projectKey: home, sessionKey: 'web:python', channelKey: 'web', message: 'Use Python' })) events.push(event); return events; };
  const running = submit();
  onCleanup(async () => { proceed.resolve(); await running.catch(() => {}); local.dispose(); });
  await Promise.race([entered.promise, running.then(events => { throw new Error(`Turn ended before the model request: ${JSON.stringify(events)}`); })]);
  const old = local.registry.resolve(home);
  assert.equal(old.python?.status.state, 'ready');
  const oldMcp = old.mcpRuntime!.getClient('python')!;
  assert.equal(oldMcp.getStatus(), 'ready');
  await writeFile(configPath, config(false));
  await local.gateway.reloadConfig!();
  assert.equal((await local.gateway.getPythonRuntimeStatus!()).state, 'disabled');
  assert.equal(oldMcp.getStatus(), 'ready', 'preference changes must not stop active MCP');
  const activeMcp = await oldMcp.callTool('identity', {});
  assert.equal(await realpath(JSON.parse((activeMcp.content as { text: string }[])[0]!.text).prefix), await realpath(runtime.status.environment!));
  proceed.resolve();
  const events = await running;
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  assert.ok(events.some(event => event.type === 'turn_completed' && event.finishReason === 'completed'));
  assert.ok(requests.length >= 2);
  for (const request of requests) assert.match(request.systemPrompt!, /Bundled Python 3\.12\.\d+ is ready/);
  const toolText = JSON.stringify(requests.at(-1)!.messages).replaceAll('\\', '');
  assert.ok(toolText.includes((await realpath(runtime.status.environment!)).replaceAll('\\', '')), `Real bash result must identify the advertised environment: ${toolText}`);
  const beforeNext = requests.length;
  await submit();
  assert.match(requests[beforeNext]!.systemPrompt!, /Bundled Python is disabled for this turn/);
  assert.equal(local.registry.resolve(home).python?.status.state, 'disabled');
  local.dispose();
  assert.equal(dirname(home), resolve(tmpdir()));
});
