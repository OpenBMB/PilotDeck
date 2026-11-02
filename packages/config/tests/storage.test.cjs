const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const { readConfiguration, writeConfiguration, updateConfiguration, resolveConfigHome } = require('../index.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-yaml-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pilotdeck-yaml-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('migrates JSON once, preserving secrets, readable YAML and legacy bytes', t => {
  const root = fixture(t), legacy = path.join(root, 'legacy.json'), file = path.join(root, '新版', 'settings.yaml');
  const original = JSON.stringify({ enabled: true, token: 'secret-not-logged', extra: { nested: [1, 2] } });
  fs.writeFileSync(legacy, original);
  const issues = [];
  const first = readConfiguration(file, { defaults: { enabled: false, token: '' }, legacyPaths: [legacy], onDiagnostic: d => issues.push(d) });
  assert.equal(first.migrated, true);
  assert.equal(first.value.token, 'secret-not-logged');
  assert.deepEqual(YAML.parse(fs.readFileSync(file, 'utf8')), first.value);
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
  const stamp = fs.statSync(file).mtimeMs;
  fs.writeFileSync(legacy, '{"enabled":false}');
  assert.equal(readConfiguration(file, { defaults: { enabled: false, token: '' }, legacyPaths: [legacy] }).value.enabled, true);
  assert.equal(fs.statSync(file).mtimeMs, stamp);
  assert.doesNotMatch(JSON.stringify(issues), /secret-not-logged/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('repairs invalid fields without losing healthy siblings and backs up originals', t => {
  const root = fixture(t), file = path.join(root, 'settings.yaml');
  const raw = 'enabled: "false"\nlimits:\n  count: wrong\n  name: healthy\nsecret: preserved\n';
  fs.writeFileSync(file, raw);
  const result = readConfiguration(file, { defaults: { enabled: false, limits: { count: 5, name: '' } }, onDiagnostic: () => {} });
  assert.deepEqual(result.value, { enabled: false, limits: { count: 5, name: 'healthy' }, secret: 'preserved' });
  assert.deepEqual(result.diagnostics.map(d => d.field), ['enabled', 'limits.count']);
  const backups = path.join(root, 'backups', 'configuration');
  assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0]), 'utf8'), raw);
});

test('malformed YAML, aliases and bad roots recover without throwing', t => {
  const root = fixture(t), file = path.join(root, 'settings.yaml');
  for (const raw of ['enabled: true\nbroken: [', '[]', '*missing', 'enabled: true\nenabled: false']) {
    fs.writeFileSync(file, raw);
    const result = readConfiguration(file, { defaults: { enabled: false, count: 3 }, onDiagnostic: () => {} });
    assert.equal(typeof result.value.enabled, 'boolean');
    assert.equal(result.value.count, 3);
    assert.ok(result.diagnostics.length);
    assert.doesNotThrow(() => YAML.parse(fs.readFileSync(file, 'utf8')));
  }
});

test('unwritable storage does not prevent reading defaults, but writes report failure', t => {
  const root = fixture(t), blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'file');
  const file = path.join(blocker, 'settings.yaml');
  const result = readConfiguration(file, { defaults: { enabled: false }, onDiagnostic: () => {} });
  assert.deepEqual(result.value, { enabled: false });
  assert.ok(result.diagnostics.some(d => d.code === 'PD_CONFIG_WRITE'));
  assert.throws(() => writeConfiguration(file, { enabled: true }));
});

test('concurrent process updates preserve every accepted write', { timeout: 30_000 }, async t => {
  const root = fixture(t), file = path.join(root, 'counter.yaml');
  writeConfiguration(file, { count: 0 });
  const modulePath = require.resolve('../index.cjs');
  const script = `const {updateConfiguration}=require(${JSON.stringify(modulePath)});for(let i=0;i<15;i++)updateConfiguration(${JSON.stringify(file)},v=>({count:v.count+1}),{defaults:{count:0}});`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(readConfiguration(file, { create: false }).value.count, 60);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.deepEqual(fs.readdirSync(root), ['counter.yaml']);
});

test('home override expands tilde and update returns persisted values', t => {
  const root = fixture(t), file = path.join(root, 'prefs.yaml');
  assert.equal(resolveConfigHome({ PILOT_HOME: '~/.pilotdeck-test' }), path.join(os.homedir(), '.pilotdeck-test'));
  assert.deepEqual(updateConfiguration(file, value => ({ ...value, name: 'saved' }), { defaults: { enabled: false } }), { enabled: false, name: 'saved' });
  assert.equal(readConfiguration(file).value.name, 'saved');
});

test('future schema versions are readable but never automatically rewritten or updated', t => {
  const root = fixture(t), file = path.join(root, 'settings.yaml');
  const raw = 'schemaVersion: 9\nenabled: future-value\nsecret: retained\n';
  fs.writeFileSync(file, raw);
  const options = { defaults: { schemaVersion: 1, enabled: false }, onDiagnostic: () => {} };
  assert.equal(readConfiguration(file, options).value.enabled, false);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.throws(() => updateConfiguration(file, v => ({ ...v, enabled: true }), options), { code: 'PD_CONFIG_VERSION' });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
