import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPluginsConfig, getPluginsDir, savePluginsConfig } from './plugin-loader.js';

let tempHome;
const originalPilotHome = process.env.PILOT_HOME;

afterEach(() => {
  if (originalPilotHome === undefined) {
    delete process.env.PILOT_HOME;
  } else {
    process.env.PILOT_HOME = originalPilotHome;
  }
  if (tempHome) {
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe('plugin-loader PilotDeck home resolution', () => {
  it('stores plugin paths under PILOT_HOME', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-plugin-home-'));
    process.env.PILOT_HOME = tempHome;

    expect(getPluginsDir()).toBe(path.join(tempHome, 'plugins'));

    const config = { enabled: ['example-plugin'] };
    savePluginsConfig(config);

    expect(fs.existsSync(path.join(tempHome, 'plugins.json'))).toBe(true);
    expect(getPluginsConfig()).toEqual(config);
  });
});
