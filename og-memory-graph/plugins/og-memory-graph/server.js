












import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readConfig() {
  const p = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[og-memory-graph] config.json 读取失败:', e.message);
    process.exit(1);
  }
}

const config = readConfig();
const ogBase = `http://127.0.0.1:${config.port}`;


async function healthcheck(timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ogBase}/api/status`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}


let ogProc = null;
function spawnOg6() {
  const cwd = config.og_root;
  const env = {
    ...process.env,
    V5_ROOT: cwd


  };
  ogProc = spawn(config.python, [
  '-m', 'uvicorn', 'server.main:app',
  '--port', String(config.port),
  '--host', '127.0.0.1'],
  { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  ogProc.stdout.on('data', (data) => {
    const line = data.toString();
    if (line.includes('Application startup complete')) {
      console.log(`[og-memory-graph] og6 uvicorn started on ${config.port}`);
    }
  });
  ogProc.stderr.on('data', (data) => {
    const line = data.toString();

    if (line.includes('Application startup complete')) {
      console.log(`[og-memory-graph] og6 uvicorn started on ${config.port}`);
    }
  });
  ogProc.on('exit', (code) => {
    console.error(`[og-memory-graph] og6 uvicorn exited (code=${code})`);
    ogProc = null;
  });
}


async function waitForOg6(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await healthcheck(1500)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function ensureOg6() {
  if (await healthcheck(2000)) {
    console.log('[og-memory-graph] og6 已运行，复用');
    return;
  }
  console.log('[og-memory-graph] og6 未运行，启动 uvicorn…');
  spawnOg6();
  if (!(await waitForOg6())) {
    console.error('[og-memory-graph] og6 启动超时');
  }
}


const server = http.createServer((req, res) => {
  if (req.url === '/config' || req.url === '/config/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ og_base: ogBase, model: config.model }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(0, '127.0.0.1', async () => {
  const pluginPort = server.address().port;

  ensureOg6().catch((e) => console.error('[og-memory-graph] ensureOg6 error:', e));

  console.log(JSON.stringify({ ready: true, port: pluginPort }));
});


function cleanup() {
  if (ogProc) {
    try {ogProc.kill();} catch {}
  }
  try {server.close();} catch {}
}
process.on('SIGTERM', () => {cleanup();process.exit(0);});
process.on('SIGINT', () => {cleanup();process.exit(0);});
process.on('exit', cleanup);
