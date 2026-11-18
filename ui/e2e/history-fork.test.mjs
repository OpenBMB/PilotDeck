import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { on } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPilotProjectChatDir } from '../../src/pilot/paths.ts';
import { sanitizeSessionIdForPath } from '../../src/session/storage/ProjectSessionStorage.ts';
import { JsonlTranscriptWriter } from '../../src/session/transcript/JsonlTranscriptWriter.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

function startProcess(entry, args, cwd, env) {
  const child = fork(join(root, entry), args, {
    cwd, env, execArgv: ['--import', import.meta.resolve('tsx')],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = async () => {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  return { child, stop };
}

async function waitForReady(child, readyMessage, { requireConfiguredModel = false } = {}) {
  let port;
  let configuration;
  for await (const [message] of on(child, 'message', { close: ['exit'], signal: AbortSignal.timeout(25_000) })) {
    if (message?.type === readyMessage) port = message.port;
    if (message?.type === 'pilotdeck:configuration-state') configuration = message.configuration;
    if (port && (!requireConfiguredModel || configuration)) {
      if (requireConfiguredModel) {
        // An empty model pool uses disk reads in the bridge and would bypass Gateway.
        assert.equal(configuration.state, 'ready', JSON.stringify(configuration));
      }
      return port;
    }
  }
  assert.fail(`Process exited before ${readyMessage} (code ${child.exitCode}, signal ${child.signalCode})`);
}

test('forks a stored conversation over Web HTTP and reads the inherited history via Gateway', { timeout: 60_000 }, async t => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pilotdeck-fork-http-')));
  const pilotHome = join(fixture, 'pilot-home');
  const projectRoot = join(fixture, 'workspace with spaces');
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  const databasePath = join(pilotHome, 'auth.db');
  let gateway;
  let web;
  t.after(async () => {
    try {
      await web?.stop();
      await gateway?.stop();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  await mkdir(pilotHome);
  await mkdir(projectRoot);
  // Prevent Web's legacy database migration from importing a local auth DB.
  await writeFile(databasePath, '', { mode: 0o600 });
  await writeFile(configPath, `schemaVersion: 1
agent: { model: fixture/chat }
model:
  providers:
    fixture:
      protocol: openai
      url: http://127.0.0.1:1/v1
      apiKey: synthetic-test-key
      models: { chat: {} }
runtime: { python: { enabled: false } }
telemetry: { enabled: false }
`);
  const sessionId = 'web:s_fork_source';
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });
  const transcript = new JsonlTranscriptWriter({
    path: join(chatDir, `${sanitizeSessionIdForPath(sessionId)}.jsonl`),
  });
  const text = (role, value) => ({ role, content: [{ type: 'text', text: value }] });
  await transcript.recordAcceptedInput(sessionId, 'first', [text('user', 'Earlier request')]);
  await transcript.recordDurableMessage(sessionId, 'first', text('assistant', 'Earlier answer'));
  await transcript.recordAcceptedInput(sessionId, 'second', [text('user', 'Continue here')]);

  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PILOT_HOME: pilotHome,
    PILOTDECK_CONFIG_PATH: configPath,
    PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: projectRoot,
  };
  gateway = startProcess('src/cli/pilotdeck.ts', ['server'], projectRoot, {
    ...env, PILOTDECK_GATEWAY_PORT: '0',
  });
  const gatewayPort = await waitForReady(gateway.child, 'pilotdeck:gateway-ready');
  web = startProcess('ui/server/index.js', [], projectRoot, {
    ...env,
    HOST: '127.0.0.1',
    SERVER_PORT: '0',
    DATABASE_PATH: databasePath,
    PILOTDECK_DISABLE_LOCAL_AUTH: '1',
    PILOTDECK_SKIP_BROWSER_OPEN: '1',
    PILOTDECK_RUNTIME_SUPERVISED: '1',
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
    PILOTDECK_BRIDGE_TIMEOUT: '5000',
  });
  const webPort = await waitForReady(web.child, 'pilotdeck:server-ready', { requireConfiguredModel: true });
  const origin = `http://127.0.0.1:${webPort}`;
  const sessionUrl = id => `${origin}/api/sessions/${encodeURIComponent(id)}`;
  async function requestJson(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    assert.equal(response.status, 200, `${url}: ${body}`);
    return JSON.parse(body);
  }
  const query = new URLSearchParams({ projectPath: projectRoot, limit: '200' });
  const readHistory = id => requestJson(`${sessionUrl(id)}/messages?${query}`);
  const source = await readHistory(sessionId);
  const branchPoint = source.messages.find(message => message.role === 'user' && message.content === 'Continue here');
  assert.ok(branchPoint?.entryId, 'The history response exposes the branch point entry ID');
  const branch = await requestJson(`${sessionUrl(sessionId)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: projectRoot, fromEntryId: branchPoint.entryId }),
  });
  assert.match(branch.newSessionId, /^web:s_/);
  assert.notEqual(branch.newSessionId, sessionId);
  assert.equal(branch.prefillText, 'Continue here');
  assert.equal(branch.carriedMessageCount, 2);

  const inherited = await readHistory(branch.newSessionId);
  assert.deepEqual(inherited.messages.filter(message => message.kind === 'text').map(({ role, content }) => [role, content]), [
    ['user', 'Earlier request'],
    ['assistant', 'Earlier answer'],
  ]);
});
