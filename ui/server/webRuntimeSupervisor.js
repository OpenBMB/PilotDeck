#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getRestartRequestFile,
  RESTART_EXIT_CODE,
} from './services/updateRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_ROOT = path.resolve(__dirname, '..');

export function normalizeSupervisorMode(value) {
  return value === 'dev' ? 'dev' : 'start-built';
}

export function getRuntimeCommands(mode, uiRoot = UI_ROOT) {
  const normalizedMode = normalizeSupervisorMode(mode);
  const repoRoot = path.resolve(uiRoot, '..');
  const commands = [
    {
      name: 'server',
      command: process.execPath,
      args: ['--import', 'tsx', path.join(uiRoot, 'server', 'index.js')],
      cwd: uiRoot,
      ipc: true,
      critical: true,
    },
  ];
  if (normalizedMode === 'dev') {
    commands.push({
      name: 'client',
      command: process.execPath,
      args: [path.join(uiRoot, 'node_modules', 'vite', 'bin', 'vite.js')],
      cwd: uiRoot,
      ipc: false,
      critical: true,
    });
  }
  commands.push({
    name: 'gateway',
    command: process.execPath,
    args: ['--import', 'tsx', path.join(repoRoot, 'src', 'cli', 'pilotdeck.ts'), 'server'],
    cwd: repoRoot,
    ipc: false,
    critical: false,
  });
  return commands;
}

