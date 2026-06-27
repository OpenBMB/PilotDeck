import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:18789/health';
const DEFAULT_UI_URL = 'http://127.0.0.1:3001/';
const SMOKE_TIMEOUT_MS = Number(process.env.PILOTDECK_SMOKE_TIMEOUT_MS || 15000);

const chromePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
const healthUrl = process.env.PILOTDECK_HEALTH_URL || DEFAULT_HEALTH_URL;
const uiUrl = process.env.PILOTDECK_UI_URL || DEFAULT_UI_URL;
const screenshotPath =
  process.env.PILOTDECK_SMOKE_SCREENSHOT ||
  join(tmpdir(), `pilotdeck-lab-smoke-${Date.now()}.png`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPageWebSocket(port, targetUrl) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1000);
      const target = pages.find(
        (page) => page.type === 'page' && page.url.startsWith(targetUrl),
      ) || pages.find((page) => page.type === 'page');
      if (target?.webSocketDebuggerUrl) {
        return target.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome may need a moment before the debugging endpoint is ready.
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for Chrome debugging endpoint');
}

function createCdpClient(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(JSON.stringify(message.error)));
    } else {
      resolve(message.result);
    }
  });

  return {
    async open() {
      await open;
    },
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

async function waitForStableUi(client) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    const result = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.querySelector('#root');
        const text = root?.textContent || '';
        const rootRect = root?.getBoundingClientRect();
        const textarea = document.querySelector('textarea');
        return {
          title: document.title,
          readyState: document.readyState,
          rootPresent: Boolean(root),
          rootTextLength: text.trim().length,
          hasPrompt: text.includes("What's on the plan today?"),
          hasComposer: Boolean(textarea),
          bodyWidth: Math.round(document.body?.getBoundingClientRect().width || 0),
          rootHeight: Math.round(rootRect?.height || 0),
        };
      })()`,
      returnByValue: true,
    });
    lastState = result.result.value;
    if (
      lastState.readyState === 'complete' &&
      lastState.rootPresent &&
      lastState.hasPrompt &&
      lastState.hasComposer &&
      lastState.rootHeight >= 600
    ) {
      return lastState;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for stable UI: ${JSON.stringify(lastState)}`);
}

async function main() {
  const health = await fetchJson(healthUrl, 5000);
  if (health?.ok !== true) {
    throw new Error(`Gateway health check failed: ${JSON.stringify(health)}`);
  }

  const port = await getFreePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pilotdeck-cdp-smoke-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1280,720',
    uiUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  let client;
  try {
    const webSocketUrl = await waitForPageWebSocket(port, uiUrl);
    client = createCdpClient(webSocketUrl);
    await client.open();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send('Page.navigate', { url: uiUrl });
    const ui = await waitForStableUi(client);
    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    await client.send('Browser.close').catch(() => {});

    const chromeLogTail = stderr
      .split('\n')
      .filter((line) => /ERROR|WARNING/i.test(line))
      .slice(-12);

    console.log(JSON.stringify({
      ok: true,
      health,
      ui,
      screenshotPath,
      screenshotBytes: statSync(screenshotPath).size,
      chromeLogTail,
    }, null, 2));
  } finally {
    client?.close();
    if (!chrome.killed) {
      chrome.kill('SIGTERM');
    }
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
