#!/usr/bin/env node
/**
 * Dev launcher: probe the three dev ports (server / gateway / vite), find the
 * first free one for each starting from the project defaults, then exec the
 * existing `concurrently` script with the resolved values injected as env so
 * gateway / server / vite all bind/connect to matching numbers.
 *
 * This means a stale leftover process on 3001 (or another team member's tool
 * occupying 18789) no longer breaks `npm run dev` — the launcher just slides
 * over to 3002 / 18790 / etc. and prints the resolved map up top.
 *
 * Port resolution priority (highest wins):
 *   SERVER_PORT / VITE_PORT (env hard-pin, skips probing)
 *   > SERVER_PORT_BASE / VITE_PORT_BASE (env base override)
 *   > webui.runtime.serverPort / vitePort (from ~/.pilotdeck/pilotdeck.yaml)
 *   > 3001 / 5173 (hardcoded defaults)
 *
 * Hard-pinned ports still win — if SERVER_PORT / PILOTDECK_GATEWAY_PORT /
 * VITE_PORT are already exported the launcher trusts them and skips probing
 * (so prod-style setups don't accidentally slide).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// On Windows npm is actually npm.cmd — spawning plain 'npm' fails with ENOENT.
// The shell: true flag also lets Windows find the batch wrapper.
const npmCommand = platform() === 'win32' ? 'npm.cmd' : 'npm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function readYamlPortConfig() {
  const home = process.env.PILOT_HOME || join(homedir(), '.pilotdeck');
  const configPath = process.env.PILOTDECK_CONFIG_PATH || join(home, 'pilotdeck.yaml');
  try {
    const raw = readFileSync(configPath, 'utf8');
    const config = parseYaml(raw);
    return config?.webui?.runtime ?? {};
  } catch {
    return {};
  }
}

const yamlRuntime = readYamlPortConfig();
const SERVER_PORT_BASE = parsePort(process.env.SERVER_PORT_BASE, yamlRuntime.serverPort ?? 3001);
const GATEWAY_PORT_BASE = parsePort(process.env.PILOTDECK_GATEWAY_PORT_BASE, 18789);
const VITE_PORT_BASE = parsePort(process.env.VITE_PORT_BASE, yamlRuntime.vitePort ?? 5173);

const MAX_PORT_TRIES = 20;

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolveCheck) => {
    const probe = createServer();
    probe.once('error', () => resolveCheck(false));
    probe.once('listening', () => {
      probe.close(() => resolveCheck(true));
    });
    probe.listen(port, host);
  });
}

async function findFreePort(label, base, hardOverride) {
  if (hardOverride !== undefined) {
    return { port: hardOverride, source: 'env-pinned' };
  }
  for (let offset = 0; offset < MAX_PORT_TRIES; offset += 1) {
    const candidate = base + offset;
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(candidate);
    if (free) {
      return {
        port: candidate,
        source: offset === 0 ? 'default' : `fallback (+${offset})`,
      };
    }
  }
  throw new Error(
    `[dev-launcher] Could not find a free ${label} port within ${MAX_PORT_TRIES} of ${base}.`,
  );
}

function envPortOverride(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

async function main() {
  const server = await findFreePort('server', SERVER_PORT_BASE, envPortOverride('SERVER_PORT'));
  const gateway = await findFreePort('gateway', GATEWAY_PORT_BASE, envPortOverride('PILOTDECK_GATEWAY_PORT'));
  const vite = await findFreePort('vite', VITE_PORT_BASE, envPortOverride('VITE_PORT'));

  const map = [
    ['server (express/ws)', server],
    ['gateway (pilotdeck)', gateway],
    ['vite client       ', vite],
  ];
  console.log('[dev-launcher] resolved dev ports:');
  for (const [label, info] of map) {
    console.log(`  ${label}  →  ${info.port}   ${info.source !== 'default' ? `(${info.source})` : ''}`);
  }
  console.log('');

  const env = {
    ...process.env,
    SERVER_PORT: String(server.port),
    PILOTDECK_GATEWAY_PORT: String(gateway.port),
    PILOTDECK_GATEWAY_URL:
      process.env.PILOTDECK_GATEWAY_URL ?? `ws://127.0.0.1:${gateway.port}/ws`,
    VITE_PORT: String(vite.port),
    PILOTDECK_SKIP_DEFAULT_PROJECT: '1',
  };

  const child = spawn(
    npmCommand,
    ['--workspace', 'ui', 'run', 'dev:concurrent'],
    { cwd: repoRoot, env, stdio: 'inherit', shell: platform() === 'win32' },
  );

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
