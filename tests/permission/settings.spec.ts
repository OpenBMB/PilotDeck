import assert from "node:assert/strict";
import test from "node:test";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  normalizePermissionSettings,
  permissionSettingsToRuleSet,
  readPermissionSettings,
  writePermissionSettings,
  getPermissionSettingsPath,
} from "../../src/permission/settings.js";

test("normalizes and maps explicit confirmation rules", () => {
  const settings = normalizePermissionSettings({
    allowedTools: ["Read"],
    askTools: ["Bash(rm:*)", "Bash(rm:*)"],
    disallowedTools: ["Write"],
    skipPermissions: false,
  });

  assert.deepEqual(settings.askTools, ["bash:rm:*"]);
  assert.deepEqual(permissionSettingsToRuleSet(settings), {
    allow: [{ source: "user", behavior: "allow", toolName: "read_file", pattern: undefined }],
    ask: [{ source: "user", behavior: "ask", toolName: "bash", pattern: "rm:*" }],
    deny: [{ source: "user", behavior: "deny", toolName: "write_file", pattern: undefined }],
  });
});

test('legacy permissions migrate once to YAML and invalid booleans remain restrictive', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-permission-migration-'));
  t.after(() => { assert.equal(path.dirname(home), path.resolve(os.tmpdir())); fs.rmSync(home, { recursive: true, force: true }); });
  const env = { PILOT_HOME: home };
  fs.writeFileSync(path.join(home, 'permissions.json'), JSON.stringify({ allowedTools: ['Read'], skipPermissions: 'false' }));
  assert.equal(readPermissionSettings(env).skipPermissions, false);
  assert.deepEqual(readPermissionSettings(env).allowedTools, ['read_file']);
  const file = getPermissionSettingsPath(env);
  assert.ok(file.endsWith('.yaml'));
  writePermissionSettings({ askTools: ['Bash(rm:*)'] }, env);
  assert.deepEqual(parseYaml(fs.readFileSync(file, 'utf8')).askTools, ['bash:rm:*']);
  fs.writeFileSync(path.join(home, 'permissions.json'), '{}');
  assert.deepEqual(readPermissionSettings(env).allowedTools, ['read_file']);
});

test("keeps older permission files compatible when askTools is absent", () => {
  const settings = normalizePermissionSettings({
    allowedTools: ["read_file"],
    disallowedTools: ["write_file"],
  });

  assert.deepEqual(settings.askTools, []);
});
