import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { inflateSync } from 'node:zlib';

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

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodePng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Screenshot is not a PNG file');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}`);
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let previousRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const row = Buffer.from(inflated.subarray(inputOffset, inputOffset + rowBytes));
    inputOffset += rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previousRow[x] || 0;
      const upperLeft = x >= bytesPerPixel ? previousRow[x - bytesPerPixel] || 0 : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + above) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paethPredictor(left, above, upperLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);
    }

    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * 4;
      pixels[target] = row[source];
      pixels[target + 1] = row[source + 1];
      pixels[target + 2] = row[source + 2];
      pixels[target + 3] = colorType === 6 ? row[source + 3] : 255;
    }

    previousRow = row;
  }

  return { width, height, pixels };
}

function readPixel(image, x, y) {
  const clampedX = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (clampedY * image.width + clampedX) * 4;
  return {
    red: image.pixels[offset],
    green: image.pixels[offset + 1],
    blue: image.pixels[offset + 2],
    alpha: image.pixels[offset + 3],
  };
}

function brightness(pixel) {
  return (pixel.red + pixel.green + pixel.blue) / 3;
}

function darkPixelRatio(image, left, top, width, height) {
  let dark = 0;
  let total = 0;
  const right = Math.min(image.width, left + width);
  const bottom = Math.min(image.height, top + height);
  for (let y = Math.max(0, top); y < bottom; y += 1) {
    for (let x = Math.max(0, left); x < right; x += 1) {
      total += 1;
      if (brightness(readPixel(image, x, y)) < 80) {
        dark += 1;
      }
    }
  }
  return total > 0 ? dark / total : 0;
}

function validateScreenshot(screenshotFile, ui) {
  const image = decodePng(readFileSync(screenshotFile));
  const expectedWidth = Math.max(1000, Math.round((ui.bodyWidth || 1280) * 0.9));
  const expectedHeight = Math.max(600, Math.round((ui.rootHeight || 720) * 0.8));
  if (image.width < expectedWidth || image.height < expectedHeight) {
    throw new Error(`Screenshot too small: ${image.width}x${image.height}`);
  }

  const samples = {
    mainTop: readPixel(image, image.width * 0.5, image.height * 0.17),
    mainLower: readPixel(image, image.width * 0.82, image.height * 0.82),
    sidebar: readPixel(image, Math.min(120, image.width * 0.1), image.height * 0.18),
  };
  const metrics = Object.fromEntries(
    Object.entries(samples).map(([name, pixel]) => [name, Math.round(brightness(pixel))]),
  );
  const logoDarkRatio = darkPixelRatio(image, 10, 18, 34, 34);
  const lightSurfaceCount = ['mainTop', 'mainLower', 'sidebar'].filter(
    (name) => metrics[name] >= 210,
  ).length;
  if (lightSurfaceCount < 3) {
    throw new Error(`Screenshot does not match the expected light UI surfaces: ${JSON.stringify(metrics)}`);
  }
  if (logoDarkRatio < 0.35) {
    throw new Error(`Screenshot logo region is not dark enough: ${JSON.stringify({ ...metrics, logoDarkRatio })}`);
  }
  return {
    width: image.width,
    height: image.height,
    brightness: metrics,
    logoDarkRatio: Number(logoDarkRatio.toFixed(3)),
  };
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
    const screenshotCheck = validateScreenshot(screenshotPath, ui);
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
      screenshotCheck,
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
