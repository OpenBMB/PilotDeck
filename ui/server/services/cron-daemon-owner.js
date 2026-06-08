import crypto from 'crypto';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export const CRON_DAEMON_OWNER_KIND = 'pilotdeck-server';
export const CRON_DAEMON_OWNER_KIND_ENV = 'PILOTDECK_CRON_DAEMON_OWNER_KIND';
export const CRON_DAEMON_OWNER_TOKEN_ENV = 'PILOTDECK_CRON_DAEMON_OWNER_TOKEN';
export const CRON_DAEMON_OWNER_PROCESS_PID_ENV = 'PILOTDECK_CRON_DAEMON_OWNER_PROCESS_PID';

function getPilotDeckConfigHomeDir() {
  return process.env.PILOTDECK_CONFIG_DIR || process.env.PILOT_HOME || path.join(os.homedir(), '.pilotdeck');
}

function getCronDaemonOwnerPath() {
  return path.join(getPilotDeckConfigHomeDir(), 'cron-daemon', 'owner.json');
}

function getCronDaemonSocketPath() {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\pilotdeck-cron-daemon';
  }
  return path.join(getPilotDeckConfigHomeDir(), 'cron-daemon.sock');
}

async function readCronDaemonOwner() {
  try {
    const raw = await fs.readFile(getCronDaemonOwnerPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function isCurrentProcessCronDaemonOwner(owner) {
  return Boolean(
    owner &&
    owner.kind === process.env[CRON_DAEMON_OWNER_KIND_ENV] &&
    owner.token === process.env[CRON_DAEMON_OWNER_TOKEN_ENV]
  );
}

function sendCronDaemonRequest(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getCronDaemonSocketPath());
    let settled = false;
    let buffer = '';

    const finalize = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };

    socket.setTimeout(1000, () => {
      finalize(reject, new Error('Timed out waiting for Cron daemon response'));
    });

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      try {
        finalize(resolve, JSON.parse(line));
      } catch (error) {
        finalize(reject, error);
      }
    });

    socket.on('error', (error) => {
      finalize(reject, error);
    });
  });
}

export async function shutdownOwnedCronDaemon() {
  const owner = await readCronDaemonOwner();
  if (!isCurrentProcessCronDaemonOwner(owner)) {
    return false;
  }

  try {
    const response = await sendCronDaemonRequest({ type: 'shutdown' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

export async function _readCronDaemonOwnerForTest() {
  return await readCronDaemonOwner();
}

export {
  sendCronDaemonRequest
};
