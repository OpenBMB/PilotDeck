const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readConfiguration, restrictConfigurationDirectory } = require('../index.cjs');
test('cyclic YAML fields and oversized files cannot crash configuration loading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-limits-'));
  try {
    const file = path.join(dir, 'settings.yaml');
    fs.writeFileSync(file, 'healthy: true\ncycle: &node\n  child: *node\n');
    const recovered = readConfiguration(file, { defaults: { healthy: false }, onDiagnostic: () => {} });
    assert.equal(recovered.value.healthy, true); assert.ok(recovered.diagnostics.length);
    fs.writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    assert.deepEqual(readConfiguration(file, { defaults: { healthy: false }, onDiagnostic: () => {} }).value, { healthy: false });
    assert.ok(fs.statSync(file).size > 8 * 1024 * 1024);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('private directory permissions protect newly written credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-acl-'));
  try {
    restrictConfigurationDirectory(dir); restrictConfigurationDirectory(dir);
    if (process.platform === 'win32') {
      const source = '$acl=[IO.Directory]::GetAccessControl($env:PD_TASK_PRIVATE_DIRECTORY); if (!$acl.AreAccessRulesProtected) {exit 2}; $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); foreach($rule in $acl.Access){if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){exit 3}}';
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, PD_TASK_PRIVATE_DIRECTORY: dir } });
    } else assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
