import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileSymlinkOrSkip } from '../test-support/symlink.js';

let watcherModule;
let tempDir;

afterEach(() => {
  watcherModule?.stopPilotDeckConfigWatcher();
  watcherModule = null;
  delete process.env.PILOTDECK_CONFIG_PATH;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('pilotdeck config watcher', () => {
  it.for(['directory', 'file'])('reloads when a config through a %s link is atomically replaced', async (type, context) => {
    tempDir = mkdtempSync(join(tmpdir(), 'pilotdeck-config-watcher-'));
    const linkDir = join(tempDir, 'link');
    const targetDir = join(tempDir, 'managed');
    mkdirSync(targetDir);
    const configPath = join(linkDir, 'pilotdeck.yaml');
    const targetPath = join(targetDir, 'pilotdeck.yaml');
    writeFileSync(targetPath, 'schemaVersion: 1\ncustomEnv:\n  VALUE: before\n', 'utf8');
    if (type === 'file') {
      mkdirSync(linkDir);
      if (!fileSymlinkOrSkip(context, targetPath, configPath)) return;
    } else symlinkSync(targetDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    process.env.PILOTDECK_CONFIG_PATH = configPath;

    const reloadPilotDeckConfig = vi.fn(async () => ({ reloaded: true }));
    vi.doMock('./pilotdeckConfigReloader.js', () => ({ reloadPilotDeckConfig }));
    watcherModule = await import('./pilotdeckConfigWatcher.js');

    const event = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for config event')), 3000);
      void watcherModule.startPilotDeckConfigWatcher({
        onEvent: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
      }).then(() => {
        const replacement = join(targetDir, '.pilotdeck.yaml.external.tmp');
        writeFileSync(replacement, 'schemaVersion: 1\ncustomEnv:\n  VALUE: after\n', 'utf8');
        renameSync(replacement, targetPath);
      }).catch(reject);
    });

    await expect(event).resolves.toMatchObject({
      source: 'watcher',
      config: { customEnv: { VALUE: 'after' } },
    });
    expect(reloadPilotDeckConfig).toHaveBeenCalledOnce();
  });
});
