// Serve only the production renderer. API/WebSocket fixtures live in Playwright;
// this process never imports server/config code or opens a user profile.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.env.PILOTDECK_EDITOR_BUILD_DIR || path.join(uiRoot, 'dist'));
await fs.access(path.join(dist, 'index.html'));
const types = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dist + path.sep)) { res.writeHead(404).end(); return; }
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(Number(process.env.PILOTDECK_EDITOR_TEST_PORT || 5193), '127.0.0.1');
