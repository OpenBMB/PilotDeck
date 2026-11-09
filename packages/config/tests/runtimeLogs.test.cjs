const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeLogWriter, normalizeLogRetentionDays, setRuntimeLogRetention } = require('../runtimeLogs.cjs');

test('unsupported retention values fall back to one week', () => {
  for (const value of [undefined, null, '30', 0, -1, 8, NaN, {}, []]) assert.equal(normalizeLogRetentionDays(value), 7);
  for (const value of [1,3,7,30,90]) assert.equal(normalizeLogRetentionDays(value), value);
});

test('daily rotation, immediate retention changes and safe cleanup of crash reports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-log-retention-'));
  let clock = new Date('2026-11-01T12:00:00Z');
  const log = path.join(directory, 'runtime.log');
  const writer = createRuntimeLogWriter(log, { now: () => clock, retentionDays: 7 });
  try {
    assert.equal(writer.write('first day\n'), true);
    clock = new Date('2026-11-02T12:00:00Z'); writer.write('second day\n');
    assert.match(fs.readFileSync(log, 'utf8'), /^second day/);
    assert.equal(fs.readdirSync(directory).filter(file => file.startsWith('runtime-')).length, 1);
    fs.writeFileSync(path.join(directory, 'user-notes.log'), 'leave alone');
    fs.writeFileSync(path.join(directory, 'runtime-2000-01-01-not-an-owned-file.log'), 'leave alone');
    const reports = path.join(directory, 'diagnostics'); fs.mkdirSync(reports);
    const report = path.join(reports, 'gateway-1234abcd.json'); fs.writeFileSync(report, '{}');
    fs.utimesSync(report, new Date('2026-10-01'), new Date('2026-10-01'));
    fs.writeFileSync(path.join(reports, 'user-report.json'), '{}');
    writer.setRetentionDays(1);
    assert.equal(fs.readdirSync(directory).filter(file => /^runtime-2026/.test(file)).length, 0);
    assert.equal(fs.existsSync(report), false);
    assert.equal(fs.existsSync(path.join(reports, 'user-report.json')), true);
    clock = new Date('2026-11-03T12:00:00Z'); writer.write('third day\n');
    assert.equal(fs.readFileSync(log, 'utf8'), 'third day\n');
    assert.equal(fs.readdirSync(directory).filter(file => /^runtime-2026/.test(file)).length, 0);
    assert.equal(fs.readFileSync(path.join(directory, 'user-notes.log'), 'utf8'), 'leave alone');
  } finally { writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('existing daily logs expire and all active writers follow a preference change', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-log-restart-'));
  const log = path.join(directory, 'runtime.log');
  fs.writeFileSync(log, 'old run\n'); fs.utimesSync(log, new Date('2020-01-01'), new Date('2020-01-01'));
  const first = createRuntimeLogWriter(log), second = createRuntimeLogWriter(path.join(directory, 'renderer.log'));
  try {
    first.write('new run\n'); second.write('renderer\n');
    assert.equal(fs.readFileSync(log, 'utf8'), 'new run\n');
    assert.equal(fs.readdirSync(directory).some(file => /^runtime-2020/.test(file)), false);
    const old = path.join(directory, 'renderer-2000-01-01-1234abcd.log'); fs.writeFileSync(old, 'old');
    assert.equal(setRuntimeLogRetention(3), 3);
    assert.equal(fs.existsSync(old), false);
  } finally { first.close(); second.close(); setRuntimeLogRetention(7); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an unusable log destination cannot throw or crash startup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-log-blocked-'));
  const blocked = path.join(directory, 'blocked'); fs.writeFileSync(blocked, 'file');
  const writer = createRuntimeLogWriter(path.join(blocked, 'runtime.log'));
  try { assert.equal(writer.write('message'), false); writer.setRetentionDays(90); }
  finally { writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
