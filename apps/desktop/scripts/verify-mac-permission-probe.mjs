import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveMacRuntime, MAC_APP_NAME } from '../../../scripts/lib/mac-computer-use.mjs';
import { driverPin } from '../../../scripts/prepare-computer-use.mjs';
import { probeMacPermissions } from '../../../ui/server/services/macComputerUsePermissions.js';

// Run against the built package, outside its enclosing .app, in an interactive
// macOS login session. This is a read-only probe and never requests consent.
assert.equal(process.platform, 'darwin');
assert.ok(process.argv[2], 'Pass the cua-driver resource directory');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cu-native-check-'));
try {
  const runtime = await resolveMacRuntime({
    binary: path.join(path.resolve(process.argv[2]), MAC_APP_NAME, 'Contents/MacOS/cua-driver'),
    version: driverPin.version, root: directory, installedApps: [],
  });
  assert.equal(runtime.probeSupported, true, 'Built helper is missing the native permission probe');
  const permissions = await probeMacPermissions({ runtime, execute: promisify(execFile), env: process.env });
  assert.equal(typeof permissions.accessibility, 'boolean');
  assert.equal(typeof permissions.screenRecording, 'boolean');
  console.log(`Native permission probe passed: ${runtime.bundleId}`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