export function waitForPort(port, host = '127.0.0.1', timeoutMs = 90_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

export function createRuntimeSupervisor({
  mode,
  env = process.env,
  spawnImpl = spawn,
  waitForPortImpl = waitForPort,
  exists = existsSync,
  unlink = unlinkSync,
  cwd = UI_ROOT,
  requestFile = getRestartRequestFile({ env: { ...env, PILOTDECK_RESTART_MODE: mode } }),
  platform = process.platform,
  log = console.log,
  error = console.error,
  exit = process.exit,
  processLike = process,
} = {}) {
  const normalizedMode = normalizeSupervisorMode(mode);
  const commandSpecs = getRuntimeCommands(normalizedMode, cwd);
  const specByName = new Map(commandSpecs.map((spec) => [spec.name, spec]));
  const children = new Map();
  const gatewayPort = Number.parseInt(env.PILOTDECK_GATEWAY_PORT || '18789', 10);
  const runtimeEnv = {
    ...env,
    PILOTDECK_RESTART_MODE: normalizedMode,
    PILOTDECK_RESTART_SUPERVISOR: '1',
    PILOTDECK_RESTART_REQUEST_FILE: requestFile,
    PILOTDECK_RUNTIME_SUPERVISED: '1',
  };
  let configuration = null;
  let stopping = false;
  let handlingCriticalExit = false;

  const sendGatewayState = (state, gatewayError) => {
    const server = children.get('server');
    if (!server || typeof server.send !== 'function' || server.connected === false) return;
    try {
      server.send({
        type: 'pilotdeck:gateway-state',
        state,
        ...(gatewayError ? { error: gatewayError } : {}),
      });
    } catch (sendError) {
      error(`[runtime-supervisor] Failed to publish Gateway state: ${sendError.message}`);
    }
  };

  const spawnProcess = (name) => {
    const spec = specByName.get(name);
    if (!spec) throw new Error(`Unknown runtime process: ${name}`);
    const child = spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: spec.ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      env: runtimeEnv,
      windowsHide: platform === 'win32',
    });
    children.set(name, child);
    return { child, spec };
  };

  const stopChild = (name, signal = 'SIGTERM') => {
    const child = children.get(name);
    if (!child) return;
    children.delete(name);
    if (!child.killed && child.exitCode == null) child.kill(signal);
  };

  const stopAll = (signal = 'SIGTERM') => {
    for (const name of [...children.keys()].reverse()) stopChild(name, signal);
  };

  const startGateway = () => {
    if (configuration?.state !== 'ready' || children.has('gateway') || stopping) return;
    sendGatewayState('starting');
    const { child } = spawnProcess('gateway');
    let reportedFailure = false;

    child.once('error', (spawnError) => {
      if (children.get('gateway') !== child) return;
      children.delete('gateway');
      reportedFailure = true;
      const detail = `Failed to start Gateway: ${spawnError.message}`;
      error(`[runtime-supervisor] ${detail}`);
      sendGatewayState('error', detail);
    });
    child.once('close', (code, signal) => {
      if (children.get('gateway') !== child) return;
      children.delete('gateway');
      if (stopping || reportedFailure) return;
      const detail = `Gateway exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      error(`[runtime-supervisor] ${detail}`);
      sendGatewayState('error', detail);
    });

    waitForPortImpl(gatewayPort, '127.0.0.1', 90_000)
      .then(() => {
        if (children.get('gateway') === child && !reportedFailure) {
          log(`[runtime-supervisor] Gateway ready on 127.0.0.1:${gatewayPort}`);
          sendGatewayState('ready');
        }
      })
      .catch((waitError) => {
        if (children.get('gateway') !== child) return;
        children.delete('gateway');
        reportedFailure = true;
        child.kill('SIGTERM');
        const detail = waitError instanceof Error ? waitError.message : String(waitError);
        error(`[runtime-supervisor] Gateway failed readiness check: ${detail}`);
        sendGatewayState('error', detail);
      });
  };

  const handleServerMessage = (message) => {
    if (message?.type === 'pilotdeck:configuration-state' && message.configuration) {
      configuration = message.configuration;
      if (configuration.state === 'ready') {
        startGateway();
      } else {
        stopChild('gateway');
        sendGatewayState('stopped');
      }
      return;
    }
    if (message?.type === 'pilotdeck:retry-gateway' && configuration?.state === 'ready') {
      startGateway();
    }
  };

  const handleCriticalExit = async (code, signal) => {
    if (handlingCriticalExit) return;
    handlingCriticalExit = true;
    stopping = true;
    stopAll();

    if (exists(requestFile)) {
      try {
        unlink(requestFile);
      } catch (unlinkError) {
        error(`[runtime-supervisor] Failed to consume restart request: ${unlinkError.message}`);
        exit(1);
        return;
      }
      log(`[runtime-supervisor] Restart requested; relaunching ${normalizedMode} runtime...`);
      handlingCriticalExit = false;
      startRuntime();
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      error('[runtime-supervisor] Restart exit code received without a restart request file.');
    }
    exit(typeof code === 'number' ? code : (signal ? 1 : 0));
  };

  const startRuntime = () => {
    stopping = false;
    configuration = null;
    const { child: server } = spawnProcess('server');
    server.on('message', handleServerMessage);
    if (normalizedMode === 'dev') spawnProcess('client');

    for (const name of normalizedMode === 'dev' ? ['server', 'client'] : ['server']) {
      const child = children.get(name);
      child.once('error', (spawnError) => {
        if (children.get(name) !== child || handlingCriticalExit) return;
        error(`[runtime-supervisor] Failed to start ${name}: ${spawnError.message}`);
        void handleCriticalExit(1, null);
      });
      child.once('close', (code, signal) => {
        if (children.get(name) !== child || stopping || handlingCriticalExit) return;
        children.delete(name);
        void handleCriticalExit(code, signal);
      });
    }
  };

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    stopAll(signal);
    exit(signal === 'SIGINT' ? 0 : 1);
  };

  const run = () => {
    processLike.on('SIGINT', () => stop('SIGINT'));
    processLike.on('SIGTERM', () => stop('SIGTERM'));
    startRuntime();
  };

  return {
    run,
    stop,
    startGateway,
    get child() {
      return children.get('server') ?? null;
    },
    get children() {
      return new Map(children);
    },
    requestFile,
    commandSpecs,
  };
}

export function runSupervisor(argv = process.argv.slice(2)) {
  const mode = normalizeSupervisorMode(argv[0]);
  const requestFile = getRestartRequestFile({
    env: { ...process.env, PILOTDECK_RESTART_MODE: mode },
    pid: process.pid,
    tmpdir: () => path.join(os.tmpdir(), 'pilotdeck'),
  });
  createRuntimeSupervisor({ mode, requestFile }).run();
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runSupervisor();
}
