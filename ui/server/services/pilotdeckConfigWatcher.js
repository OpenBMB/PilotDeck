import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import {
  getPilotDeckConfigPath,
  readPilotDeckConfigFile,
  serializePilotDeckConfigResponse,
} from './pilotdeckConfig.js';
import { reloadPilotDeckConfig } from './pilotdeckConfigReloader.js';

// Watches ~/.pilotdeck/pilotdeck.yaml for external edits (vim, Cursor, other IDEs)
// and triggers the same reload path the UI uses on save, so *any* edit takes
// effect live. After the UI atomically commits its own write it calls
// suppressNextWatchEvent() before fs.watch can dispatch the resulting event,
// avoiding a redundant second reload without hiding failed/conflicting saves.

let watchers = [];
let debounceTimer = null;
let suppressCount = 0;
let lastSignature = '';
let onEventHandler = null;

function signatureForFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

export function suppressNextWatchEvent() {
  suppressCount += 1;
  setTimeout(() => {
    suppressCount = Math.max(0, suppressCount - 1);
  }, 1500);
}

async function handleChange(configPath) {
  if (suppressCount > 0) return;
  const signature = signatureForFile(configPath);
  if (signature === lastSignature) return;
  lastSignature = signature;

  let record;
  try {
    record = readPilotDeckConfigFile();
  } catch (error) {
    onEventHandler?.({
      source: 'watcher',
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
      validation: {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (record.parseError) {
    onEventHandler?.({
      source: 'watcher',
      ...serializePilotDeckConfigResponse(record),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const response = serializePilotDeckConfigResponse(record);

  if (!response.validation.valid) {
    onEventHandler?.({
      source: 'watcher',
      ...response,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  let reloadResult = null;
  try {
    reloadResult = await reloadPilotDeckConfig(record.config);
  } catch (error) {
    onEventHandler?.({
      source: 'watcher',
      ...response,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  onEventHandler?.({
    source: 'watcher',
    ...serializePilotDeckConfigResponse(record, reloadResult),
    timestamp: new Date().toISOString(),
  });
}

function closeWatchers() {
  for (const activeWatcher of watchers) {
    try {
      activeWatcher.close();
    } catch {
      // noop
    }
  }
  watchers = [];
}

async function resolveWatchedConfigPath(configPath) {
  try {
    return await fsPromises.realpath(configPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      const stat = await fsPromises.lstat(configPath);
      if (stat.isSymbolicLink()) {
        const target = await fsPromises.readlink(configPath);
        return path.resolve(path.dirname(configPath), target);
      }
    } catch (linkError) {
      if (linkError?.code !== 'ENOENT') throw linkError;
    }
    return path.resolve(configPath);
  }
}

async function installWatchers(configPath) {
  const resolvedPath = await resolveWatchedConfigPath(configPath);
  const paths = [...new Set([path.resolve(configPath), resolvedPath])];
  const nextWatchers = [];

  try {
    for (const watchedPath of paths) {
      const watchedDir = path.dirname(watchedPath);
      const watchedBase = path.basename(watchedPath);
      const activeWatcher = fs.watch(watchedDir, { persistent: false }, (_eventType, filename) => {
        if (filename && filename !== watchedBase) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void installWatchers(configPath)
            .then(() => handleChange(configPath))
            .catch((error) => {
              console.warn('[pilotdeck-config-watcher] failed to refresh watcher:', error?.message || error);
            });
        }, 250);
      });
      activeWatcher.on('error', (error) => {
        console.warn('[pilotdeck-config-watcher] watch error:', error?.message || error);
      });
      nextWatchers.push(activeWatcher);
    }
  } catch (error) {
    for (const activeWatcher of nextWatchers) activeWatcher.close();
    throw error;
  }

  closeWatchers();
  watchers = nextWatchers;
  console.log(`[pilotdeck-config-watcher] watching ${paths.join(', ')}`);
}

export async function startPilotDeckConfigWatcher({ onEvent } = {}) {
  stopPilotDeckConfigWatcher();
  onEventHandler = typeof onEvent === 'function' ? onEvent : null;

  const configPath = getPilotDeckConfigPath();
  const configDir = path.dirname(configPath);
  try {
    await fsPromises.mkdir(configDir, { recursive: true });
  } catch (error) {
    console.warn('[pilotdeck-config-watcher] failed to ensure config dir:', error?.message || error);
    return;
  }

  lastSignature = signatureForFile(configPath);

  try {
    await installWatchers(configPath);
  } catch (error) {
    console.warn('[pilotdeck-config-watcher] failed to start:', error?.message || error);
  }
}

export function stopPilotDeckConfigWatcher() {
  closeWatchers();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
