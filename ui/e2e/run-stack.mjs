import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(uiRoot, '..');
const children = new Set();
const pilotHome = await mkdtemp(path.join(tmpdir(), 'pilotdeck-playwright-'));
const workspace = path.join(pilotHome, 'e2e-workspace');
const ports = {
  provider: await freePort(),
  gateway: await freePort(),
  server: await freePort(),
  vite: await freePort(),
  control: await freePort(),
};

let gatewayChild;
let shuttingDown = false;

await prepareWorkspace();
const providerServer = createFakeProvider();
await listen(providerServer, ports.provider);
const controlServer = createControlServer();
await listen(controlServer, ports.control);

const commonEnv = {
  ...process.env,
  PILOT_HOME: pilotHome,
  PILOTDECK_CONFIG_PATH: path.join(pilotHome, 'pilotdeck.yaml'),
  PILOTDECK_DISABLE_LOCAL_AUTH: '1',
  PILOTDECK_SKIP_BOOTSTRAP: '1',
  DATABASE_PATH: path.join(pilotHome, 'auth.db'),
  HOST: '127.0.0.1',
  SERVER_PORT: String(ports.server),
  VITE_PORT: String(ports.vite),
  PILOTDECK_GATEWAY_PORT: String(ports.gateway),
  PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${ports.gateway}/ws`,
  NO_PROXY: '127.0.0.1,localhost',
};

process.on('SIGINT', () => void shutdown().then(() => process.exit(130)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(143)));

try {
  gatewayChild = startGateway();
  const expressChild = startChild('express', process.execPath, ['--import', 'tsx', 'server/index.js'], uiRoot);
  const viteChild = startChild(
    'vite',
    process.execPath,
    [path.join(uiRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(ports.vite), '--strictPort'],
    uiRoot,
  );
  void expressChild;
  void viteChild;

  await Promise.all([
    waitForUrl(`http://127.0.0.1:${ports.gateway}/health`),
    waitForUrl(`http://127.0.0.1:${ports.server}/api/auth/status`),
    waitForUrl(`http://127.0.0.1:${ports.vite}/`),
  ]);

  const result = await runPlaywright({
    ...commonEnv,
    PILOTDECK_E2E_BASE_URL: `http://127.0.0.1:${ports.vite}`,
    PILOTDECK_API_URL: `http://127.0.0.1:${ports.vite}`,
    PILOTDECK_E2E_PROJECT_PATH: workspace,
    PILOTDECK_E2E_CONTROL_URL: `http://127.0.0.1:${ports.control}`,
  });
  process.exitCode = result;
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await shutdown();
}

async function prepareWorkspace() {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# E2E workspace\n', 'utf8');
  const projectDir = path.join(pilotHome, 'projects', 'e2e-workspace');
  await mkdir(path.join(projectDir, 'chats'), { recursive: true });
  await writeFile(path.join(projectDir, '.cwd'), `${workspace}\n`, 'utf8');
  await writeFile(path.join(pilotHome, 'permissions.json'), `${JSON.stringify({
    version: 1,
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(pilotHome, 'pilotdeck.yaml'), `schemaVersion: 1
agent:
  model: e2e/fake
  params:
    maxTurns: 8
model:
  providers:
    e2e:
      protocol: openai
      url: http://127.0.0.1:${ports.provider}/v1
      apiKey: e2e-key
      models:
        fake:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsSystemPrompt: true
            maxContextTokens: 32768
            maxOutputTokens: 2048
memory:
  enabled: false
router:
  enabled: false
telemetry:
  enabled: false
webui:
  runtime:
    host: 127.0.0.1
    serverPort: ${ports.server}
    vitePort: ${ports.vite}
    workspacesRoot: ${JSON.stringify(pilotHome)}
`, 'utf8');
}

function createFakeProvider() {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end('ok');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end('not found');
      return;
    }
    const body = JSON.parse(await readBody(request));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find(message => message?.role === 'user');
    const text = contentText(lastUser?.content);
    const hasToolResult = messages.some(message => message?.role === 'tool');

    if (body.stream === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"title":"E2E session"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (hasToolResult) {
      sendTextResponse(response, 'Permission flow completed');
      return;
    }
    if (text.includes('[permission]')) {
      sendToolCall(response);
      return;
    }
    if (text.includes('[delay]')) {
      writeSse(response, openAIChunk({ content: 'Working on delayed request...' }));
      const timer = setTimeout(() => sendTextResponse(response, 'Delayed response completed'), 30_000);
      request.once('close', () => clearTimeout(timer));
      return;
    }
    sendTextResponse(response, `Fake response: ${text.trim() || 'empty prompt'}`);
  });
}

function createControlServer() {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/restart-gateway') {
      response.writeHead(404).end('not found');
      return;
    }
    await stopChild(gatewayChild);
    gatewayChild = startGateway();
    await waitForUrl(`http://127.0.0.1:${ports.gateway}/health`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ restarted: true }));
  });
}

function sendTextResponse(response, text) {
  writeSse(response, openAIChunk({ role: 'assistant' }));
  writeSse(response, openAIChunk({ content: text }));
  writeSse(response, {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
  });
  response.end('data: [DONE]\n\n');
}

function sendToolCall(response) {
  writeSse(response, openAIChunk({ role: 'assistant' }));
  writeSse(response, openAIChunk({
    tool_calls: [{
      index: 0,
      id: 'call_permission_e2e',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"touch permission-e2e.txt"}' },
    }],
  }));
  writeSse(response, {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  });
  response.end('data: [DONE]\n\n');
}

function openAIChunk(delta) {
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function writeSse(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

function startGateway() {
  return startChild('gateway', process.execPath, [path.join(repoRoot, 'dist/src/cli/pilotdeck.js'), 'server'], repoRoot);
}

function startChild(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, env: commonEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`));
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown && child === gatewayChild && code !== 0 && signal !== 'SIGTERM') {
      console.error(`[e2e] ${label} exited unexpectedly (${code ?? signal})`);
    }
  });
  return child;
}

function runPlaywright(env) {
  return new Promise((resolve, reject) => {
    const executable = process.env.npm_execpath;
    const command = executable ? process.execPath : 'pnpm';
    const args = executable
      ? [executable, 'exec', 'playwright', 'test', '--config', 'playwright.config.mjs']
      : ['exec', 'playwright', 'test', '--config', 'playwright.config.mjs'];
    const child = spawn(command, args, { cwd: uiRoot, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

async function waitForUrl(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...children].map(stopChild));
  await Promise.all([
    new Promise(resolve => providerServer.close(() => resolve())),
    new Promise(resolve => controlServer.close(() => resolve())),
  ]);
  await rm(pilotHome, { recursive: true, force: true });
}
