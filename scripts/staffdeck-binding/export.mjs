import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const [source, destination] = process.argv.slice(2); assert.ok(source && destination, 'export.mjs SOURCE DESTINATION');
assert.notEqual(resolve(source), resolve(destination));
mkdirSync(destination, { recursive: true });
const secrets = new Set();
const sensitive = /^(?:authorization|password|password_hash|api[_-]?key|access_token|refresh_token|token|key|key_digest|key_prefix|secret)$/i;
function collect(value, parent = '') {
  if (Array.isArray(value)) value.forEach(item => collect(item, parent));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => collect(item, key));
  else if (typeof value === 'string' && value.length >= 6 && (sensitive.test(parent) || /TOKEN|SECRET|API_KEY|PASSWORD/.test(parent))) secrets.add(value);
}
for (const file of ['env.json', 'credentials.json', 'pd-owner.json', 'sd-runtime.applied.json']) {
  if (existsSync(join(source, file))) collect(JSON.parse(readFileSync(join(source, file), 'utf8')));
}
const home = join(source, 'home');
if (existsSync(join(home, 'pilotdeck.yaml'))) collect(parseYaml(readFileSync(join(home, 'pilotdeck.yaml'), 'utf8')));
if (existsSync(join(home, 'server-token'))) secrets.add(readFileSync(join(home, 'server-token'), 'utf8').trim());
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : sanitize(item)]));
  if (typeof value !== 'string') return value;
  let output = value;
  for (const secret of secrets) if (secret) output = output.split(secret).join('[REDACTED]');
  return output.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, 'Bearer [REDACTED]')
    .split(source.replace(/^\/var\//, '/private/var/')).join('$QA_ROOT').split(source).join('$QA_ROOT');
}
const files = [];
const sessions = new Set();
function findSessions(value) {
  if (Array.isArray(value)) value.forEach(findSessions);
  else if (value && typeof value === 'object') {
    if (typeof value.sessionKey === 'string') sessions.add(value.sessionKey);
    Object.values(value).forEach(findSessions);
  }
}
for (const file of readdirSync(source).sort()) {
  const result = /^(?:results|.*-result(?:-[a-zA-Z0-9_-]+)?|knowledge-chat|runtime-[ab]-\d|chat-(?:general|sop-private|other-project)-\d(?:-[a-zA-Z0-9_-]+)?|binding-(?:private|approval|switch)-.+)\.json$/.test(file);
  const screenshot = /^(?:desktop-a|mobile-b|browser-(?:failure|upload|published|workflow-mobile|late-response|editor-[a-z-]+-(?:1440|390)|approval-(?:approved|rejected)-(?:1440|390)))\.png$/.test(file);
  if (result) {
    const original = JSON.parse(readFileSync(join(source, file), 'utf8'));
    findSessions(original);
    const value = sanitize(original);
    writeFileSync(join(destination, file), JSON.stringify(value, null, 2) + '\n'); files.push(file);
  } else if (screenshot) { copyFileSync(join(source, file), join(destination, file)); files.push(file); }
}
if (existsSync(join(home, 'staffdeck/project-bindings.json'))) {
  const bindings = JSON.parse(readFileSync(join(home, 'staffdeck/project-bindings.json'), 'utf8'));
  writeFileSync(join(destination, 'pd-binding-store.json'), JSON.stringify(sanitize(JSON.parse(
    readFileSync(join(home, 'staffdeck/project-bindings.json'), 'utf8'))), null, 2) + '\n'); files.push('pd-binding-store.json');
  const states = [];
  for (const binding of bindings.projects) for (const sessionKey of sessions) {
    const path = join(home, 'staffdeck', binding.bindingId, 'state/sessions', Buffer.from(sessionKey).toString('base64url') + '.json');
    if (existsSync(path)) states.push({ bindingId: binding.bindingId, agentId: binding.agentId, sessionKey,
      persisted: JSON.parse(readFileSync(path, 'utf8')) });
  }
  if (states.length) {
    writeFileSync(join(destination, 'persisted-sop-states.json'), JSON.stringify(sanitize(states), null, 2) + '\n');
    files.push('persisted-sop-states.json');
  }
  const legacyStates = [...sessions].flatMap(sessionKey => {
    const path = join(home, 'sop/sessions', Buffer.from(sessionKey).toString('base64url') + '.json');
    return existsSync(path) ? [{ sessionKey, persisted: JSON.parse(readFileSync(path, 'utf8')) }] : [];
  });
  if (legacyStates.length) {
    writeFileSync(join(destination, 'persisted-legacy-sop-states.json'), JSON.stringify(sanitize(legacyStates), null, 2) + '\n');
    files.push('persisted-legacy-sop-states.json');
  }
}
const manifest = { exportedAt: new Date().toISOString(), files, excludes: ['credentials', 'env', 'config', 'databases', 'raw logs', 'model capture'],
  screenshots: 'Only isolated fixture screens; visually reviewed before delivery' };
writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ exported: files.length, destination }));
