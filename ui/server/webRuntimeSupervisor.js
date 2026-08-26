#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
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
const CONCURRENTLY_BIN = path.join(UI_ROOT, 'node_modules', 'concurrently', 'dist', 'bin', 'concurrently.js');

export function normalizeSupervisorMode(value) {
  return value === 'dev' ? 'dev' : 'start-built';
}

export function getRuntimeArgs(mode) {
  return normalizeSupervisorMode(mode) === 'dev'
    ? [
        CONCURRENTLY_BIN,
        '--kill-others-on-fail',
        '--names',
        'gateway,server,client',
        'npm:dev:gateway',
        'npm:dev:server',
        'npm:dev:client',
      ]
    : [
        CONCURRENTLY_BIN,
        '--kill-others-on-fail',
        '--names',
        'gateway,server',
        'npm:gateway',
        'npm:server',
      ];
}

export function getRuntimeCommand() {
  return process.execPath;
}

export function getSupervisorArgs(mode) {
  return [__filename, normalizeSupervisorMode(mode)];
}

export function createRuntimeSupervisor({
  mode,
  env = process.env,
  spawnImpl = spawn,
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
  const runtimeArgs = getRuntimeArgs(normalizedMode);
  let child = null;
  let stopping = false;
  let pendingSignal = null;

  const startChild = () => {
    child = spawnImpl(getRuntimeCommand(), runtimeArgs, {
      cwd,
      stdio: 'inherit',
      env: {
        ...env,
        PILOTDECK_RESTART_MODE: normalizedMode,
        PILOTDECK_RESTART_SUPERVISOR: '1',
        PILOTDECK_RESTART_REQUEST_FILE: requestFile,
      },
      windowsHide: platform === 'win32',
    });
    return child;
  };

  const startSupervisedChild = () => {
    const nextChild = startChild();
    let settled = false;
    const settle = (callback, ...args) => {
      if (settled) return;
      settled = true;
      callback(...args);
    };
    nextChild.once('error', (spawnError) => {
      error(`[restart-supervisor] Failed to start runtime: ${spawnError.message}`);
      settle(exit, 1);
    });
    nextChild.once('close', (code, signal) => {
      settle(handleClose, code, signal);
    });
    return nextChild;
  };

  const stop = (signal) => {
    stopping = true;
    pendingSignal = signal;
    if (child && !child.killed) {
      child.kill(signal);
      return;
    }
    exit(signal === 'SIGINT' ? 0 : 1);
  };

  const handleClose = (code, signal) => {
    if (stopping) {
      exit(pendingSignal === 'SIGINT' ? 0 : (typeof code === 'number' ? code : 1));
      return;
    }

    if (exists(requestFile)) {
      try {
        unlink(requestFile);
      } catch (unlinkError) {
        error(`[restart-supervisor] Failed to consume restart request: ${unlinkError.message}`);
        exit(1);
        return;
      }
      log(`[restart-supervisor] Restart requested; relaunching ${normalizedMode} runtime...`);
      startSupervisedChild();
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      error('[restart-supervisor] Restart exit code received without a restart request file.');
    }
    exit(typeof code === 'number' ? code : (signal ? 1 : 0));
  };

  const run = () => {
    processLike.on('SIGINT', () => stop('SIGINT'));
    processLike.on('SIGTERM', () => stop('SIGTERM'));
    startSupervisedChild();
  };

  return {
    run,
    stop,
    get child() {
      return child;
    },
    requestFile,
    runtimeArgs,
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
